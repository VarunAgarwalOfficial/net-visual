//! Routing inside one network: distance vector and link state.
//!
//! The network is a graph of routers joined by links with positive costs.
//! Links can change cost, fail or come back at given times.
//!
//! Distance vector is the Bellman-Ford exchange used by RIP. Every router
//! keeps an estimate of its cost to every destination and the neighbour it
//! would forward through, and tells its neighbours whenever what it would
//! tell them changes (a triggered update). A message takes a fixed delay,
//! plus seeded jitter if asked for. With no jitter every message sent at one
//! instant arrives at the next, so the exchange runs in synchronous rounds.
//! Messages on one link arrive in the order they were sent. Costs at or above
//! `infinity` mean "unreachable", as 16 does in RIP.
//!
//! Options follow RFC 2453. Simple split horizon leaves out of the vector
//! sent to a neighbour every route that goes through it, so the neighbour
//! keeps whatever it last heard about those destinations; poisoned reverse
//! sends them as unreachable instead (Section 3.4.3). RIP's timers are an
//! option too: every router sends its whole vector every `period_us`
//! (Section 3.8), triggered updates can be turned off (Section 3.4.4 is about
//! keeping them), and an entry heard from a neighbour that goes `timeout_us`
//! without being repeated becomes unreachable (Section 3.8, the 180-second
//! timeout).
//!
//! Link state is OSPF's design (RFC 2328). Each router describes its working
//! links in a link-state advertisement (LSA) with a sequence number and floods
//! it: a router that receives an LSA newer than the one it holds stores it and
//! passes it to every other neighbour. Each router runs Dijkstra's algorithm on
//! its own map whenever the map changes, so while an LSA is still spreading,
//! routers that have it and routers that do not can forward in a loop.
//!
//! For checking, the model also computes Dijkstra on the true network for
//! every source and every period between two link changes.
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

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Algorithm {
    /// Distance vector (Bellman-Ford, as in RIP).
    #[default]
    Dv,
    /// Link state (flooding and Dijkstra, as in OSPF).
    Ls,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Params {
    pub nodes: Vec<String>,
    pub links: Vec<Link>,
    pub changes: Vec<Change>,
    #[serde(default)]
    pub algorithm: Algorithm,
    /// Report routes through a neighbour back to it as unreachable.
    pub poison: bool,
    /// Leave routes through a neighbour out of what it is sent. Poisoned
    /// reverse, when on, takes precedence.
    #[serde(default)]
    pub split_horizon: bool,
    /// Distances at or above this are unreachable.
    pub infinity: u32,
    /// Time for one message to cross a link.
    pub delay_us: u64,
    /// Extra delay, uniform on 0..=jitter_us, drawn per message.
    pub jitter_us: u64,
    pub seed: u64,
    /// Distance vector only: send the whole vector this often; 0 for never.
    #[serde(default)]
    pub period_us: u64,
    /// Distance vector only: send when the vector changes.
    #[serde(default = "yes")]
    pub triggered: bool,
    /// Distance vector with a period only: an entry not repeated for this
    /// long becomes unreachable; 0 for never.
    #[serde(default)]
    pub timeout_us: u64,
    /// With a period the exchange never goes quiet, so the run stops here;
    /// 0 picks the last change plus the timeout plus four periods.
    #[serde(default)]
    pub end_us: u64,
}

/// A link-state advertisement: a router's working links and their costs.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Lsa {
    pub origin: usize,
    pub seq: u32,
    /// `[neighbour, cost]` for each working link.
    pub links: Vec<(usize, u32)>,
}

/// One message on a link: a distance vector, or an LSA being flooded.
#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub t_send: u64,
    pub t_arrive: u64,
    /// The vector as sent, one entry per destination; `infinity` is
    /// unreachable. Empty for an LSA.
    pub vector: Vec<u32>,
    /// Destinations reported as unreachable only because of poisoned reverse.
    pub poisoned: Vec<usize>,
    /// Destinations left out by split horizon; their entries mean nothing.
    pub omitted: Vec<usize>,
    /// Sent by the update timer rather than by a change.
    pub periodic: bool,
    pub lsa: Option<Lsa>,
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
    /// For a timeout: `[v, y]`, the neighbour and destination whose entry expired.
    pub expired: Option<[usize; 2]>,
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
    /// When the run stopped: the last event, or `end_us` with a period.
    pub end_us: u64,
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
    /// Router x's update timer.
    Tick(usize),
    /// Router x's entry for y heard from v at time `at` may have expired.
    Expire {
        x: usize,
        v: usize,
        y: usize,
        at: u64,
    },
}

struct Router {
    dist: Vec<u32>,
    hop: Vec<usize>,
    /// The last vector heard from each neighbour, entry by entry.
    heard: Vec<Option<Vec<u32>>>,
    /// When each entry of `heard` was last repeated.
    heard_at: Vec<Vec<u64>>,
    /// The last vector sent to each neighbour, with left-out entries as `u32::MAX`.
    told: Vec<Option<Vec<u32>>>,
    /// Link state: the newest LSA held from each origin.
    db: Vec<Option<Lsa>>,
    /// Link state: the sequence number of this router's own latest LSA.
    seq: u32,
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

type Changes = Vec<(usize, u32, usize)>;

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

    fn names(&self, list: &[usize]) -> String {
        list.iter()
            .map(|&y| self.name(y))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn neighbours(&self, x: usize) -> Vec<usize> {
        (0..self.n).filter(|&v| self.cost[x][v].is_some()).collect()
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
            expired: None,
        });
    }

    /// Put a message on the link from x to v: it arrives one delay later (plus
    /// jitter), and never before one sent earlier on the same link.
    fn send(&mut self, x: usize, v: usize, now: u64, mut m: Message) {
        let jitter = if self.p.jitter_us > 0 {
            self.rng.upto(self.p.jitter_us)
        } else {
            0
        };
        let t_arrive = (now + self.p.delay_us + jitter).max(self.last_arrival[x][v]);
        self.last_arrival[x][v] = t_arrive;
        m.id = self.messages.len();
        m.t_send = now;
        m.t_arrive = t_arrive;
        self.queue.push(t_arrive, Ev::Arrive(m.id));
        self.messages.push(m);
    }

    fn set_routes(&mut self, x: usize, routes: Vec<(u32, usize)>) -> Changes {
        let mut changes = Vec::new();
        let r = &mut self.routers[x];
        for (y, (best, via)) in routes.into_iter().enumerate() {
            if r.dist[y] != best || r.hop[y] != via {
                changes.push((y, r.dist[y], r.hop[y]));
                r.dist[y] = best;
                r.hop[y] = via;
            }
        }
        changes
    }

    /// D2. [Recompute.] The Bellman-Ford equation: for every destination y,
    /// D_x(y) = min over neighbours v of c(x, v) + D_v(y), where D_v is the
    /// last vector heard from v (and D_v(v) = 0 even before v has spoken).
    /// Anything at or above infinity is unreachable. A tie keeps the current
    /// next hop if it is among the best, so routes do not flap; otherwise the
    /// lowest-numbered neighbour wins. Returns the destinations that changed.
    fn recompute(&mut self, x: usize) -> Changes {
        let inf = self.p.infinity;
        let mut routes = Vec::with_capacity(self.n);
        for y in 0..self.n {
            if y == x {
                routes.push((0, x));
                continue;
            }
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
            routes.push((best, via));
        }
        self.set_routes(x, routes)
    }

    /// F4. [Run Dijkstra on the map.] Router x's map holds its own working
    /// links and, for every other router, the links its newest LSA lists. A
    /// link between two other routers is used only if both of their LSAs list
    /// it (the two-way check of RFC 2328, Section 16.1), so one report of a
    /// failure is enough to stop using a link. Then Dijkstra's algorithm runs
    /// from x (steps K1 to K3 below), and the next hop to y is the first
    /// router after x on the path the predecessors give.
    fn spf(&mut self, x: usize) -> Changes {
        let (n, inf) = (self.n, self.p.infinity);
        let lists = |o: usize, b: usize| -> Option<u32> {
            if o == x {
                return self.cost[x][b];
            }
            self.routers[x].db[o]
                .as_ref()
                .and_then(|l| l.links.iter().find(|&&(v, _)| v == b).map(|&(_, c)| c))
        };
        let map: Vec<Vec<Option<u32>>> = (0..n)
            .map(|o| {
                (0..n)
                    .map(|b| {
                        if o == b {
                            None
                        } else if o == x {
                            self.cost[x][b]
                        } else if b == x {
                            lists(o, x).filter(|_| self.cost[x][o].is_some())
                        } else {
                            lists(o, b).filter(|_| lists(b, o).is_some())
                        }
                    })
                    .collect()
            })
            .collect();
        let steps = dijkstra(&map, x, inf);
        let last = steps.last().expect("Dijkstra has a first step");
        let routes = (0..n)
            .map(|y| {
                if y == x {
                    (0, x)
                } else if last.d[y] >= inf {
                    (inf, NONE)
                } else {
                    let mut v = y;
                    while last.p[v] != x as i32 {
                        v = last.p[v] as usize;
                    }
                    (last.d[y], v)
                }
            })
            .collect();
        self.set_routes(x, routes)
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
    /// unreachable, so v never routes back through x for it. With simple
    /// split horizon those routes are left out, and v keeps whatever it last
    /// heard about them. A triggered update goes only to neighbours whose
    /// vector differs from the last one they were sent; a periodic one goes
    /// to every neighbour.
    fn advertise(&mut self, x: usize, now: u64, periodic: bool) {
        let inf = self.p.infinity;
        let mut sent = Vec::new();
        for v in self.neighbours(x) {
            let mut vector = self.routers[x].dist.clone();
            let mut told = vector.clone();
            let (mut poisoned, mut omitted) = (Vec::new(), Vec::new());
            for y in 0..self.n {
                if y == v || self.routers[x].hop[y] != v || vector[y] >= inf {
                    continue;
                }
                if self.p.poison {
                    vector[y] = inf;
                    told[y] = inf;
                    poisoned.push(y);
                } else if self.p.split_horizon {
                    vector[y] = inf;
                    told[y] = u32::MAX;
                    omitted.push(y);
                }
            }
            if !periodic && self.routers[x].told[v].as_ref() == Some(&told) {
                continue;
            }
            self.routers[x].told[v] = Some(told);
            let list = (0..self.n)
                .map(|y| {
                    if omitted.contains(&y) {
                        "–".to_string()
                    } else {
                        self.show(vector[y])
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let mut note = String::new();
            if !poisoned.is_empty() {
                note += &format!(" (poisoned: {})", self.names(&poisoned));
            }
            if !omitted.is_empty() {
                note += &format!(" (left out: {})", self.names(&omitted));
            }
            sent.push(format!("to {}: ({}){}", self.name(v), list, note));
            let m = Message {
                id: 0,
                from: x,
                to: v,
                t_send: 0,
                t_arrive: 0,
                vector,
                poisoned,
                omitted,
                periodic,
                lsa: None,
                lost: false,
            };
            self.send(x, v, now, m);
        }
        if !sent.is_empty() {
            let (step, what) = if periodic {
                ("T1", "update timer fires: it sends its whole vector")
            } else {
                ("D3", "sends its vector")
            };
            let text = format!("{} {} {}", self.name(x), what, sent.join("; "));
            self.record(now, x as i32, step, text, None, Vec::new());
        }
    }

    fn lsa_message(&self, x: usize, v: usize, lsa: Lsa) -> Message {
        Message {
            id: 0,
            from: x,
            to: v,
            t_send: 0,
            t_arrive: 0,
            vector: Vec::new(),
            poisoned: Vec::new(),
            omitted: Vec::new(),
            periodic: false,
            lsa: Some(lsa),
            lost: false,
        }
    }

    fn show_lsa(&self, l: &Lsa) -> String {
        let links = l
            .links
            .iter()
            .map(|&(v, c)| format!("{} {}", self.name(v), c))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{}'s LSA #{} ({})", self.name(l.origin), l.seq, links)
    }

    /// F1. [Originate.] When its links change (and at the start), a router
    /// writes a new LSA listing its working links, with the next sequence
    /// number, keeps it and sends it to every neighbour.
    fn originate(&mut self, x: usize, now: u64) {
        let links: Vec<(usize, u32)> = (0..self.n)
            .filter_map(|v| self.cost[x][v].map(|c| (v, c)))
            .collect();
        self.routers[x].seq += 1;
        let lsa = Lsa {
            origin: x,
            seq: self.routers[x].seq,
            links,
        };
        self.routers[x].db[x] = Some(lsa.clone());
        let to = self.neighbours(x);
        for &v in &to {
            let m = self.lsa_message(x, v, lsa.clone());
            self.send(x, v, now, m);
        }
        let text = if to.is_empty() {
            format!(
                "{} writes {}, but has no working link to send it on",
                self.name(x),
                self.show_lsa(&lsa)
            )
        } else {
            format!(
                "{} floods {} to {}",
                self.name(x),
                self.show_lsa(&lsa),
                self.names(&to)
            )
        };
        self.record(now, x as i32, "F1", text, None, Vec::new());
    }

    /// F2. [Flood.] A router that receives an LSA newer than the one it holds
    /// from that origin (a higher sequence number, or the first) stores it,
    /// passes it on to every neighbour except the one it came from, and runs
    /// Dijkstra on its new map. F3. [Discard.] An LSA it already has, or an
    /// older one, goes no further.
    fn receive_lsa(&mut self, id: usize, t: u64) {
        let (from, to) = (self.messages[id].from, self.messages[id].to);
        let lsa = self.messages[id].lsa.clone().expect("an LSA message");
        let newer = self.routers[to].db[lsa.origin]
            .as_ref()
            .is_none_or(|h| lsa.seq > h.seq);
        if !newer {
            let text = format!(
                "{} already holds {}'s LSA #{}: it goes no further",
                self.name(to),
                self.name(lsa.origin),
                lsa.seq
            );
            self.record(t, to as i32, "F3", text, Some(id), Vec::new());
            return;
        }
        self.routers[to].db[lsa.origin] = Some(lsa.clone());
        let on: Vec<usize> = self
            .neighbours(to)
            .into_iter()
            .filter(|&v| v != from)
            .collect();
        for &v in &on {
            let m = self.lsa_message(to, v, lsa.clone());
            self.send(to, v, t, m);
        }
        let ch = self.spf(to);
        let pass = if on.is_empty() {
            "has no one else to pass it to".to_string()
        } else {
            format!("passes it to {}", self.names(&on))
        };
        let effect = if ch.is_empty() {
            "no route changes".to_string()
        } else {
            self.describe(to, &ch)
        };
        let text = format!(
            "{} stores {}, {}; {}",
            self.name(to),
            self.show_lsa(&lsa),
            pass,
            effect
        );
        let changed = ch.iter().map(|&(y, _, _)| [to, y]).collect();
        self.record(t, to as i32, "F2", text, Some(id), changed);
    }
}

/// Run the exchange from a cold start and through every change, and
/// Dijkstra's algorithm on every version of the network.
pub fn run(p: &Params) -> Run {
    let n = p.nodes.len();
    let inf = p.infinity;
    let ls = p.algorithm == Algorithm::Ls;
    let periodic = !ls && p.period_us > 0;
    let expiring = periodic && p.timeout_us > 0;
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
                heard_at: vec![vec![0; n]; n],
                told: vec![None; n],
                db: vec![None; n],
                seq: 0,
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
    let last_scripted = changes.last().map_or(0, |c| c.at_us);
    let end = if !periodic {
        u64::MAX
    } else if p.end_us > 0 {
        p.end_us
    } else {
        last_scripted + p.timeout_us + 4 * p.period_us
    };

    // D0. [Initialise.] Each router knows only its own links: D_x(x) = 0,
    // D_x(v) = c(x, v) for each neighbour v, and infinity elsewhere.
    let mut changed = Vec::new();
    for x in 0..n {
        let ch = if ls { sim.spf(x) } else { sim.recompute(x) };
        changed.extend(ch.iter().map(|&(y, _, _)| [x, y]));
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
        if ls {
            sim.originate(x, 0);
        } else {
            sim.advertise(x, 0, false);
        }
    }
    // T1. [Update timer.] With a period, each router's timer fires every
    // period and it sends its whole vector to every neighbour. With jitter,
    // the timers start at random points in the first period and each new
    // interval is the period plus or minus a sixth, as RFC 2453 asks so that
    // routers do not fall into step (Section 3.8).
    let interval = |rng: &mut Rng| {
        if p.jitter_us > 0 {
            p.period_us - p.period_us / 6 + rng.upto(p.period_us / 3)
        } else {
            p.period_us
        }
    };
    if periodic {
        for x in 0..n {
            let first = if p.jitter_us > 0 {
                1 + sim.rng.upto(p.period_us - 1)
            } else {
                p.period_us
            };
            if first <= end {
                sim.queue.push(first, Ev::Tick(x));
            }
        }
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
                    if p.triggered {
                        sim.advertise(x, now, false);
                    }
                }
            }
        }
        let Some((t, ev)) = sim.queue.pop() else {
            break;
        };
        if t > end {
            break;
        }
        if sim.events.len() >= MAX_EVENTS {
            truncated = true;
            break;
        }
        now = t;
        match ev {
            // L1. [Change a link.] Both ends see the new cost at once. A link
            // that goes down forgets what was heard over it; a new or restored
            // link has been told nothing, so both ends will send it a vector.
            // In link state both ends originate new LSAs (F1), and over a link
            // that comes up they also send each other every LSA they hold, as
            // OSPF's database exchange does when an adjacency forms.
            Ev::Change(c) => {
                let was_up = sim.cost[c.a][c.b].is_some();
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
                    let ch = if ls { sim.spf(x) } else { sim.recompute(x) };
                    if !ch.is_empty() {
                        parts.push(sim.describe(x, &ch));
                    }
                    changed.extend(ch.iter().map(|&(y, _, _)| [x, y]));
                    dirty[x] = !ls;
                }
                let what = match c.cost {
                    Some(k) => format!("link {}–{} now costs {}", sim.name(c.a), sim.name(c.b), k),
                    None => format!("link {}–{} fails", sim.name(c.a), sim.name(c.b)),
                };
                let up = ls && !was_up && c.cost.is_some();
                let mut text = if parts.is_empty() {
                    what
                } else {
                    format!("{what}: {}", parts.join("; "))
                };
                if up {
                    text += "; the two ends exchange the LSAs they hold";
                }
                sim.record(t, -1, "L1", text, None, changed);
                if ls {
                    sim.originate(c.a, t);
                    sim.originate(c.b, t);
                    if up {
                        for (x, v) in [(c.a, c.b), (c.b, c.a)] {
                            let held: Vec<Lsa> = sim.routers[x]
                                .db
                                .iter()
                                .flatten()
                                .filter(|l| l.origin != x)
                                .cloned()
                                .collect();
                            for l in held {
                                let m = sim.lsa_message(x, v, l);
                                sim.send(x, v, t, m);
                            }
                        }
                    }
                }
            }
            Ev::Arrive(id) => {
                let (from, to) = (sim.messages[id].from, sim.messages[id].to);
                // L2. [Lose.] A message reaching a link that has since gone
                // down is lost.
                if sim.cost[to][from].is_none() {
                    sim.messages[id].lost = true;
                    let what = if sim.messages[id].lsa.is_some() {
                        "LSA"
                    } else {
                        "vector"
                    };
                    let text = format!(
                        "{}'s {} to {} is lost: the link is down",
                        sim.name(from),
                        what,
                        sim.name(to)
                    );
                    sim.record(t, to as i32, "L2", text, Some(id), Vec::new());
                    continue;
                }
                if sim.messages[id].lsa.is_some() {
                    sim.receive_lsa(id, t);
                    continue;
                }
                // D1. [Receive.] Keep each entry the neighbour sent (not the
                // ones split horizon left out), note when it was heard, then
                // recompute.
                let m = sim.messages[id].clone();
                let r = &mut sim.routers[to];
                let heard = r.heard[from].get_or_insert_with(|| vec![inf; n]);
                for (y, entry) in heard.iter_mut().enumerate() {
                    if m.omitted.contains(&y) {
                        continue;
                    }
                    *entry = m.vector[y];
                    r.heard_at[from][y] = t;
                    if expiring && m.vector[y] < inf && y != from {
                        sim.queue.push(
                            t + p.timeout_us,
                            Ev::Expire {
                                x: to,
                                v: from,
                                y,
                                at: t,
                            },
                        );
                    }
                }
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
            Ev::Tick(x) => {
                sim.advertise(x, t, true);
                let next = t + interval(&mut sim.rng);
                if next <= end {
                    sim.queue.push(next, Ev::Tick(x));
                }
            }
            // T2. [Time out.] An entry heard from v that has not been repeated
            // for the timeout becomes unreachable, and x recomputes. Under
            // simple split horizon this is the only way a route that v leaves
            // out of its updates ever goes away.
            Ev::Expire { x, v, y, at } => {
                let live = sim.routers[x].heard[v].as_ref().is_some_and(|h| h[y] < inf)
                    && sim.routers[x].heard_at[v][y] == at;
                if !live {
                    continue;
                }
                if let Some(h) = sim.routers[x].heard[v].as_mut() {
                    h[y] = inf;
                }
                let ch = sim.recompute(x);
                if !ch.is_empty() {
                    dirty[x] = true;
                }
                let secs = p.timeout_us as f64 / 1e6;
                let mut text = format!(
                    "{} has heard nothing new from {} about {} for {} s: that entry times out",
                    sim.name(x),
                    sim.name(v),
                    sim.name(y),
                    secs
                );
                if !ch.is_empty() {
                    text += &format!("; {}", sim.describe(x, &ch));
                }
                let changed = ch.iter().map(|&(y, _, _)| [x, y]).collect();
                sim.record(t, x as i32, "T2", text, None, changed);
                if let Some(e) = sim.events.last_mut() {
                    e.expired = Some([v, y]);
                }
            }
        }
    }
    let end_us = if periodic {
        end
    } else {
        sim.events.last().map_or(0, |e| e.t)
    };

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
            end_us,
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
            algorithm: Algorithm::Dv,
            poison: false,
            split_horizon: false,
            infinity: 100,
            delay_us: MS,
            jitter_us: 0,
            seed: 1,
            period_us: 0,
            triggered: true,
            timeout_us: 0,
            end_us: 0,
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

    fn looped(e: &Event, a: usize, b: usize, y: usize) -> bool {
        e.hop[a][y] == b as i32 && e.hop[b][y] == a as i32
    }

    /// Flooding from a cold start, with no jitter: the origin sends its LSA
    /// on all its links and every other router passes it on all links but
    /// the one it first came in on, so one LSA costs 2m - n + 1 messages,
    /// and n of them cost n(2m - n + 1). Six routers and ten links: 90.
    #[test]
    fn flooding_costs_two_m_minus_n_plus_one_per_lsa() {
        let mut p = six();
        p.algorithm = Algorithm::Ls;
        let r = run(&p);
        assert!(r.totals.converged);
        assert_eq!(r.totals.messages, 6 * (2 * 10 - 6 + 1));
        // Every router has every LSA after as many rounds as the widest gap
        // in hops between two routers (3 here), and its routes are Dijkstra's.
        assert!(r.totals.last_change_us <= 3 * MS);
    }

    /// a-b 1, b-d 1, a-d 3: a reaches d through b. When b-d fails, b knows at
    /// once and turns to a; a still has the old map and forwards to b, so
    /// packets for d go a, b, a, ... until b's and d's new LSAs reach a, one
    /// delay later. Distance vector with poisoned reverse avoids this loop.
    #[test]
    fn link_state_loops_for_one_delay_while_maps_differ() {
        let mut p = net("a b d", &[(0, 1, 1), (1, 2, 1), (0, 2, 3)]);
        p.algorithm = Algorithm::Ls;
        p.changes = vec![Change {
            at_us: 10 * MS,
            a: 1,
            b: 2,
            cost: None,
        }];
        let r = run(&p);
        assert!(r.totals.converged);
        let at = |t: u64| r.events.iter().rfind(|e| e.t <= t).unwrap();
        assert!(looped(at(10 * MS), 0, 1, 2));
        assert!(!looped(at(11 * MS), 0, 1, 2));
        assert!(r
            .events
            .iter()
            .filter(|e| e.t < 10 * MS)
            .all(|e| !looped(e, 0, 1, 2)));
        assert_eq!(r.events.last().unwrap().dist[1][2], 4);
    }

    #[test]
    fn link_state_agrees_with_dijkstra_on_random_networks() {
        for seed in 1..=40u64 {
            let mut g = Rng::new(seed + 1000);
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
            p.algorithm = Algorithm::Ls;
            p.jitter_us = if seed % 2 == 0 { 3 * MS } else { 0 };
            p.seed = seed;
            let (a, b, _) = links[g.upto(links.len() as u64 - 1) as usize];
            let (c, d, _) = links[g.upto(links.len() as u64 - 1) as usize];
            p.changes = vec![
                Change {
                    at_us: 20 * MS,
                    a,
                    b,
                    cost: None,
                },
                Change {
                    at_us: 21 * MS,
                    a: c,
                    b: d,
                    cost: Some(9),
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
        }
    }

    /// RIP without triggered updates: news moves one link per 30-second
    /// update, so when a is cut off b and c count to 16 in minutes, not
    /// milliseconds.
    #[test]
    fn without_triggered_updates_the_count_moves_once_a_period() {
        let mut p = net("a b c", &[(0, 1, 1), (1, 2, 1)]);
        p.infinity = 16;
        p.period_us = 30_000 * MS;
        p.triggered = false;
        p.timeout_us = 180_000 * MS;
        p.changes = vec![Change {
            at_us: 100_000 * MS,
            a: 0,
            b: 1,
            cost: None,
        }];
        p.end_us = 1_000_000 * MS;
        let r = run(&p);
        assert!(r.totals.converged);
        let b = changes_to(&r, 1, 0, 100_000 * MS);
        assert_eq!(b.first(), Some(&3));
        assert_eq!(b.last(), Some(&16));
        // Each of b's steps waits for c's next update: one period apart.
        let times: Vec<u64> = r
            .events
            .iter()
            .filter(|e| e.t >= 100_000 * MS && e.changed.contains(&[1, 0]))
            .map(|e| e.t)
            .collect();
        // b and c take turns, each waiting for the other's next update, so
        // b's estimate climbs 2 every two periods: the rate of the count
        // (C = 2 every L = 2 rounds) with 30-second rounds. Nearly seven
        // minutes from the failure to 16.
        assert_eq!(b, vec![3, 5, 7, 9, 11, 13, 15, 16]);
        for w in times[1..].windows(2) {
            assert_eq!(w[1] - w[0], 2 * 30_000 * MS);
        }
        assert_eq!(r.totals.last_change_us, 510_001 * MS);
    }

    /// Simple split horizon on Kurose and Ross, Figure 5.7, with RIP timers.
    /// z routes to x through y, so it leaves x out of what it tells y, and y
    /// still holds the 50 z told it at the start. When c(x,y) rises to 60, y
    /// takes 1 + 50 through z, and z, which hears nothing from y about x,
    /// keeps its route through y: a loop. It lasts until y's stale entry has
    /// gone 180 s unrepeated. Poisoned reverse never forms it.
    #[test]
    fn simple_split_horizon_waits_for_the_timeout() {
        let mut p = net("x y z", &[(0, 1, 4), (1, 2, 1), (0, 2, 50)]);
        p.split_horizon = true;
        p.period_us = 30_000 * MS;
        p.timeout_us = 180_000 * MS;
        p.changes = vec![Change {
            at_us: 100_000 * MS,
            a: 0,
            b: 1,
            cost: Some(60),
        }];
        let r = run(&p);
        assert!(r.totals.converged);
        let at = |t: u64| r.events.iter().rfind(|e| e.t <= t).unwrap();
        assert!(!looped(at(99_000 * MS), 1, 2, 0));
        assert!(looped(at(101_000 * MS), 1, 2, 0));
        assert!(looped(at(179_000 * MS), 1, 2, 0));
        assert!(!looped(at(182_000 * MS), 1, 2, 0));
        assert!(r
            .events
            .iter()
            .any(|e| e.step == "T2" && e.expired == Some([2, 0])));

        p.split_horizon = false;
        p.poison = true;
        let r = run(&p);
        assert!(r.totals.converged);
        assert!(r.events.iter().all(|e| !looped(e, 1, 2, 0)));
    }
}
