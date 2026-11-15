//! The spanning tree protocol (Perlman 1985; IEEE 802.1D-1998 Clause 8).
//!
//! Bridges exchange configuration BPDUs, each a priority vector (root bridge
//! ID, root path cost, sender bridge ID, sender port ID); smaller is better,
//! compared in that order. The bridge with the lowest ID becomes root; each
//! other bridge keeps the port with the best path to it, each link keeps the
//! end that offers the best path, and every other port blocks. Ports wait in
//! listening and learning for a forward delay each before they forward, so
//! that the whole tree settles first.
//!
//! The model is exact: given the topology, the timers and the failure there
//! is nothing random left. The steps are lettered; the trace names the step
//! behind each event and the page highlights it in this source.

use serde::{Deserialize, Serialize};

use crate::lan::{check_topology, ports, End, Link};
use crate::sim::Queue;

// ---------------------------------------------------------------------------
// The spanning tree protocol
// ---------------------------------------------------------------------------

/// A priority vector: smaller is better, field by field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Vector {
    pub root: u64,
    pub cost: u32,
    pub bridge: u64,
    pub port: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Root,
    Designated,
    /// Blocked: neither root nor designated.
    Alternate,
    Disabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PortState {
    Blocking,
    Listening,
    Learning,
    Forwarding,
    Disabled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bridge {
    pub name: String,
    /// The bridge ID: priority in the top 16 bits, MAC address below.
    pub id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Failure {
    pub at_ms: u64,
    pub link: usize,
    /// Both ends see the carrier drop at once. Otherwise BPDUs just stop
    /// arriving and stored information has to age out.
    pub detected: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StpParams {
    pub bridges: Vec<Bridge>,
    pub links: Vec<Link>,
    pub hello_ms: u64,
    pub max_age_ms: u64,
    pub forward_delay_ms: u64,
    /// Time for a BPDU to cross a link and be processed.
    pub delay_ms: u64,
    pub until_ms: u64,
    #[serde(default)]
    pub failure: Option<Failure>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PortView {
    pub port: usize,
    pub link: usize,
    pub peer: usize,
    pub role: Role,
    pub state: PortState,
}

#[derive(Clone, Debug, Serialize)]
pub struct BridgeView {
    pub bridge: usize,
    pub root: u64,
    pub cost: u32,
    pub root_port: Option<usize>,
    pub ports: Vec<PortView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Bpdu {
    pub v: Vector,
    /// The message age: time since the root sent the hello this BPDU
    /// descends from, plus a second per bridge it passed through.
    pub age_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StpEvent {
    pub t: u64,
    pub step: &'static str,
    /// start, hello, send, receive, lost, stale, reply, relay, expire,
    /// roles, state, fail.
    pub what: &'static str,
    pub bridge: usize,
    pub port: Option<usize>,
    pub bpdu: Option<Bpdu>,
    /// The bridge's ports after the step, when the step changed them.
    pub view: Option<BridgeView>,
}

/// The spanning tree computed directly, without messages.
#[derive(Clone, Debug, Serialize)]
pub struct Tree {
    pub root: usize,
    /// Root path cost of each bridge, or none if cut off from the root.
    pub cost: Vec<Option<u32>>,
    pub root_port: Vec<Option<usize>>,
    /// roles[b][k] for port k + 1 of bridge b.
    pub roles: Vec<Vec<Role>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Phase {
    pub from_ms: u64,
    /// When the last port changed role.
    pub roles_ms: u64,
    /// When the last port reached forwarding, or blocking.
    pub settled_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StpRun {
    pub events: Vec<StpEvent>,
    pub start: Vec<BridgeView>,
    pub end: Vec<BridgeView>,
    /// Before and, with a failure, after it.
    pub phases: Vec<Phase>,
    /// The direct computation over the links that are up at the end.
    pub direct: Tree,
    pub bpdus: u64,
}

/// Dijkstra from the bridge with the lowest ID, then the 802.1D choices:
/// each bridge's root port has the least (root path cost through it, sender
/// bridge ID, sender port ID, own port ID); each link's designated end has
/// the least (root path cost, bridge ID, port ID). In a part cut off from the
/// root, its own lowest ID is root.
pub fn stp_direct(ids: &[u64], links: &[Link], up: &[bool]) -> Tree {
    let n = ids.len();
    let ps = ports(n, links);
    let mut cost: Vec<Option<u32>> = vec![None; n];
    let mut part_root = vec![usize::MAX; n];
    // Components in order of their lowest ID.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&b| ids[b]);
    for &r in &order {
        if cost[r].is_some() {
            continue;
        }
        cost[r] = Some(0);
        part_root[r] = r;
        let mut done = vec![false; n];
        loop {
            let next = (0..n)
                .filter(|&b| !done[b] && part_root[b] == r && cost[b].is_some())
                .min_by_key(|&b| cost[b]);
            let Some(u) = next else { break };
            done[u] = true;
            for e in &ps[u] {
                if !up[e.link] {
                    continue;
                }
                let c = cost[u].unwrap() + e.cost;
                if cost[e.peer].is_none_or(|old| c < old) {
                    cost[e.peer] = Some(c);
                    part_root[e.peer] = r;
                }
            }
        }
    }
    let mut root_port = vec![None; n];
    let mut roles = vec![Vec::new(); n];
    for b in 0..n {
        let r = part_root[b];
        if r != b {
            root_port[b] = ps[b]
                .iter()
                .enumerate()
                .filter(|(_, e)| up[e.link])
                .min_by_key(|(k, e)| {
                    (
                        cost[e.peer].unwrap() + e.cost,
                        ids[e.peer],
                        e.peer_port,
                        k + 1,
                    )
                })
                .map(|(k, _)| k + 1);
        }
        let mine = |k: usize| (cost[b].unwrap(), ids[b], k + 1);
        roles[b] = ps[b]
            .iter()
            .enumerate()
            .map(|(k, e)| {
                if !up[e.link] {
                    Role::Disabled
                } else if root_port[b] == Some(k + 1) {
                    Role::Root
                } else if mine(k) < (cost[e.peer].unwrap(), ids[e.peer], e.peer_port) {
                    Role::Designated
                } else {
                    Role::Alternate
                }
            })
            .collect();
    }
    Tree {
        root: order[0],
        cost,
        root_port,
        roles,
    }
}

#[derive(Clone, Copy)]
struct Info {
    v: Vector,
    age: u64,
    at: u64,
    /// When it expires.
    until: u64,
}

struct Br {
    id: u64,
    info: Vec<Option<Info>>,
    role: Vec<Role>,
    state: Vec<PortState>,
    state_gen: Vec<u32>,
    root: u64,
    cost: u32,
    root_port: Option<usize>,
    hello_gen: u32,
}

enum StEv {
    Hello {
        b: usize,
        gen: u32,
    },
    Arrive {
        b: usize,
        k: usize,
        v: Vector,
        age: u64,
    },
    Expire {
        b: usize,
        k: usize,
        until: u64,
    },
    Timer {
        b: usize,
        k: usize,
        gen: u32,
    },
    Fail,
}

struct Stp<'a> {
    p: &'a StpParams,
    ps: Vec<Vec<End>>,
    br: Vec<Br>,
    link_up: Vec<bool>,
    q: Queue<StEv>,
    events: Vec<StpEvent>,
    bpdus: u64,
    last_role: u64,
    last_state: u64,
}

impl Stp<'_> {
    fn view(&self, b: usize) -> BridgeView {
        let s = &self.br[b];
        BridgeView {
            bridge: b,
            root: s.root,
            cost: s.cost,
            root_port: s.root_port,
            ports: self.ps[b]
                .iter()
                .enumerate()
                .map(|(k, e)| PortView {
                    port: k + 1,
                    link: e.link,
                    peer: e.peer,
                    role: s.role[k],
                    state: s.state[k],
                })
                .collect(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn log(
        &mut self,
        t: u64,
        step: &'static str,
        what: &'static str,
        b: usize,
        port: Option<usize>,
        bpdu: Option<Bpdu>,
        view: bool,
    ) {
        let view = view.then(|| self.view(b));
        self.events.push(StpEvent {
            t,
            step,
            what,
            bridge: b,
            port,
            bpdu,
            view,
        });
    }

    /// Recomputes the root, the root port and every port's role; starts or
    /// stops port timers. Returns whether the root or the path to it changed
    /// and whether any role changed.
    fn update(&mut self, t: u64, b: usize) -> (bool, bool) {
        let me = self.br[b].id;
        // B4. [Choose the root port.] Of everything heard, and the bridge's
        // own claim to be root, keep the best: least root ID, then least
        // cost to it (the cost the sender advertised plus this port's cost),
        // then least sender bridge ID, sender port ID and own port ID. The
        // port it came in on is the root port.
        let mut best = (me, 0u32, me, 0usize, 0usize);
        for (k, e) in self.ps[b].iter().enumerate() {
            if let (Some(i), Role::Root | Role::Designated | Role::Alternate) =
                (self.br[b].info[k], self.br[b].role[k])
            {
                let cand = (i.v.root, i.v.cost + e.cost, i.v.bridge, i.v.port, k + 1);
                if cand < best {
                    best = cand;
                }
            }
        }
        let s = &mut self.br[b];
        let rp = (best.4 > 0).then_some(best.4);
        let path_changed = (s.root, s.cost, s.root_port) != (best.0, best.1, rp);
        s.root = best.0;
        s.cost = best.1;
        s.root_port = rp;
        // B5. [Choose designated ports.] On each other port the bridge would
        // offer (root, its cost, its ID, the port's ID). If that beats what
        // the far end offers, or nothing has been heard there, the port is
        // designated: it carries the link's traffic towards and away from
        // the root. Otherwise it blocks, which breaks the loop through it.
        let mut roles_changed = false;
        for k in 0..self.ps[b].len() {
            let s = &mut self.br[b];
            if s.role[k] == Role::Disabled {
                continue;
            }
            let mine = Vector {
                root: s.root,
                cost: s.cost,
                bridge: me,
                port: k + 1,
            };
            let role = if rp == Some(k + 1) {
                Role::Root
            } else if s.info[k].is_none_or(|i| mine < i.v) {
                Role::Designated
            } else {
                Role::Alternate
            };
            if role == s.role[k] {
                continue;
            }
            roles_changed = true;
            s.role[k] = role;
            if role == Role::Alternate {
                s.state[k] = PortState::Blocking;
                s.state_gen[k] += 1;
            } else if s.state[k] == PortState::Blocking {
                self.listen(t, b, k);
            }
        }
        if roles_changed || path_changed {
            self.last_role = t;
            self.log(t, "B5", "roles", b, None, None, true);
        }
        (path_changed, roles_changed)
    }

    fn listen(&mut self, t: u64, b: usize, k: usize) {
        // B9. [Wait before forwarding.] A port that is to forward first
        // listens for a forward delay, taking part in the protocol but
        // passing no frames, then learns addresses for another, then
        // forwards. Information from far away has time to arrive before a
        // new path opens, so a transient loop does not storm.
        let s = &mut self.br[b];
        s.state[k] = PortState::Listening;
        s.state_gen[k] += 1;
        let gen = s.state_gen[k];
        self.q
            .push(t + self.p.forward_delay_ms, StEv::Timer { b, k, gen });
    }

    fn is_root(&self, b: usize) -> bool {
        self.br[b].root == self.br[b].id
    }

    fn send(&mut self, t: u64, b: usize, k: usize, step: &'static str, what: &'static str) {
        let s = &self.br[b];
        let age = match s.root_port {
            None => 0,
            Some(rp) => {
                let i = s.info[rp - 1].expect("a root port has information");
                i.age + (t - i.at) + 1000
            }
        };
        let v = Vector {
            root: s.root,
            cost: s.cost,
            bridge: s.id,
            port: k + 1,
        };
        let e = self.ps[b][k];
        self.bpdus += 1;
        self.q.push(
            t + self.p.delay_ms,
            StEv::Arrive {
                b: e.peer,
                k: e.peer_port - 1,
                v,
                age,
            },
        );
        self.log(
            t,
            step,
            what,
            b,
            Some(k + 1),
            Some(Bpdu { v, age_ms: age }),
            false,
        );
    }

    fn send_designated(&mut self, t: u64, b: usize, step: &'static str, what: &'static str) {
        for k in 0..self.ps[b].len() {
            if self.br[b].role[k] == Role::Designated {
                self.send(t, b, k, step, what);
            }
        }
    }

    fn start_hellos(&mut self, t: u64, b: usize) {
        self.br[b].hello_gen += 1;
        let gen = self.br[b].hello_gen;
        self.q.push(t, StEv::Hello { b, gen });
    }

    /// After a change: tell the designated ports, and say hello if this
    /// bridge has become root.
    fn after_change(&mut self, t: u64, b: usize, was_root: bool) {
        if self.is_root(b) && !was_root {
            self.start_hellos(t, b);
        } else {
            self.send_designated(t, b, "B6", "relay");
        }
    }

    fn run(&mut self) {
        while let Some((t, ev)) = self.q.pop() {
            if t > self.p.until_ms {
                break;
            }
            match ev {
                StEv::Hello { b, gen } => {
                    if gen != self.br[b].hello_gen || !self.is_root(b) {
                        continue;
                    }
                    // B2. [The root says hello.] A bridge that believes it
                    // is root sends a BPDU with cost 0 and message age 0 out
                    // of every designated port each hello time.
                    self.log(t, "B2", "hello", b, None, None, false);
                    self.send_designated(t, b, "B2", "send");
                    self.q.push(t + self.p.hello_ms, StEv::Hello { b, gen });
                }
                StEv::Arrive { b, k, v, age } => {
                    let e = self.ps[b][k];
                    if !self.link_up[e.link] {
                        self.log(
                            t,
                            "B10",
                            "lost",
                            b,
                            Some(k + 1),
                            Some(Bpdu { v, age_ms: age }),
                            false,
                        );
                        continue;
                    }
                    if self.br[b].role[k] == Role::Disabled {
                        continue;
                    }
                    // B3. [Receive a BPDU.] A link joins two ports, so what
                    // arrives replaces whatever that port heard before,
                    // better or worse. It is kept until its message age
                    // reaches the maximum age; a BPDU already that old is
                    // dropped, which ends one circling a loop with no root.
                    if age >= self.p.max_age_ms {
                        self.log(
                            t,
                            "B3",
                            "stale",
                            b,
                            Some(k + 1),
                            Some(Bpdu { v, age_ms: age }),
                            false,
                        );
                        continue;
                    }
                    let until = t + self.p.max_age_ms - age;
                    self.br[b].info[k] = Some(Info {
                        v,
                        age,
                        at: t,
                        until,
                    });
                    self.q.push(until, StEv::Expire { b, k, until });
                    self.log(
                        t,
                        "B3",
                        "receive",
                        b,
                        Some(k + 1),
                        Some(Bpdu { v, age_ms: age }),
                        false,
                    );
                    let was_root = self.is_root(b);
                    let (path, _) = self.update(t, b);
                    if self.br[b].role[k] == Role::Designated {
                        // B7. [Answer an inferior BPDU.] If this port's own
                        // offer is better than what arrived, the far end has
                        // stale or worse news; send it ours at once rather
                        // than wait for the next hello.
                        self.send(t, b, k, "B7", "reply");
                    }
                    if self.br[b].root_port == Some(k + 1) || path {
                        // B6. [Relay down the tree.] A BPDU on the root port
                        // (or any change in the path to the root) goes on out
                        // of every designated port, with this bridge's cost,
                        // ID and port, and its age raised by a second.
                        self.after_change(t, b, was_root);
                    }
                }
                StEv::Expire { b, k, until } => {
                    if self.br[b].info[k].is_none_or(|i| i.until != until) {
                        continue;
                    }
                    // B8. [Age out silence.] Information that reaches the
                    // maximum age is discarded, as if that port had heard
                    // nothing. This is how a bridge notices a failure it
                    // cannot sense directly.
                    self.br[b].info[k] = None;
                    self.log(t, "B8", "expire", b, Some(k + 1), None, false);
                    let was_root = self.is_root(b);
                    let (path, roles) = self.update(t, b);
                    if path || roles {
                        self.after_change(t, b, was_root);
                    }
                }
                StEv::Timer { b, k, gen } => {
                    if gen != self.br[b].state_gen[k] {
                        continue;
                    }
                    let next = if self.br[b].state[k] == PortState::Listening {
                        self.q
                            .push(t + self.p.forward_delay_ms, StEv::Timer { b, k, gen });
                        PortState::Learning
                    } else {
                        PortState::Forwarding
                    };
                    self.br[b].state[k] = next;
                    self.last_state = t;
                    self.log(t, "B9", "state", b, Some(k + 1), None, true);
                }
                StEv::Fail => {
                    let f = self
                        .p
                        .failure
                        .as_ref()
                        .expect("scheduled only with a failure");
                    // B10. [A link fails.] Frames and BPDUs on it are lost.
                    // If both ends sense it, their ports are disabled and
                    // what they heard there is dropped at once; if not,
                    // only ageing (B8) reveals it.
                    self.link_up[f.link] = false;
                    let lk = &self.p.links[f.link];
                    let ends = [
                        (lk.a, self.port_of(lk.a, f.link)),
                        (lk.b, self.port_of(lk.b, f.link)),
                    ];
                    let detected = f.detected;
                    self.last_role = t;
                    self.last_state = t;
                    for (b, k) in ends {
                        if detected {
                            let s = &mut self.br[b];
                            s.role[k] = Role::Disabled;
                            s.state[k] = PortState::Disabled;
                            s.state_gen[k] += 1;
                            s.info[k] = None;
                        }
                        self.log(t, "B10", "fail", b, Some(k + 1), None, true);
                    }
                    if detected {
                        for (b, _) in ends {
                            let was_root = self.is_root(b);
                            let (path, roles) = self.update(t, b);
                            if path || roles {
                                self.after_change(t, b, was_root);
                            }
                        }
                    }
                }
            }
        }
    }

    fn port_of(&self, b: usize, link: usize) -> usize {
        self.ps[b].iter().position(|e| e.link == link).unwrap()
    }
}

pub fn stp_run(p: &StpParams) -> Result<StpRun, String> {
    let n = p.bridges.len();
    check_topology(n, &p.links)?;
    if let Some(f) = &p.failure {
        if f.link >= p.links.len() {
            return Err("the failing link does not exist".into());
        }
    }
    for (i, b) in p.bridges.iter().enumerate() {
        if p.bridges[..i].iter().any(|o| o.id == b.id) {
            return Err("bridge IDs are unique".into());
        }
    }
    let ps = ports(n, &p.links);
    let br = (0..n)
        .map(|b| {
            let m = ps[b].len();
            Br {
                id: p.bridges[b].id,
                info: vec![None; m],
                role: vec![Role::Designated; m],
                state: vec![PortState::Blocking; m],
                state_gen: vec![0; m],
                root: p.bridges[b].id,
                cost: 0,
                root_port: None,
                hello_gen: 0,
            }
        })
        .collect();
    let mut s = Stp {
        p,
        ps,
        br,
        link_up: vec![true; p.links.len()],
        q: Queue::default(),
        events: Vec::new(),
        bpdus: 0,
        last_role: 0,
        last_state: 0,
    };
    for b in 0..n {
        // B1. [Every bridge starts as root.] Knowing no better, each bridge
        // claims to be root, makes every port designated and starts each
        // listening, then says hello.
        for k in 0..s.ps[b].len() {
            s.listen(0, b, k);
        }
        s.log(0, "B1", "start", b, None, None, true);
        s.start_hellos(0, b);
    }
    let start = (0..n).map(|b| s.view(b)).collect();
    let mut phases = Vec::new();
    if let Some(f) = &p.failure {
        s.q.push(f.at_ms, StEv::Fail);
    }
    s.run_phases(&mut phases);
    let end = (0..n).map(|b| s.view(b)).collect();
    let ids: Vec<u64> = p.bridges.iter().map(|b| b.id).collect();
    let direct = stp_direct(&ids, &p.links, &s.link_up);
    Ok(StpRun {
        events: s.events,
        start,
        end,
        phases,
        direct,
        bpdus: s.bpdus,
    })
}

impl Stp<'_> {
    /// Runs to the end, noting when roles and port states last changed
    /// before the failure and after it.
    fn run_phases(&mut self, phases: &mut Vec<Phase>) {
        self.run();
        let fail = self.p.failure.as_ref().map(|f| f.at_ms);
        let mut before = Phase {
            from_ms: 0,
            roles_ms: 0,
            settled_ms: 0,
        };
        let mut after = fail.map(|f| Phase {
            from_ms: f,
            roles_ms: f,
            settled_ms: f,
        });
        for e in &self.events {
            if !matches!(e.what, "roles" | "state" | "fail") {
                continue;
            }
            let ph = match (&mut after, fail) {
                (Some(a), Some(f)) if e.t >= f => a,
                _ => &mut before,
            };
            if e.what != "state" {
                ph.roles_ms = ph.roles_ms.max(e.t);
            }
            ph.settled_ms = ph.settled_ms.max(e.t);
        }
        phases.push(before);
        phases.extend(after);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::Link;
    use crate::sim::Rng;

    fn link(a: usize, b: usize) -> Link {
        Link { a, b, cost: 1 }
    }

    fn params(ids: &[u64], links: Vec<Link>) -> StpParams {
        StpParams {
            bridges: ids
                .iter()
                .enumerate()
                .map(|(i, &id)| Bridge {
                    name: format!("B{i}"),
                    id,
                })
                .collect(),
            links,
            hello_ms: 2000,
            max_age_ms: 20000,
            forward_delay_ms: 15000,
            delay_ms: 1,
            until_ms: 120_000,
            failure: None,
        }
    }

    /// Checks a run's end state: it matches the direct computation, every
    /// link has one designated end, and the forwarding links form a spanning
    /// tree of each part.
    fn check(p: &StpParams, run: &StpRun) {
        let tree = &run.direct;
        let ps = ports(p.bridges.len(), &p.links);
        let up: Vec<bool> = (0..p.links.len())
            .map(|l| {
                run.end[p.links[l].a]
                    .ports
                    .iter()
                    .any(|v| v.link == l && v.role != Role::Disabled)
            })
            .collect();
        for (b, v) in run.end.iter().enumerate() {
            let roles: Vec<Role> = v.ports.iter().map(|x| x.role).collect();
            assert_eq!(roles, tree.roles[b], "bridge {b}");
            assert_eq!(v.root_port, tree.root_port[b], "bridge {b}");
            assert_eq!(Some(v.cost), tree.cost[b], "bridge {b}");
            for x in &v.ports {
                let want = match x.role {
                    Role::Root | Role::Designated => PortState::Forwarding,
                    Role::Alternate => PortState::Blocking,
                    Role::Disabled => PortState::Disabled,
                };
                assert_eq!(x.state, want, "bridge {b} port {}", x.port);
            }
        }
        for (l, lk) in p.links.iter().enumerate() {
            if !up[l] {
                continue;
            }
            let role = |b: usize| {
                let k = ps[b].iter().position(|e| e.link == l).unwrap();
                run.end[b].ports[k].role
            };
            let designated = [role(lk.a), role(lk.b)]
                .iter()
                .filter(|&&r| r == Role::Designated)
                .count();
            assert_eq!(designated, 1, "link {l}");
        }
        // Forwarding links: n − (number of parts) of them, joining each part.
        let n = p.bridges.len();
        let fwd: Vec<&Link> = p
            .links
            .iter()
            .enumerate()
            .filter(|&(l, lk)| {
                up[l]
                    && [lk.a, lk.b].iter().all(|&b| {
                        let k = ps[b].iter().position(|e| e.link == l).unwrap();
                        run.end[b].ports[k].state == PortState::Forwarding
                    })
            })
            .map(|(_, lk)| lk)
            .collect();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut Vec<usize>, x: usize) -> usize {
            if p[x] != x {
                let r = find(p, p[x]);
                p[x] = r;
            }
            p[x]
        }
        for lk in &fwd {
            let (ra, rb) = (find(&mut parent, lk.a), find(&mut parent, lk.b));
            assert_ne!(ra, rb, "the forwarding links contain a loop");
            parent[ra] = rb;
        }
        let parts = (0..n).filter(|&b| tree.cost[b] == Some(0)).count();
        assert_eq!(fwd.len(), n - parts);
    }

    #[test]
    fn a_textbook_lan_converges_to_the_direct_tree() {
        // A ring of four with a chord; bridge 2 has the lowest ID.
        let p = params(
            &[40, 30, 10, 20],
            vec![
                link(0, 1),
                link(1, 2),
                link(2, 3),
                link(3, 0),
                Link {
                    a: 0,
                    b: 2,
                    cost: 3,
                },
            ],
        );
        let run = stp_run(&p).unwrap();
        assert_eq!(run.direct.root, 2);
        check(&p, &run);
        // Roles settle within milliseconds; forwarding takes two forward delays.
        let ph = &run.phases[0];
        assert!(ph.roles_ms < 100, "{ph:?}");
        assert_eq!(ph.settled_ms, 30_000);
    }

    #[test]
    fn ties_break_on_sender_bridge_then_port() {
        // Bridge 3 reaches root 0 at cost 2 through bridge 2 (ID 4, its
        // port 1) or bridge 1 (ID 5, port 2): the lower sender ID wins.
        let p = params(
            &[1, 5, 4, 9],
            vec![link(0, 2), link(0, 1), link(2, 3), link(1, 3)],
        );
        let run = stp_run(&p).unwrap();
        check(&p, &run);
        assert_eq!(run.end[3].root_port, Some(1));
        let p = params(
            &[1, 2, 4, 9],
            vec![link(0, 2), link(0, 1), link(2, 3), link(1, 3)],
        );
        let run = stp_run(&p).unwrap();
        assert_eq!(run.end[3].root_port, Some(2));
        // Two parallel links to the root: the root's lower port wins.
        let p = params(&[1, 2], vec![link(0, 1), link(1, 0)]);
        let run = stp_run(&p).unwrap();
        check(&p, &run);
        assert_eq!(run.end[1].root_port, Some(1));
        let roles: Vec<Role> = run.end[1].ports.iter().map(|x| x.role).collect();
        assert_eq!(roles, vec![Role::Root, Role::Alternate]);
    }

    #[test]
    fn random_lans_converge_before_and_after_a_failure() {
        let mut rng = Rng::new(7);
        for trial in 0..60 {
            let n = 3 + rng.upto(5) as usize;
            let mut links = Vec::new();
            for b in 1..n {
                links.push(Link {
                    a: rng.upto(b as u64 - 1) as usize,
                    b,
                    cost: [1, 1, 2, 4][rng.upto(3) as usize],
                });
            }
            for _ in 0..rng.upto(n as u64 + 1) {
                let a = rng.upto(n as u64 - 1) as usize;
                let b = rng.upto(n as u64 - 1) as usize;
                if a != b {
                    links.push(Link {
                        a,
                        b,
                        cost: [1, 2, 2, 4][rng.upto(3) as usize],
                    });
                }
            }
            let mut ids: Vec<u64> = (0..n as u64).map(|i| (32768 << 16) + 100 + i).collect();
            for i in (1..n).rev() {
                ids.swap(i, rng.upto(i as u64) as usize);
            }
            let mut p = params(&ids, links);
            let run = stp_run(&p).unwrap();
            check(&p, &run);
            // Now fail a link at 60 s, sensed or silent, and give it time.
            p.failure = Some(Failure {
                at_ms: 60_000,
                link: rng.upto(p.links.len() as u64 - 1) as usize,
                detected: trial % 2 == 0,
            });
            p.until_ms = 180_000;
            let run = stp_run(&p).unwrap();
            if p.failure.as_ref().unwrap().detected {
                check(&p, &run);
            } else {
                // A silent failure leaves the ports up; the tree must avoid it.
                let l = p.failure.as_ref().unwrap().link;
                let mut q = p.clone();
                q.links.remove(l);
                let ids: Vec<u64> = q.bridges.iter().map(|b| b.id).collect();
                let want = stp_direct(&ids, &q.links, &vec![true; q.links.len()]);
                for b in 0..n {
                    assert_eq!(
                        Some(run.end[b].cost),
                        want.cost[b],
                        "trial {trial} bridge {b}"
                    );
                }
            }
        }
    }

    #[test]
    fn recovery_takes_the_textbook_times() {
        // A triangle: root 0; bridge 2's root port is its link to 0.
        let mut p = params(&[1, 2, 3], vec![link(0, 1), link(1, 2), link(0, 2)]);
        p.failure = Some(Failure {
            at_ms: 60_000,
            link: 2,
            detected: true,
        });
        let run = stp_run(&p).unwrap();
        check(&p, &run);
        // Sensed: the blocked port opens after two forward delays.
        assert_eq!(run.phases[1].settled_ms - 60_000, 30_000);
        p.failure.as_mut().unwrap().detected = false;
        let run = stp_run(&p).unwrap();
        // Silent: first the stored root information ages out.
        let wait = run.phases[1].settled_ms - 60_000;
        assert!((48_000..=52_000).contains(&wait), "{wait}");
    }
}
