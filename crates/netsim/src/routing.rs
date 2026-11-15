//! Routing inside one network: distance vector and link state.
//!
//! The network is a graph of routers joined by links with positive costs.
//! Links can change cost, fail or come back at given times.
//!
//! Distance vector is the Bellman-Ford exchange used by RIP. Every router
//! keeps an estimate of its cost to every destination and the neighbour it
//! would forward through, and tells its neighbours whenever what it would
//! tell them changes. A message takes a fixed delay, plus seeded jitter if
//! asked for. With no jitter every message sent at one instant arrives at the
//! next, so the exchange runs in synchronous rounds. Messages on one link
//! arrive in the order they were sent. Costs at or above `infinity` mean
//! "unreachable", as 16 does in RIP. Poisoned reverse is an option.
//!
//! Link state is Dijkstra's algorithm on the whole graph, as every OSPF or
//! IS-IS router runs once flooding has given it the full map. The model
//! computes it for every source and every period between two link changes,
//! so the page can step through it and check the distance vectors against it.
//!
//! The algorithms are written in lettered steps; the trace names the step
//! behind each event and the page highlights it in this source.

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

/// A link between routers `a` and `b` (indices into `nodes`), used both ways.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Link {
    pub a: usize,
    pub b: usize,
    pub cost: u32,
}

/// At `at_us` the link between `a` and `b` gets cost `cost`; `None` takes it
/// down. A change to a pair with no link adds one.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Change {
    pub at_us: u64,
    pub a: usize,
    pub b: usize,
    pub cost: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Params {
    pub nodes: Vec<String>,
    pub links: Vec<Link>,
    pub changes: Vec<Change>,
    /// Report routes through a neighbour back to it as unreachable.
    pub poison: bool,
    /// Distances at or above this are unreachable.
    pub infinity: u32,
    /// Time for one message to cross a link.
    pub delay_us: u64,
    /// Extra delay, uniform on 0..=jitter_us, drawn per message.
    pub jitter_us: u64,
    pub seed: u64,
}

/// One distance-vector message.
#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub t_send: u64,
    pub t_arrive: u64,
    /// The vector as sent, one entry per destination; `infinity` is unreachable.
    pub vector: Vec<u32>,
    /// Destinations reported as unreachable only because of poisoned reverse.
    pub poisoned: Vec<usize>,
    /// The link was down when the message reached its end.
    pub lost: bool,
}

/// A row of the trace: what one router did at one moment, and every table after it.
#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: u64,
    /// The router that acted, or -1 for a change to the network.
    pub node: i32,
    pub step: &'static str,
    pub text: String,
    /// The message that arrived or was lost, if any.
    pub message: Option<usize>,
    /// `dist[x][y]`: router x's estimate of its cost to y.
    pub dist: Vec<Vec<u32>>,
    /// `hop[x][y]`: the neighbour x forwards through towards y, or -1.
    pub hop: Vec<Vec<i32>>,
    /// The cells `[x, y]` this event changed.
    pub changed: Vec<[usize; 2]>,
}

/// One step of Dijkstra's algorithm from one source.
#[derive(Serialize, Clone, Debug)]
pub struct DijkstraStep {
    /// The router added to the finished set N' at this step.
    pub added: usize,
    /// D(v) after the step; `infinity` where no path is known yet.
    pub d: Vec<u32>,
    /// p(v), the router before v on the best path known, or -1.
    pub p: Vec<i32>,
}

/// The network between two changes, with link-state answers for it.
#[derive(Serialize, Clone, Debug)]
pub struct Epoch {
    pub t: u64,
    /// `cost[a][b]`, or -1 where there is no working link.
    pub cost: Vec<Vec<i64>>,
    /// `dijkstra[s]`: every step of Dijkstra's algorithm from source s.
    pub dijkstra: Vec<Vec<DijkstraStep>>,
    /// The true shortest distances, capped at `infinity`.
    pub shortest: Vec<Vec<u32>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Totals {
    pub messages: usize,
    pub lost: usize,
    /// When a table last changed.
    pub last_change_us: u64,
    /// The final tables equal the true shortest distances.
    pub converged: bool,
    /// The run hit the event limit before the exchange went quiet.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Run {
    pub events: Vec<Event>,
    pub messages: Vec<Message>,
    pub epochs: Vec<Epoch>,
    pub totals: Totals,
}

/// Enough for the longest count to infinity the page allows.
pub const MAX_EVENTS: usize = 6000;

const NONE: usize = usize::MAX;

enum Ev {
    Change(Change),
    Arrive(usize),
}

struct Router {
    dist: Vec<u32>,
    hop: Vec<usize>,
    /// The last vector heard from each neighbour.
    heard: Vec<Option<Vec<u32>>>,
    /// The last vector sent to each neighbour.
    told: Vec<Option<Vec<u32>>>,
}

struct Sim<'a> {
    p: &'a Params,
    n: usize,
    rng: Rng,
    queue: Queue<Ev>,
    cost: Vec<Vec<Option<u32>>>,
    routers: Vec<Router>,
    /// The last arrival time on each directed link, to keep links in order.
    last_arrival: Vec<Vec<u64>>,
    messages: Vec<Message>,
    events: Vec<Event>,
    last_change_us: u64,
}

impl Sim<'_> {
    fn name(&self, i: usize) -> &str {
        &self.p.nodes[i]
    }

    fn show(&self, d: u32) -> String {
        if d >= self.p.infinity {
            "∞".into()
        } else {
            d.to_string()
        }
    }

    fn record(
        &mut self,
        t: u64,
        node: i32,
        step: &'static str,
        text: String,
        message: Option<usize>,
        changed: Vec<[usize; 2]>,
    ) {
        let dist = self.routers.iter().map(|r| r.dist.clone()).collect();
        let hop = self
            .routers
            .iter()
            .map(|r| {
                r.hop
                    .iter()
                    .map(|&h| if h == NONE { -1 } else { h as i32 })
                    .collect()
            })
            .collect();
        if !changed.is_empty() {
            self.last_change_us = t;
        }
        self.events.push(Event {
            t,
            node,
            step,
            text,
            message,
            dist,
            hop,
            changed,
        });
    }

    /// D2. [Recompute.] The Bellman-Ford equation: for every destination y,
    /// D_x(y) = min over neighbours v of c(x, v) + D_v(y), where D_v is the
    /// last vector heard from v (and D_v(v) = 0 even before v has spoken).
    /// Anything at or above infinity is unreachable. A tie keeps the current
    /// next hop if it is among the best, so routes do not flap; otherwise the
    /// lowest-numbered neighbour wins. Returns the destinations that changed.
    fn recompute(&mut self, x: usize) -> Vec<(usize, u32, usize)> {
        let inf = self.p.infinity;
        let mut changes = Vec::new();
        for y in 0..self.n {
            let (best, via) = if y == x {
                (0, x)
            } else {
                let mut best = inf;
                let mut via = NONE;
                for v in 0..self.n {
                    let Some(c) = self.cost[x][v] else { continue };
                    let dv = if v == y {
                        0
                    } else {
                        self.routers[x].heard[v].as_ref().map_or(inf, |h| h[y])
                    };
                    let total = c.saturating_add(dv).min(inf);
                    if total >= inf {
                        continue;
                    }
                    let keep = total == best && v == self.routers[x].hop[y];
                    if total < best || keep {
                        best = total;
                        via = v;
                    }
                }
                (best, via)
            };
            let r = &mut self.routers[x];
            if r.dist[y] != best || r.hop[y] != via {
                changes.push((y, r.dist[y], r.hop[y]));
                r.dist[y] = best;
                r.hop[y] = via;
            }
        }
        changes
    }

    fn describe(&self, x: usize, changes: &[(usize, u32, usize)]) -> String {
        let route = |d: u32, h: usize| {
            if d >= self.p.infinity || h == NONE {
                "∞".to_string()
            } else if h == x {
                "0".to_string()
            } else {
                format!("{} via {}", d, self.name(h))
            }
        };
        changes
            .iter()
            .map(|&(y, d0, h0)| {
                let r = &self.routers[x];
                format!(
                    "D_{}({}) {} → {}",
                    self.name(x),
                    self.name(y),
                    route(d0, h0),
                    route(r.dist[y], r.hop[y])
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// D3. [Advertise.] Build the vector for each neighbour v. With poisoned
    /// reverse, every route whose next hop is v is reported to v as
    /// unreachable, so v never routes back through x for it. Send only to
    /// neighbours whose vector differs from the last one they were sent.
    fn advertise(&mut self, x: usize, now: u64) {
        let inf = self.p.infinity;
        let mut sent = Vec::new();
        for v in 0..self.n {
            if self.cost[x][v].is_none() {
                continue;
            }
            let mut vector = self.routers[x].dist.clone();
            let mut poisoned = Vec::new();
            if self.p.poison {
                for (y, entry) in vector.iter_mut().enumerate() {
                    if y != v && self.routers[x].hop[y] == v && *entry < inf {
                        *entry = inf;
                        poisoned.push(y);
                    }
                }
            }
            if self.routers[x].told[v].as_ref() == Some(&vector) {
                continue;
            }
            self.routers[x].told[v] = Some(vector.clone());
            let jitter = if self.p.jitter_us > 0 {
                self.rng.upto(self.p.jitter_us)
            } else {
                0
            };
            let t_arrive = (now + self.p.delay_us + jitter).max(self.last_arrival[x][v]);
            self.last_arrival[x][v] = t_arrive;
            let id = self.messages.len();
            self.messages.push(Message {
                id,
                from: x,
                to: v,
                t_send: now,
                t_arrive,
                vector: vector.clone(),
                poisoned: poisoned.clone(),
                lost: false,
            });
            self.queue.push(t_arrive, Ev::Arrive(id));
            let list = vector
                .iter()
                .map(|&d| self.show(d))
                .collect::<Vec<_>>()
                .join(", ");
            let poison = if poisoned.is_empty() {
                String::new()
            } else {
                format!(
                    " (poisoned: {})",
                    poisoned
                        .iter()
                        .map(|&y| self.name(y))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            sent.push(format!("to {}: ({}){}", self.name(v), list, poison));
        }
        if !sent.is_empty() {
            let text = format!("{} sends its vector {}", self.name(x), sent.join("; "));
            self.record(now, x as i32, "D3", text, None, Vec::new());
        }
    }
}

/// Run the distance-vector exchange from a cold start and through every
/// change, and Dijkstra's algorithm on every version of the network.
pub fn run(p: &Params) -> Run {
    let n = p.nodes.len();
    let inf = p.infinity;
    let mut cost = vec![vec![None; n]; n];
    for l in &p.links {
        cost[l.a][l.b] = Some(l.cost);
        cost[l.b][l.a] = Some(l.cost);
    }
    let mut sim = Sim {
        p,
        n,
        rng: Rng::new(p.seed),
        queue: Queue::default(),
        cost,
        routers: (0..n)
            .map(|_| Router {
                dist: vec![inf; n],
                hop: vec![NONE; n],
                heard: vec![None; n],
                told: vec![None; n],
            })
            .collect(),
        last_arrival: vec![vec![0; n]; n],
        messages: Vec::new(),
        events: Vec::new(),
        last_change_us: 0,
    };
    let mut changes: Vec<Change> = p.changes.clone();
    changes.sort_by_key(|c| c.at_us);
    for c in &changes {
        sim.queue.push(c.at_us, Ev::Change(*c));
    }

    // D0. [Initialise.] Each router knows only its own links: D_x(x) = 0,
    // D_x(v) = c(x, v) for each neighbour v, and infinity elsewhere.
    let mut changed = Vec::new();
    for x in 0..n {
        for (y, _, _) in sim.recompute(x) {
            changed.push([x, y]);
        }
    }
    sim.record(
        0,
        -1,
        "D0",
        "every router knows only the cost of its own links".into(),
        None,
        changed,
    );
    for x in 0..n {
        sim.advertise(x, 0);
    }

    let mut truncated = false;
    let mut now = 0;
    let mut dirty = vec![false; n];
    loop {
        // Routers that changed at this instant speak once all its arrivals
        // are in, so a synchronous round sends at most one vector per link.
        if sim.queue.peek_time() != Some(now) {
            for (x, flag) in dirty.iter_mut().enumerate() {
                if *flag {
                    *flag = false;
                    sim.advertise(x, now);
                }
            }
        }
        let Some((t, ev)) = sim.queue.pop() else {
            break;
        };
        if sim.events.len() >= MAX_EVENTS {
            truncated = true;
            break;
        }
        now = t;
        match ev {
            // L1. [Change a link.] Both ends see the new cost at once. A link
            // that goes down forgets what was heard over it; a new or restored
            // link has been told nothing, so both ends will send it a vector.
            Ev::Change(c) => {
                sim.cost[c.a][c.b] = c.cost;
                sim.cost[c.b][c.a] = c.cost;
                for (x, v) in [(c.a, c.b), (c.b, c.a)] {
                    if c.cost.is_none() {
                        sim.routers[x].heard[v] = None;
                    }
                    sim.routers[x].told[v] = None;
                }
                let mut changed = Vec::new();
                let mut parts = Vec::new();
                for x in [c.a, c.b] {
                    let ch = sim.recompute(x);
                    if !ch.is_empty() {
                        parts.push(sim.describe(x, &ch));
                    }
                    changed.extend(ch.iter().map(|&(y, _, _)| [x, y]));
                    dirty[x] = true;
                }
                let what = match c.cost {
                    Some(k) => format!("link {}–{} now costs {}", sim.name(c.a), sim.name(c.b), k),
                    None => format!("link {}–{} fails", sim.name(c.a), sim.name(c.b)),
                };
                let text = if parts.is_empty() {
                    what
                } else {
                    format!("{what}: {}", parts.join("; "))
                };
                sim.record(t, -1, "L1", text, None, changed);
            }
            Ev::Arrive(id) => {
                let (from, to) = (sim.messages[id].from, sim.messages[id].to);
                // L2. [Lose.] A message reaching a link that has since gone
                // down is lost.
                if sim.cost[to][from].is_none() {
                    sim.messages[id].lost = true;
                    let text = format!(
                        "{}'s vector to {} is lost: the link is down",
                        sim.name(from),
                        sim.name(to)
                    );
                    sim.record(t, to as i32, "L2", text, Some(id), Vec::new());
                    continue;
                }
                // D1. [Receive.] Keep the neighbour's vector, then recompute.
                sim.routers[to].heard[from] = Some(sim.messages[id].vector.clone());
                let ch = sim.recompute(to);
                let text = if ch.is_empty() {
                    format!("{} hears {}: no change", sim.name(to), sim.name(from))
                } else {
                    dirty[to] = true;
                    format!(
                        "{} hears {}: {}",
                        sim.name(to),
                        sim.name(from),
                        sim.describe(to, &ch)
                    )
                };
                let step = if ch.is_empty() { "D1" } else { "D2" };
                let changed = ch.iter().map(|&(y, _, _)| [to, y]).collect();
                sim.record(t, to as i32, step, text, Some(id), changed);
            }
        }
    }

    // The network in each period between changes, with Dijkstra from every source.
    let mut epochs = Vec::new();
    let mut cost: Vec<Vec<Option<u32>>> = vec![vec![None; n]; n];
    for l in &p.links {
        cost[l.a][l.b] = Some(l.cost);
        cost[l.b][l.a] = Some(l.cost);
    }
    let mut starts: Vec<u64> = vec![0];
    starts.extend(changes.iter().map(|c| c.at_us).filter(|&t| t > 0));
    starts.dedup();
    let mut ci = 0;
    for &t in &starts {
        while ci < changes.len() && changes[ci].at_us <= t {
            let c = changes[ci];
            cost[c.a][c.b] = c.cost;
            cost[c.b][c.a] = c.cost;
            ci += 1;
        }
        let dijkstra: Vec<Vec<DijkstraStep>> = (0..n).map(|s| dijkstra(&cost, s, inf)).collect();
        let shortest = dijkstra
            .iter()
            .map(|steps| steps.last().map_or_else(|| vec![inf; n], |s| s.d.clone()))
            .collect();
        epochs.push(Epoch {
            t,
            cost: cost
                .iter()
                .map(|row| row.iter().map(|c| c.map_or(-1, i64::from)).collect())
                .collect(),
            dijkstra,
            shortest,
        });
    }

    let last = epochs.last().expect("at least one epoch");
    let finals: Vec<Vec<u32>> = sim.routers.iter().map(|r| r.dist.clone()).collect();
    let converged = !truncated && finals == last.shortest;
    let lost = sim.messages.iter().filter(|m| m.lost).count();
    Run {
        totals: Totals {
            messages: sim.messages.len(),
            lost,
            last_change_us: sim.last_change_us,
            converged,
            truncated,
        },
        events: sim.events,
        messages: sim.messages,
        epochs,
    }
}

/// Dijkstra's algorithm from `s` (Dijkstra, 1959), as a link-state router
/// runs it on its map of the network.
pub fn dijkstra(cost: &[Vec<Option<u32>>], s: usize, infinity: u32) -> Vec<DijkstraStep> {
    let n = cost.len();
    // K1. [Initialise.] N' = {s}; D(v) = c(s, v) for each neighbour v of s
    // and infinity elsewhere; p(v) = s for the neighbours.
    let mut done = vec![false; n];
    let mut d = vec![infinity; n];
    let mut p = vec![-1i32; n];
    d[s] = 0;
    done[s] = true;
    for v in 0..n {
        if let Some(c) = cost[s][v] {
            if v != s && c < infinity {
                d[v] = c;
                p[v] = s as i32;
            }
        }
    }
    let mut steps = vec![DijkstraStep {
        added: s,
        d: d.clone(),
        p: p.clone(),
    }];
    // K2. [Choose.] Add to N' the router w outside it with the least D(w); a
    // tie goes to the lowest-numbered router. Stop when every router outside
    // N' is unreachable.
    while let Some(w) = (0..n)
        .filter(|&v| !done[v] && d[v] < infinity)
        .min_by_key(|&v| (d[v], v))
    {
        done[w] = true;
        // K3. [Relax.] For each neighbour v of w outside N',
        // D(v) = min(D(v), D(w) + c(w, v)); if that improves D(v), p(v) = w.
        for v in 0..n {
            if done[v] {
                continue;
            }
            if let Some(c) = cost[w][v] {
                let via = d[w].saturating_add(c).min(infinity);
                if via < d[v] {
                    d[v] = via;
                    p[v] = w as i32;
                }
            }
        }
        steps.push(DijkstraStep {
            added: w,
            d: d.clone(),
            p: p.clone(),
        });
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1000;

    fn net(names: &str, links: &[(usize, usize, u32)]) -> Params {
        Params {
            nodes: names.split(' ').map(String::from).collect(),
            links: links
                .iter()
                .map(|&(a, b, cost)| Link { a, b, cost })
                .collect(),
            changes: Vec::new(),
            poison: false,
            infinity: 100,
            delay_us: MS,
            jitter_us: 0,
            seed: 1,
        }
    }

    /// Kurose and Ross, Figure 5.3: u v w x y z.
    fn six() -> Params {
        net(
            "u v w x y z",
            &[
                (0, 1, 2),
                (0, 3, 1),
                (0, 2, 5),
                (1, 3, 2),
                (1, 2, 3),
                (3, 2, 3),
                (3, 4, 1),
                (2, 4, 1),
                (2, 5, 5),
                (4, 5, 2),
            ],
        )
    }

    #[test]
    fn dijkstra_matches_the_textbook_table() {
        let r = run(&six());
        let steps = &r.epochs[0].dijkstra[0];
        let last = steps.last().unwrap();
        // D: u 0, v 2, w 3, x 1, y 2, z 4; p: v u, w y, x u, y x, z y.
        assert_eq!(last.d, vec![0, 2, 3, 1, 2, 4]);
        assert_eq!(last.p, vec![-1, 0, 4, 0, 3, 4]);
        // x (D = 1) joins first; every router joins once.
        assert_eq!(steps[1].added, 3);
        assert_eq!(steps.len(), 6);
    }

    /// Bellman-Ford in synchronous rounds: after round k a router's estimate
    /// is the cheapest path of at most k + 1 links, so the tables settle by
    /// round H - 1, where H is the most links any pair's cheapest path needs.
    #[test]
    fn synchronous_rounds_settle_within_the_hop_bound() {
        let p = six();
        let r = run(&p);
        assert!(r.totals.converged);
        let n = p.nodes.len();
        let mut cost = vec![vec![None; n]; n];
        for l in &p.links {
            cost[l.a][l.b] = Some(l.cost);
            cost[l.b][l.a] = Some(l.cost);
        }
        // Fewest links among cheapest paths, by Bellman-Ford over (cost, hops).
        let mut best = vec![vec![(u32::MAX, 0u32); n]; n];
        for (s, row) in best.iter_mut().enumerate() {
            row[s] = (0, 0);
            for _ in 0..n {
                for a in 0..n {
                    for b in 0..n {
                        if let (Some(c), (d, h)) = (cost[a][b], row[a]) {
                            if d < u32::MAX && (d + c, h + 1) < row[b] {
                                row[b] = (d + c, h + 1);
                            }
                        }
                    }
                }
            }
        }
        let h = best.iter().flatten().map(|&(_, h)| h).max().unwrap() as u64;
        assert!(
            r.totals.last_change_us <= (h - 1) * MS,
            "settled at {} with H = {h}",
            r.totals.last_change_us
        );
    }

    #[test]
    fn distance_vector_agrees_with_dijkstra_on_random_networks() {
        for seed in 1..=40u64 {
            let mut g = Rng::new(seed);
            let n = 4 + g.upto(5) as usize;
            let mut links = Vec::new();
            for v in 1..n {
                links.push((g.upto(v as u64 - 1) as usize, v, 1 + g.upto(8) as u32));
            }
            for _ in 0..n {
                let (a, b) = (g.upto(n as u64 - 1) as usize, g.upto(n as u64 - 1) as usize);
                if a != b
                    && !links
                        .iter()
                        .any(|&(x, y, _)| (x, y) == (a, b) || (x, y) == (b, a))
                {
                    links.push((a, b, 1 + g.upto(8) as u32));
                }
            }
            let names = (0..n)
                .map(|i| format!("r{i}"))
                .collect::<Vec<_>>()
                .join(" ");
            let mut p = net(&names, &links);
            p.jitter_us = if seed % 2 == 0 { 3 * MS } else { 0 };
            p.poison = seed % 3 == 0;
            p.seed = seed;
            let (a, b, _) = links[g.upto(links.len() as u64 - 1) as usize];
            p.changes = vec![
                Change {
                    at_us: 20 * MS,
                    a,
                    b,
                    cost: None,
                },
                Change {
                    at_us: 60 * MS,
                    a,
                    b,
                    cost: Some(4),
                },
            ];
            let r = run(&p);
            assert!(r.totals.converged, "seed {seed}");
            assert_eq!(r.epochs.len(), 3);
        }
    }

    fn changes_to(r: &Run, x: usize, y: usize, after: u64) -> Vec<u32> {
        let mut seen = Vec::new();
        for e in r.events.iter().filter(|e| e.t >= after) {
            if e.changed.contains(&[x, y]) {
                seen.push(e.dist[x][y]);
            }
        }
        seen
    }

    /// Kurose and Ross, Figure 5.7: x y z with c(x,y) = 4, c(y,z) = 1,
    /// c(x,z) = 50. When c(x,y) rises to 60, y and z bounce the route to x
    /// between them, each step adding 2 c(y,z), until z's direct link (50) wins.
    #[test]
    fn bad_news_counts_up_and_poisoned_reverse_stops_it() {
        let mut p = net("x y z", &[(0, 1, 4), (1, 2, 1), (0, 2, 50)]);
        p.changes = vec![Change {
            at_us: 10 * MS,
            a: 0,
            b: 1,
            cost: Some(60),
        }];
        let r = run(&p);
        assert!(r.totals.converged);
        let y = changes_to(&r, 1, 0, 10 * MS);
        let z = changes_to(&r, 2, 0, 10 * MS);
        assert_eq!(y.first(), Some(&6));
        assert_eq!(y.last(), Some(&51));
        assert_eq!(z.last(), Some(&50));
        assert!(y.len() + z.len() >= 44, "{} updates", y.len() + z.len());

        p.poison = true;
        let r = run(&p);
        assert!(r.totals.converged);
        let n = changes_to(&r, 1, 0, 10 * MS).len() + changes_to(&r, 2, 0, 10 * MS).len();
        assert!(n <= 3, "{n} updates with poisoned reverse");

        // Good news: c(x,y) falls to 1 and the tables settle within two rounds.
        p.poison = false;
        p.changes = vec![Change {
            at_us: 10 * MS,
            a: 0,
            b: 1,
            cost: Some(1),
        }];
        let r = run(&p);
        assert!(r.totals.converged);
        assert!(r.totals.last_change_us <= 12 * MS);
    }

    /// A loop of three: a-b, b-c, b-d, c-d. When a-b fails, c and d each
    /// offer the other a route to a that went through b, and poisoned reverse
    /// cannot see it, because neither routes through the one it tells.
    #[test]
    fn poisoned_reverse_fails_on_a_loop_of_three() {
        let mut p = net("a b c d", &[(0, 1, 1), (1, 2, 1), (1, 3, 1), (2, 3, 1)]);
        p.infinity = 16;
        p.poison = true;
        p.changes = vec![Change {
            at_us: 10 * MS,
            a: 0,
            b: 1,
            cost: None,
        }];
        let r = run(&p);
        assert!(r.totals.converged);
        let c = changes_to(&r, 2, 0, 10 * MS);
        assert!(c.len() >= 5, "c's route to a took {} values", c.len());
        assert_eq!(c.last(), Some(&16));
        let settle = r.totals.last_change_us - 10 * MS;

        // Without the c-d link there is no loop and the news spreads in two rounds.
        p.links.pop();
        let r = run(&p);
        assert!(r.totals.converged);
        assert!(r.totals.last_change_us - 10 * MS <= 2 * MS);
        assert!(settle > 5 * MS);
    }
}
