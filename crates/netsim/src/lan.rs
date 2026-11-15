//! Joining links into a LAN: switches that learn. The spanning tree that
//! keeps their frames from circling is in `stp.rs`.
//!
//! - A learning switch (a transparent bridge, IEEE 802.1D Clause 7) records
//!   the port each source address arrives on, forwards a frame only out of
//!   the port its destination was seen on, and floods it when the
//!   destination is unknown or broadcast. Entries age out, so a host that
//!   moves or falls silent is forgotten. Ethernet frames carry no hop count,
//!   so a loop of switches floods a broadcast for ever: a broadcast storm.
//! - The spanning tree protocol (Perlman 1985; IEEE 802.1D-1998 Clause 8)
//!   prevents that by blocking ports until the forwarding ports form a tree.
//!   Bridges exchange configuration BPDUs, each a priority vector (root
//!   bridge ID, root path cost, sender bridge ID, sender port ID); smaller is
//!   better, compared in that order. The bridge with the lowest ID becomes
//!   root; each other bridge keeps the port with the best path to it, each
//!   link keeps the end that offers the best path, and every other port
//!   blocks. Ports wait in listening and learning for a forward delay each
//!   before they forward, so that the whole tree settles first.
//!
//! Both models are exact: given the topology and the frames there is nothing
//! random left. The steps are lettered; the trace names the step behind each
//! event and the page highlights it in this source.

use serde::{Deserialize, Serialize};

use crate::sim::Queue;
use crate::stp::{stp_direct, Role};

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Host,
    Hub,
    Switch,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub kind: Kind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    pub a: usize,
    pub b: usize,
    /// The 802.1D path cost; unused by the learning switch.
    #[serde(default = "one")]
    pub cost: u32,
}

fn one() -> u32 {
    1
}

/// One end of a link, as seen from a node. A node's ports are numbered from
/// 1 in the order its links are listed.
#[derive(Clone, Copy, Debug)]
pub(crate) struct End {
    pub link: usize,
    pub peer: usize,
    /// The peer's port number for the same link.
    pub peer_port: usize,
    pub cost: u32,
}

/// Ports of every node: `ports(n, links)[i][k]` is port k + 1 of node i.
pub(crate) fn ports(n: usize, links: &[Link]) -> Vec<Vec<End>> {
    let mut ps: Vec<Vec<End>> = vec![Vec::new(); n];
    for (l, lk) in links.iter().enumerate() {
        let pa = ps[lk.a].len() + 1;
        let pb = ps[lk.b].len() + 1;
        ps[lk.a].push(End {
            link: l,
            peer: lk.b,
            peer_port: pb,
            cost: lk.cost,
        });
        ps[lk.b].push(End {
            link: l,
            peer: lk.a,
            peer_port: pa,
            cost: lk.cost,
        });
    }
    ps
}

pub(crate) fn check_topology(n: usize, links: &[Link]) -> Result<(), String> {
    for lk in links {
        if lk.a >= n || lk.b >= n || lk.a == lk.b {
            return Err("a link joins two different nodes".into());
        }
        if lk.cost == 0 {
            return Err("a path cost is at least 1".into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The learning switch
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameSpec {
    pub at_us: u64,
    /// The sending host.
    pub from: usize,
    /// The destination host, or none for broadcast.
    pub to: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwitchParams {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub frames: Vec<FrameSpec>,
    /// How long an entry lives without being refreshed (802.1D suggests 300 s).
    pub aging_us: u64,
    /// Time to cross one link, store and look up.
    pub hop_us: u64,
    /// Block the ports a converged spanning tree would block.
    #[serde(default)]
    pub stp: bool,
    /// Stop after this many link transmissions, so that a storm ends.
    pub max_sends: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    /// The host whose address this is.
    pub mac: usize,
    pub port: usize,
    /// When the entry was last refreshed.
    pub at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SwitchEvent {
    pub t: u64,
    pub step: &'static str,
    /// send, learn, refresh, move, filter, forward, flood, block, age,
    /// deliver, ignore, repeat, cap.
    pub what: &'static str,
    pub node: usize,
    /// The port the frame arrived on, or the entry's port for learn and age.
    pub port: Option<usize>,
    /// Ports the frame leaves by.
    pub out: Vec<usize>,
    /// The frame, by its index in the parameters.
    pub frame: usize,
    pub src: usize,
    pub dst: Option<usize>,
    /// Link transmissions so far, all frames together.
    pub sent: u64,
    /// The switch's whole table after the step, when the step changed it.
    pub table: Option<Vec<Entry>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SwitchRun {
    pub events: Vec<SwitchEvent>,
    pub sent: u64,
    /// Copies of each frame that reached its destination (broadcasts count
    /// every host but the sender).
    pub delivered: Vec<u64>,
    pub capped: bool,
    /// Ports blocked by the spanning tree, as (node, port).
    pub blocked: Vec<(usize, usize)>,
    pub tables: Vec<Vec<Entry>>,
}

enum SwEv {
    Send(usize),
    Arrive {
        node: usize,
        port: usize,
        frame: usize,
    },
    Age {
        node: usize,
        mac: usize,
        stamp: u64,
    },
}

pub fn switch_run(p: &SwitchParams) -> Result<SwitchRun, String> {
    let n = p.nodes.len();
    check_topology(n, &p.links)?;
    let ps = ports(n, &p.links);
    for f in &p.frames {
        let host = |i: usize| i < n && p.nodes[i].kind == Kind::Host;
        if !host(f.from) || f.to.is_some_and(|d| !host(d) || d == f.from) {
            return Err("frames go from one host to another, or to all".into());
        }
        if ps[f.from].len() != 1 {
            return Err("a host has exactly one link".into());
        }
    }
    let mut blocked = vec![Vec::new(); n];
    let mut blocked_list = Vec::new();
    if p.stp {
        // Bridge IDs follow the order of the switches in the list.
        let bridges: Vec<usize> = (0..n)
            .filter(|&i| p.nodes[i].kind == Kind::Switch)
            .collect();
        let idx = |i: usize| bridges.iter().position(|&b| b == i);
        let links: Vec<Link> = p
            .links
            .iter()
            .filter_map(|l| match (idx(l.a), idx(l.b)) {
                (Some(a), Some(b)) => Some(Link { a, b, cost: l.cost }),
                _ => None,
            })
            .collect();
        let ids: Vec<u64> = (0..bridges.len() as u64).collect();
        let tree = stp_direct(&ids, &links, &vec![true; links.len()]);
        let bps = ports(bridges.len(), &links);
        for (bi, &node) in bridges.iter().enumerate() {
            blocked[node] = vec![false; ps[node].len()];
            for (k, e) in bps[bi].iter().enumerate() {
                if tree.roles[bi][k] == Role::Alternate {
                    // Map the bridge-only link back to this node's port.
                    let orig = p
                        .links
                        .iter()
                        .enumerate()
                        .filter(|(_, l)| idx(l.a).is_some() && idx(l.b).is_some())
                        .nth(e.link)
                        .map(|(i, _)| i)
                        .unwrap();
                    let port = ps[node].iter().position(|pe| pe.link == orig).unwrap();
                    blocked[node][port] = true;
                    blocked_list.push((node, port + 1));
                }
            }
        }
    }
    let is_blocked =
        |node: usize, port: usize| blocked[node].get(port - 1).copied().unwrap_or(false);

    let mut q = Queue::default();
    for (i, f) in p.frames.iter().enumerate() {
        q.push(f.at_us, SwEv::Send(i));
    }
    let mut tables: Vec<Vec<Entry>> = vec![Vec::new(); n];
    let mut events = Vec::new();
    let mut sent = 0u64;
    let mut delivered = vec![0u64; p.frames.len()];
    let mut capped = false;

    while let Some((t, ev)) = q.pop() {
        match ev {
            SwEv::Send(i) => {
                let f = &p.frames[i];
                // S1. [A host sends.] The frame carries its source address and
                // its destination's, or the broadcast address, and nothing
                // that counts hops.
                let e = ps[f.from][0];
                sent += 1;
                q.push(
                    t + p.hop_us,
                    SwEv::Arrive {
                        node: e.peer,
                        port: e.peer_port,
                        frame: i,
                    },
                );
                events.push(SwitchEvent {
                    t,
                    step: "S1",
                    what: "send",
                    node: f.from,
                    port: None,
                    out: vec![1],
                    frame: i,
                    src: f.from,
                    dst: f.to,
                    sent,
                    table: None,
                });
            }
            SwEv::Age { node, mac, stamp } => {
                // S6. [Forget old entries.] An entry not refreshed for the
                // ageing time is removed, so a host that moved or went quiet
                // is flooded to again rather than sent into the void.
                if let Some(pos) = tables[node]
                    .iter()
                    .position(|e| e.mac == mac && e.at == stamp)
                {
                    let port = tables[node][pos].port;
                    tables[node].remove(pos);
                    events.push(SwitchEvent {
                        t,
                        step: "S6",
                        what: "age",
                        node,
                        port: Some(port),
                        out: vec![],
                        frame: usize::MAX,
                        src: mac,
                        dst: None,
                        sent,
                        table: Some(tables[node].clone()),
                    });
                }
            }
            SwEv::Arrive { node, port, frame } => {
                let f = &p.frames[frame];
                let mut ev = SwitchEvent {
                    t,
                    step: "",
                    what: "",
                    node,
                    port: Some(port),
                    out: vec![],
                    frame,
                    src: f.from,
                    dst: f.to,
                    sent,
                    table: None,
                };
                let mut out = Vec::new();
                match p.nodes[node].kind {
                    Kind::Host => {
                        // S7. [Hosts keep their own frames.] A host keeps a
                        // frame addressed to it or to everyone and ignores
                        // the rest.
                        ev.step = "S7";
                        if f.to.is_none() || f.to == Some(node) {
                            ev.what = "deliver";
                            delivered[frame] += 1;
                        } else {
                            ev.what = "ignore";
                        }
                    }
                    Kind::Hub => {
                        // S8. [A hub repeats.] A hub is a physical-layer
                        // device: it copies the signal out of every other
                        // port and learns nothing.
                        ev.step = "S8";
                        ev.what = "repeat";
                        out = (1..=ps[node].len()).filter(|&k| k != port).collect();
                    }
                    Kind::Switch if is_blocked(node, port) => {
                        // S9. [Blocked ports.] A port the spanning tree
                        // blocks drops data frames, without learning from
                        // them.
                        ev.step = "S9";
                        ev.what = "block";
                    }
                    Kind::Switch => {
                        // S2. [Learn the source.] The frame's source lives
                        // somewhere out of the arrival port: record that, with
                        // the time, replacing what was known.
                        let table = &mut tables[node];
                        let (what, stamp) = match table.iter_mut().find(|e| e.mac == f.from) {
                            Some(e) => {
                                let what = if e.port == port { "refresh" } else { "move" };
                                e.port = port;
                                e.at = t;
                                (what, t)
                            }
                            None => {
                                table.push(Entry {
                                    mac: f.from,
                                    port,
                                    at: t,
                                });
                                ("learn", t)
                            }
                        };
                        q.push(
                            stamp + p.aging_us,
                            SwEv::Age {
                                node,
                                mac: f.from,
                                stamp,
                            },
                        );
                        events.push(SwitchEvent {
                            step: "S2",
                            what,
                            table: Some(table.clone()),
                            ..ev.clone()
                        });
                        // S3. [Look up the destination.] Known on the
                        // arrival port: the destination already has the frame
                        // from the segment it came in on, so filter it.
                        // Known elsewhere: forward out of that port alone.
                        // Unknown or broadcast: flood out of every port but
                        // the one it came in on.
                        let known =
                            f.to.and_then(|d| table.iter().find(|e| e.mac == d).map(|e| e.port));
                        let open = |k: usize| !is_blocked(node, k);
                        ev.step = "S3";
                        match known {
                            Some(k) if k == port => ev.what = "filter",
                            Some(k) => {
                                ev.what = "forward";
                                if open(k) {
                                    out = vec![k];
                                }
                            }
                            None => {
                                ev.what = "flood";
                                out = (1..=ps[node].len())
                                    .filter(|&k| k != port && open(k))
                                    .collect();
                            }
                        }
                    }
                }
                if sent + out.len() as u64 > p.max_sends {
                    events.push(SwitchEvent { what: "cap", ..ev });
                    capped = true;
                    break;
                }
                for &k in &out {
                    let e = ps[node][k - 1];
                    sent += 1;
                    q.push(
                        t + p.hop_us,
                        SwEv::Arrive {
                            node: e.peer,
                            port: e.peer_port,
                            frame,
                        },
                    );
                }
                ev.sent = sent;
                ev.out = out;
                events.push(ev);
            }
        }
    }
    Ok(SwitchRun {
        events,
        sent,
        delivered,
        capped,
        blocked: blocked_list,
        tables,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> Node {
        Node {
            name: name.into(),
            kind: Kind::Host,
        }
    }
    fn sw(name: &str) -> Node {
        Node {
            name: name.into(),
            kind: Kind::Switch,
        }
    }
    fn link(a: usize, b: usize) -> Link {
        Link { a, b, cost: 1 }
    }
    fn frame(at_us: u64, from: usize, to: Option<usize>) -> FrameSpec {
        FrameSpec { at_us, from, to }
    }

    /// One switch (node 0) with hosts A, B, C on ports 1, 2, 3.
    fn star(frames: Vec<FrameSpec>) -> SwitchParams {
        SwitchParams {
            nodes: vec![sw("S"), host("A"), host("B"), host("C")],
            links: vec![link(0, 1), link(0, 2), link(0, 3)],
            frames,
            aging_us: 1000,
            hop_us: 10,
            stp: false,
            max_sends: 1000,
        }
    }

    fn decision(run: &SwitchRun, frame: usize) -> &SwitchEvent {
        run.events
            .iter()
            .find(|e| e.frame == frame && e.step == "S3")
            .unwrap()
    }

    #[test]
    fn unknown_destinations_flood_and_learned_ones_forward() {
        let run = switch_run(&star(vec![frame(0, 1, Some(2)), frame(100, 2, Some(1))])).unwrap();
        // A → B, B unknown: every port but A's.
        let d = decision(&run, 0);
        assert_eq!(
            (d.what, d.port, d.out.clone()),
            ("flood", Some(1), vec![2, 3])
        );
        // B → A, A learned on port 1: port 1 only.
        let d = decision(&run, 1);
        assert_eq!((d.what, d.out.clone()), ("forward", vec![1]));
        assert_eq!(run.delivered, vec![1, 1]);
        // The table as the second frame left it (both entries age out later).
        let t = run
            .events
            .iter()
            .rfind(|e| e.node == 0 && e.table.is_some() && e.what != "age")
            .unwrap()
            .table
            .as_ref()
            .unwrap();
        assert_eq!(
            t.iter().map(|e| (e.mac, e.port)).collect::<Vec<_>>(),
            vec![(1, 1), (2, 2)]
        );
        // C saw the flooded copy and ignored it; nothing else reached C.
        let at_c: Vec<&str> = run
            .events
            .iter()
            .filter(|e| e.node == 3)
            .map(|e| e.what)
            .collect();
        assert_eq!(at_c, vec!["ignore"]);
    }

    #[test]
    fn broadcasts_flood_even_when_learned() {
        let run = switch_run(&star(vec![frame(0, 2, None), frame(100, 1, None)])).unwrap();
        assert_eq!(decision(&run, 1).out, vec![2, 3]);
        assert_eq!(run.delivered, vec![2, 2]);
    }

    #[test]
    fn a_destination_on_the_arrival_port_is_filtered() {
        // A and B share a hub on switch port 1; C is on port 2.
        let p = SwitchParams {
            nodes: vec![
                sw("S"),
                Node {
                    name: "H".into(),
                    kind: Kind::Hub,
                },
                host("A"),
                host("B"),
                host("C"),
            ],
            links: vec![link(0, 1), link(0, 4), link(1, 2), link(1, 3)],
            frames: vec![frame(0, 3, Some(4)), frame(100, 2, Some(3))],
            ..star(vec![])
        };
        let run = switch_run(&p).unwrap();
        let d = decision(&run, 1);
        assert_eq!((d.what, d.port, d.out.len()), ("filter", Some(1), 0));
        assert_eq!(run.delivered, vec![1, 1]);
    }

    #[test]
    fn entries_age_out_and_flooding_resumes() {
        let run = switch_run(&star(vec![
            frame(0, 1, Some(2)),
            frame(100, 2, Some(1)),
            frame(2000, 3, Some(1)),
        ]))
        .unwrap();
        let aged: Vec<(u64, usize)> = run
            .events
            .iter()
            .filter(|e| e.what == "age")
            .map(|e| (e.t, e.src))
            .collect();
        assert_eq!(aged, vec![(1010, 1), (1110, 2), (3010, 3)]);
        assert_eq!(decision(&run, 2).what, "flood");
    }

    /// Four switches, each joined to every other, one host on each.
    fn k4(stp: bool) -> SwitchParams {
        let mut nodes: Vec<Node> = (1..=4).map(|i| sw(&format!("S{i}"))).collect();
        nodes.extend(["A", "B", "C", "D"].map(host));
        let mut links = vec![];
        for a in 0..4 {
            for b in a + 1..4 {
                links.push(link(a, b));
            }
        }
        for i in 0..4 {
            links.push(link(i, 4 + i));
        }
        SwitchParams {
            nodes,
            links,
            frames: vec![frame(0, 4, None)],
            aging_us: 1_000_000,
            hop_us: 10,
            stp,
            max_sends: 2000,
        }
    }

    #[test]
    fn a_loop_without_stp_storms_and_with_it_does_not() {
        let run = switch_run(&k4(false)).unwrap();
        assert!(run.capped);
        // Copies in flight grow: count switch-to-switch sends per hop time.
        let per_hop: Vec<u64> = (1..6)
            .map(|h| {
                run.events
                    .iter()
                    .filter(|e| e.t == h * 10 && e.node < 4)
                    .map(|e| e.out.iter().filter(|&&k| k <= 3).count() as u64)
                    .sum()
            })
            .collect();
        assert!(per_hop.windows(2).all(|w| w[1] > w[0]), "{per_hop:?}");
        // The table entry for A moves as copies arrive from every side.
        assert!(run.events.iter().any(|e| e.what == "move"));
        let run = switch_run(&k4(true)).unwrap();
        assert!(!run.capped);
        assert_eq!(run.delivered, vec![3]);
        assert_eq!(run.blocked.len(), 3);
        // The root S1 floods to all three; S2 and S3 send on into the
        // blocked ends of the other three links, where the copies stop.
        // Every host but A gets exactly one copy.
        assert_eq!(run.sent, 1 + 3 + 3 + 2 + 1);
    }
}
