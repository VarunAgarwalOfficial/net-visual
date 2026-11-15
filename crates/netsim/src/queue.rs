//! Queueing and delay at one output port of a router.
//!
//! Packets from up to four flows cross the same path. A flow may first pass a
//! shaper at its source (a token bucket or a leaky bucket). Each packet then
//! reaches the router, is processed for a fixed time, waits in the output
//! queue, is transmitted onto the link at its rate, and crosses the link at
//! the speed of signals in the medium. Those are the four delays of a hop:
//! processing, queueing, transmission (L/R) and propagation (d/s).
//!
//! The output queue holds packets in a shared buffer and sends them by one of
//! three disciplines: first in, first out; strict priority (never interrupting
//! a packet already on the wire); or weighted fair queueing, which sends
//! packets in the order they would finish under generalised processor
//! sharing (GPS), the fluid ideal in which every backlogged flow is served at
//! once in proportion to its weight (Demers, Keshav and Shenker 1989; Parekh
//! and Gallager 1993). The model runs that fluid system alongside the real one
//! for every discipline, so each packet's GPS finishing time can be compared
//! with its real one.
//!
//! Arrivals and packet sizes are drawn before the run from seeded streams of
//! their own, one pair per flow, so changing the discipline, the buffer or the
//! link sends exactly the same packets. Times are integer microseconds.
//!
//! The steps are lettered; the trace names the step behind each event and the
//! page highlights it in this source.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Arrivals {
    /// A Poisson process: independent exponential gaps with mean 1/rate.
    #[default]
    Poisson,
    /// Exactly one packet every 1/rate.
    Periodic,
    /// Bursts: packets every 1/rate for `on_us`, then silence for `off_us`.
    Onoff,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Sizes {
    /// Every packet is `size_bytes` long.
    #[default]
    Fixed,
    /// Exponential lengths with mean `size_bytes`, rounded to whole bytes:
    /// Kleinrock's assumption, which makes transmission times exponential.
    Exp,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Discipline {
    #[default]
    Fifo,
    /// The waiting packet of the flow with the smallest `priority` number goes
    /// first; a packet already being sent is never interrupted.
    Priority,
    /// Weighted fair queueing: smallest GPS finish tag first.
    Wfq,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShaperKind {
    #[default]
    None,
    /// Tokens arrive at `rate_bps` into a bucket of `bucket_bytes`; a packet
    /// leaves when the bucket holds as many tokens as it has bytes.
    Token,
    /// Packets leave at `rate_bps`, one after another, whatever the input:
    /// a queue of at most `bucket_bytes` drained at a constant rate.
    Leaky,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Shaper {
    pub kind: ShaperKind,
    pub rate_bps: u64,
    pub bucket_bytes: u64,
    /// Token bucket only: drop a packet that finds too few tokens (policing)
    /// instead of holding it until there are enough (shaping).
    #[serde(default)]
    pub police: bool,
}

fn one() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Flow {
    pub name: String,
    #[serde(default)]
    pub arrivals: Arrivals,
    /// Packets per second: the mean for Poisson, the rate within a burst for
    /// on-off.
    pub rate_pps: f64,
    #[serde(default)]
    pub on_us: u64,
    #[serde(default)]
    pub off_us: u64,
    #[serde(default)]
    pub sizes: Sizes,
    pub size_bytes: u32,
    #[serde(default = "one")]
    pub weight: u32,
    /// Smaller is more urgent.
    #[serde(default)]
    pub priority: u32,
    #[serde(default)]
    pub start_us: u64,
    /// How many packets the flow sends.
    pub packets: usize,
    #[serde(default)]
    pub shaper: Shaper,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Params {
    pub flows: Vec<Flow>,
    #[serde(default)]
    pub discipline: Discipline,
    /// The output link's rate R.
    pub rate_bps: u64,
    /// Fixed processing time at the router.
    pub proc_us: u64,
    /// Link length d and signal speed s.
    pub distance_m: u64,
    pub speed_mps: u64,
    /// Packets that may wait (not counting the one being sent); 0 for no limit.
    pub buffer_pkts: usize,
    pub seed: u64,
    /// Record the trace of events, which the page needs and sweeps do not.
    #[serde(default = "yes")]
    pub trace: bool,
}

/// One packet's journey. Times are absent where it never got that far.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Packet {
    pub id: usize,
    pub flow: usize,
    pub size_bytes: u32,
    /// Created at the source.
    pub t_arrive: u64,
    /// Let through by the shaper (the creation time if there is none).
    pub t_shaped: Option<u64>,
    /// Joined the output queue, after processing.
    pub t_join: Option<u64>,
    /// First bit onto the link.
    pub t_start: Option<u64>,
    /// Last bit onto the link.
    pub t_depart: Option<u64>,
    /// Last bit at the far end.
    pub t_reach: Option<u64>,
    /// "policer", "bucket" (a full leaky bucket) or "buffer".
    pub dropped: Option<&'static str>,
    /// Weighted fair queueing's finish tag, in bits per unit of weight.
    pub tag: f64,
    /// When the packet would have finished under GPS, in microseconds.
    pub gps_finish: f64,
}

/// A row of the trace.
#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: u64,
    pub step: &'static str,
    pub packet: usize,
    /// What happened, for steps with more than one outcome: "released",
    /// "held", "dropped", "joined".
    pub what: &'static str,
    /// Packets waiting in the output queue after the event.
    pub waiting: usize,
    /// Tokens in the packet's flow's bucket after the event, in bytes, for a
    /// token bucket.
    pub tokens: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct FlowStats {
    pub sent: usize,
    pub served: usize,
    pub dropped: usize,
    pub bytes: u64,
    /// Mean time from joining the queue to the first bit on the link.
    pub wait_us: f64,
    /// Mean time from joining the queue to the last bit on the link.
    pub system_us: f64,
    /// Mean time held by the shaper.
    pub shaper_us: f64,
    /// Mean time from creation to the last bit at the far end.
    pub total_us: f64,
    pub max_wait_us: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub served: usize,
    pub dropped: usize,
    /// Mean waiting time Wq, and mean time in the system W = Wq + L/R.
    pub wait_us: f64,
    pub system_us: f64,
    pub trans_us: f64,
    pub total_us: f64,
    /// Time averages over [0, end] of the number waiting (Lq) and the number
    /// waiting or being sent (L), from the queue's own record of changes.
    pub lq: f64,
    pub l: f64,
    /// Packets that joined the queue per second of the run.
    pub lambda_pps: f64,
    /// Fraction of the run the link was busy.
    pub busy: f64,
    pub max_waiting: usize,
    pub prop_us: u64,
    /// The last departure.
    pub end_us: u64,
    pub flows: Vec<FlowStats>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Run {
    pub packets: Vec<Packet>,
    pub events: Vec<Event>,
    pub stats: Stats,
}

/// Transmission time of `bytes` at `rate_bps`, to the nearest microsecond.
pub fn trans_us(bytes: u32, rate_bps: u64) -> u64 {
    ((bytes as u128 * 8_000_000 + rate_bps as u128 / 2) / rate_bps as u128).max(1) as u64
}

/// Propagation time d/s, to the nearest microsecond.
pub fn prop_us(p: &Params) -> u64 {
    ((p.distance_m as u128 * 1_000_000 + p.speed_mps as u128 / 2) / p.speed_mps as u128) as u64
}

/// G1. [Generate the arrivals.] Each flow draws its creation times from one
/// seeded stream and its sizes from another, so the same seed gives the
/// same packets whatever the rest of the setup.
fn generate(p: &Params) -> Vec<Packet> {
    let mut out = Vec::new();
    for (k, f) in p.flows.iter().enumerate() {
        let salt = (k as u64 + 1).wrapping_mul(0xA24B_AED4_963E_E407);
        let mut times = Rng::new(p.seed ^ salt);
        let mut sizes = Rng::new(p.seed ^ salt.rotate_left(17) ^ 0x5851_F42D);
        let gap = 1e6 / f.rate_pps;
        let per_burst = ((f.on_us as f64 / gap).floor() as usize).max(1);
        let mut clock = 0.0;
        for i in 0..f.packets {
            let t = match f.arrivals {
                Arrivals::Poisson => {
                    clock += times.exp(gap);
                    clock
                }
                Arrivals::Periodic => i as f64 * gap,
                Arrivals::Onoff => {
                    let cycle = (i / per_burst) as f64 * (f.on_us + f.off_us) as f64;
                    cycle + (i % per_burst) as f64 * gap
                }
            };
            let size = match f.sizes {
                Sizes::Fixed => f.size_bytes,
                Sizes::Exp => (sizes.exp(f.size_bytes as f64).round() as u32).max(1),
            };
            out.push(Packet {
                id: 0,
                flow: k,
                size_bytes: size,
                t_arrive: f.start_us + t.round() as u64,
                t_shaped: None,
                t_join: None,
                t_start: None,
                t_depart: None,
                t_reach: None,
                dropped: None,
                tag: 0.0,
                gps_finish: 0.0,
            });
        }
    }
    // Number packets in order of creation; ties go to the lower flow.
    out.sort_by_key(|q| (q.t_arrive, q.flow));
    for (i, q) in out.iter_mut().enumerate() {
        q.id = i;
    }
    out
}

enum Ev {
    /// A packet is created at its source.
    Arrive(usize),
    /// A token bucket may now let the head of flow k's queue go.
    Tokens(usize),
    /// A packet reaches the output queue, processed.
    Join(usize),
    /// The link finishes sending a packet.
    Finish(usize),
    /// A packet's last bit reaches the far end.
    Reach(usize),
}

/// Token bucket state, exact in integers: tokens are counted in bits times
/// 10^6, so `rate_bps` of them arrive every microsecond.
struct Bucket {
    tokens: u128,
    at: u64,
    held: VecDeque<usize>,
    /// Leaky bucket: when the last packet let through finishes draining.
    drained: u64,
}

/// The fluid GPS system run beside the real one.
struct Gps {
    /// Virtual time V, in bits per unit weight.
    v: f64,
    /// The real time V was last brought up to, in microseconds.
    at: f64,
    /// Each flow's unfinished packets in the fluid system: (tag, packet).
    pending: Vec<VecDeque<(f64, usize)>>,
    last_tag: Vec<f64>,
}

struct Sim<'a> {
    p: &'a Params,
    packets: Vec<Packet>,
    queue: Queue<Ev>,
    buckets: Vec<Bucket>,
    gps: Gps,
    /// Waiting packets, smallest key first.
    waiting: BinaryHeap<Reverse<(u64, u64, usize)>>,
    busy: bool,
    events: Vec<Event>,
}

impl Sim<'_> {
    fn record(&mut self, t: u64, step: &'static str, packet: usize, what: &'static str) {
        if !self.p.trace {
            return;
        }
        let f = self.packets[packet].flow;
        let tokens = (self.p.flows[f].shaper.kind == ShaperKind::Token)
            .then(|| self.buckets[f].tokens as f64 / 8e6);
        self.events.push(Event {
            t,
            step,
            packet,
            what,
            waiting: self.waiting.len(),
            tokens,
        });
    }

    /// Tokens in flow k's bucket brought up to time t, capped at the bucket.
    fn fill(&mut self, k: usize, t: u64) {
        let s = self.p.flows[k].shaper;
        let b = &mut self.buckets[k];
        let cap = s.bucket_bytes as u128 * 8_000_000;
        b.tokens = (b.tokens + s.rate_bps as u128 * (t - b.at) as u128).min(cap);
        b.at = t;
    }

    /// A1. [Arrive.] A packet is created at its source and offered to the
    /// flow's shaper, if it has one, or sent straight to the router.
    fn arrive(&mut self, t: u64, id: usize) {
        let k = self.packets[id].flow;
        let s = self.p.flows[k].shaper;
        match s.kind {
            ShaperKind::None => {
                self.record(t, "A1", id, "released");
                self.release(t, id);
            }
            ShaperKind::Token => {
                // B1. [Token bucket.] With tokens for the whole packet and
                // nobody ahead of it, it goes now and spends them. Otherwise
                // a policer drops it, and a shaper holds it in line until the
                // tokens have built up.
                self.fill(k, t);
                let need = self.packets[id].size_bytes as u128 * 8_000_000;
                if self.buckets[k].held.is_empty() && self.buckets[k].tokens >= need {
                    self.buckets[k].tokens -= need;
                    self.record(t, "B1", id, "released");
                    self.release(t, id);
                } else if s.police {
                    self.packets[id].dropped = Some("policer");
                    self.record(t, "B1", id, "dropped");
                } else {
                    self.buckets[k].held.push_back(id);
                    self.record(t, "B1", id, "held");
                    if self.buckets[k].held.len() == 1 {
                        self.schedule_tokens(k, t);
                    }
                }
            }
            ShaperKind::Leaky => {
                // B2. [Leaky bucket.] The bucket drains at the shaper's rate,
                // one packet after another, so a packet leaves once every
                // byte before it and its own have drained. A packet that
                // would overfill the bucket is dropped.
                let b = &self.buckets[k];
                let behind: u64 = b
                    .held
                    .iter()
                    .filter(|&&q| self.packets[q].t_shaped.is_none_or(|x| x > t))
                    .map(|&q| self.packets[q].size_bytes as u64)
                    .sum();
                if behind + self.packets[id].size_bytes as u64 > s.bucket_bytes {
                    self.packets[id].dropped = Some("bucket");
                    self.record(t, "B2", id, "dropped");
                    return;
                }
                let done = b.drained.max(t) + trans_us(self.packets[id].size_bytes, s.rate_bps);
                self.buckets[k].drained = done;
                self.buckets[k].held.push_back(id);
                self.packets[id].t_shaped = Some(done);
                self.record(t, "B2", id, "held");
                self.queue.push(done + self.p.proc_us, Ev::Join(id));
                // Forget packets that have left, so the bucket stays short.
                let packets = &self.packets;
                self.buckets[k]
                    .held
                    .retain(|&q| packets[q].t_shaped.is_some_and(|x| x > t));
            }
        }
    }

    /// When the head of flow k's token-bucket queue will have its tokens.
    fn schedule_tokens(&mut self, k: usize, t: u64) {
        let Some(&head) = self.buckets[k].held.front() else {
            return;
        };
        let need = self.packets[head].size_bytes as u128 * 8_000_000;
        let have = self.buckets[k].tokens;
        let r = self.p.flows[k].shaper.rate_bps as u128;
        let wait = if have >= need {
            0
        } else {
            (need - have).div_ceil(r) as u64
        };
        self.queue.push(t + wait, Ev::Tokens(k));
    }

    /// The tokens for the head of flow k's line have arrived.
    fn tokens(&mut self, t: u64, k: usize) {
        self.fill(k, t);
        let Some(&head) = self.buckets[k].held.front() else {
            return;
        };
        let need = self.packets[head].size_bytes as u128 * 8_000_000;
        if self.buckets[k].tokens >= need {
            self.buckets[k].tokens -= need;
            self.buckets[k].held.pop_front();
            self.record(t, "B1", head, "released");
            self.release(t, head);
        }
        self.schedule_tokens(k, t);
    }

    /// The packet leaves its source for the router, which takes `proc_us`
    /// to process it.
    fn release(&mut self, t: u64, id: usize) {
        self.packets[id].t_shaped = Some(t);
        self.queue.push(t + self.p.proc_us, Ev::Join(id));
    }

    /// W2. [Advance GPS's virtual time.] In the fluid system the link's rate
    /// R is shared among the flows with unfinished packets in proportion to
    /// their weights, so V, the service each unit of weight has received,
    /// grows at R divided by the sum of their weights. Whenever V passes a
    /// packet's tag that packet finishes in the fluid system, and its flow
    /// may drop out of the sum.
    fn advance(&mut self, t: f64) {
        let r = self.p.rate_bps as f64 / 1e6;
        loop {
            let g = &mut self.gps;
            let mut weight = 0.0;
            let mut next = f64::INFINITY;
            for (k, q) in g.pending.iter().enumerate() {
                if let Some(&(tag, _)) = q.front() {
                    weight += self.p.flows[k].weight as f64;
                    next = next.min(tag);
                }
            }
            if weight == 0.0 {
                g.at = g.at.max(t);
                return;
            }
            let reach = g.at + (next - g.v) * weight / r;
            if reach <= t {
                g.v = next;
                g.at = reach;
                for q in g.pending.iter_mut() {
                    while let Some(&(tag, id)) = q.front() {
                        if tag > next {
                            break;
                        }
                        self.packets[id].gps_finish = reach;
                        q.pop_front();
                    }
                }
            } else {
                g.v += (t - g.at) * r / weight;
                g.at = t;
                return;
            }
        }
    }

    /// P1. [Process and join.] The router has processed the packet. If the
    /// buffer is full it is dropped (drop-tail); otherwise it joins the
    /// queue and, if the link is idle, goes straight onto it.
    fn join(&mut self, t: u64, id: usize) {
        self.packets[id].t_join = Some(t);
        if self.p.buffer_pkts > 0 && self.waiting.len() >= self.p.buffer_pkts {
            self.packets[id].dropped = Some("buffer");
            self.record(t, "P1", id, "dropped");
            return;
        }
        // W1. [Tag for fair queueing.] The packet's finish tag is where V
        // will stand when it finishes in the fluid system: it starts when
        // its flow's previous packet finishes or now, whichever is later,
        // and needs its length divided by its flow's weight.
        self.advance(t as f64);
        let k = self.packets[id].flow;
        let g = &mut self.gps;
        let tag = g.last_tag[k].max(g.v)
            + self.packets[id].size_bytes as f64 * 8.0 / self.p.flows[k].weight as f64;
        g.last_tag[k] = tag;
        g.pending[k].push_back((tag, id));
        self.packets[id].tag = tag;

        let key = match self.p.discipline {
            Discipline::Fifo => 0,
            Discipline::Priority => self.p.flows[k].priority as u64,
            // Tags are non-negative, and for those the bits order as the numbers.
            Discipline::Wfq => tag.to_bits(),
        };
        self.waiting.push(Reverse((key, id as u64, id)));
        self.record(t, "P1", id, "joined");
        if !self.busy {
            self.start(t);
        }
    }

    /// S1. [Choose the next packet.] The link is free: send the waiting
    /// packet that comes first under the discipline (the earliest to join,
    /// the most urgent flow, or the smallest finish tag), and note when its
    /// last bit will be on the wire, L/R later.
    fn start(&mut self, t: u64) {
        let Some(Reverse((_, _, id))) = self.waiting.pop() else {
            self.busy = false;
            return;
        };
        self.busy = true;
        self.packets[id].t_start = Some(t);
        self.record(t, "S1", id, "");
        let done = t + trans_us(self.packets[id].size_bytes, self.p.rate_bps);
        self.queue.push(done, Ev::Finish(id));
    }

    /// S2. [Last bit out.] The packet is on the wire, and its last bit will
    /// reach the far end d/s later. The link takes the next packet.
    fn finish(&mut self, t: u64, id: usize) {
        self.packets[id].t_depart = Some(t);
        self.record(t, "S2", id, "");
        self.queue.push(t + prop_us(self.p), Ev::Reach(id));
        self.start(t);
    }
}

/// Run every packet through shaper, router, queue and link.
pub fn run(p: &Params) -> Run {
    let packets = generate(p);
    let flows = p.flows.len();
    let mut sim = Sim {
        p,
        queue: Queue::default(),
        buckets: p
            .flows
            .iter()
            .map(|f| Bucket {
                // A token bucket starts full.
                tokens: f.shaper.bucket_bytes as u128 * 8_000_000,
                at: 0,
                held: VecDeque::new(),
                drained: 0,
            })
            .collect(),
        gps: Gps {
            v: 0.0,
            at: 0.0,
            pending: vec![VecDeque::new(); flows],
            last_tag: vec![0.0; flows],
        },
        waiting: BinaryHeap::new(),
        busy: false,
        events: Vec::new(),
        packets,
    };
    for q in &sim.packets {
        sim.queue.push(q.t_arrive, Ev::Arrive(q.id));
    }
    while let Some((t, ev)) = sim.queue.pop() {
        match ev {
            Ev::Arrive(id) => sim.arrive(t, id),
            Ev::Tokens(k) => sim.tokens(t, k),
            Ev::Join(id) => sim.join(t, id),
            Ev::Finish(id) => sim.finish(t, id),
            Ev::Reach(id) => {
                // R1. [Reach the far end.] The last bit arrives: the packet's
                // four delays are complete.
                sim.packets[id].t_reach = Some(t);
                sim.record(t, "R1", id, "");
            }
        }
    }
    // Let the fluid system finish too.
    sim.advance(f64::INFINITY);
    let stats = stats(p, &sim.packets);
    Run {
        packets: sim.packets,
        events: sim.events,
        stats,
    }
}

fn stats(p: &Params, packets: &[Packet]) -> Stats {
    let mut s = Stats {
        prop_us: prop_us(p),
        flows: vec![FlowStats::default(); p.flows.len()],
        ..Stats::default()
    };
    // Every change to the number waiting and the number in the system,
    // swept in time order; departures before arrivals at the same instant.
    let mut changes: Vec<(u64, i8, i8)> = Vec::new();
    let mut busy = 0u64;
    let (mut wait, mut sys, mut trans, mut total) = (0u64, 0u64, 0u64, 0u64);
    for q in packets {
        let f = &mut s.flows[q.flow];
        f.sent += 1;
        if q.dropped.is_some() {
            f.dropped += 1;
            s.dropped += 1;
            continue;
        }
        let (Some(shaped), Some(join), Some(start), Some(depart), Some(reach)) =
            (q.t_shaped, q.t_join, q.t_start, q.t_depart, q.t_reach)
        else {
            continue;
        };
        f.served += 1;
        f.bytes += q.size_bytes as u64;
        f.wait_us += (start - join) as f64;
        f.system_us += (depart - join) as f64;
        f.shaper_us += (shaped - q.t_arrive) as f64;
        f.total_us += (reach - q.t_arrive) as f64;
        f.max_wait_us = f.max_wait_us.max(start - join);
        s.served += 1;
        wait += start - join;
        sys += depart - join;
        trans += depart - start;
        total += reach - q.t_arrive;
        busy += depart - start;
        s.end_us = s.end_us.max(depart);
        changes.push((join, 1, 1));
        changes.push((start, -1, 0));
        changes.push((depart, 0, -1));
    }
    for f in &mut s.flows {
        if f.served > 0 {
            let n = f.served as f64;
            f.wait_us /= n;
            f.system_us /= n;
            f.shaper_us /= n;
            f.total_us /= n;
        }
    }
    if s.served == 0 || s.end_us == 0 {
        return s;
    }
    let n = s.served as f64;
    s.wait_us = wait as f64 / n;
    s.system_us = sys as f64 / n;
    s.trans_us = trans as f64 / n;
    s.total_us = total as f64 / n;
    changes.sort_by_key(|&(t, dq, ds)| (t, dq + ds));
    let (mut area_q, mut area_s) = (0u128, 0u128);
    let (mut nq, mut ns, mut last) = (0i64, 0i64, 0u64);
    for (t, dq, ds) in changes {
        if t > last {
            // Only counts that last for some time are real: a packet that
            // joins and starts at once may pass through -1 in this order.
            s.max_waiting = s.max_waiting.max(nq.max(0) as usize);
            area_q += (nq as u128) * (t - last) as u128;
            area_s += (ns as u128) * (t - last) as u128;
            last = t;
        }
        nq += dq as i64;
        ns += ds as i64;
    }
    let end = s.end_us as f64;
    s.lq = area_q as f64 / end;
    s.l = area_s as f64 / end;
    s.lambda_pps = n / end * 1e6;
    s.busy = busy as f64 / end;
    s
}

/// One point of a sweep over the load.
#[derive(Serialize, Clone, Debug)]
pub struct SweepPoint {
    pub rho: f64,
    pub wait_us: f64,
    pub system_us: f64,
    pub l: f64,
    pub lq: f64,
}

/// Run the first flow alone at each load rho = lambda/mu, without a trace,
/// for the page's chart of delay against load.
pub fn sweep(base: &Params, rhos: &[f64], packets: usize) -> Vec<SweepPoint> {
    rhos.iter()
        .map(|&rho| {
            let mut p = base.clone();
            p.flows.truncate(1);
            p.trace = false;
            p.buffer_pkts = 0;
            let f = &mut p.flows[0];
            f.packets = packets;
            f.arrivals = Arrivals::Poisson;
            f.shaper = Shaper::default();
            f.rate_pps = rho * p.rate_bps as f64 / (8.0 * f.size_bytes as f64);
            let s = run(&p).stats;
            SweepPoint {
                rho,
                wait_us: s.wait_us,
                system_us: s.system_us,
                l: s.l,
                lq: s.lq,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One Poisson flow into a link of 8 Mb/s: a 1000-byte packet takes
    /// 1000 microseconds, so mu = 1000 packets per second.
    fn single(rho: f64, sizes: Sizes, packets: usize, seed: u64) -> Params {
        Params {
            flows: vec![Flow {
                name: "a".into(),
                arrivals: Arrivals::Poisson,
                rate_pps: rho * 1000.0,
                on_us: 0,
                off_us: 0,
                sizes,
                size_bytes: 1000,
                weight: 1,
                priority: 0,
                start_us: 0,
                packets,
                shaper: Shaper::default(),
            }],
            discipline: Discipline::Fifo,
            rate_bps: 8_000_000,
            proc_us: 0,
            distance_m: 0,
            speed_mps: 200_000_000,
            buffer_pkts: 0,
            seed,
            trace: false,
        }
    }

    fn flow(name: &str, rate_pps: f64, size_bytes: u32, packets: usize) -> Flow {
        Flow {
            name: name.into(),
            arrivals: Arrivals::Poisson,
            rate_pps,
            on_us: 0,
            off_us: 0,
            sizes: Sizes::Fixed,
            size_bytes,
            weight: 1,
            priority: 0,
            start_us: 0,
            packets,
            shaper: Shaper::default(),
        }
    }

    /// Relative error.
    fn rel(measured: f64, expected: f64) -> f64 {
        (measured - expected).abs() / expected
    }

    // Tolerances. Each formula test runs one seed, so its tolerance is four
    // standard deviations of the run-to-run spread, measured once over seeds
    // 1 to 20 at the same sample size and written beside each check. Queue
    // averages converge slowly because successive waits are correlated, and
    // the more so as rho approaches 1, hence the larger samples at 0.8.

    #[test]
    fn mm1_matches_its_formulas_and_littles_law() {
        // M/M/1: W = 1/(mu - lambda), Wq = rho/(mu - lambda), L = rho/(1 - rho).
        // mu = 1000/s. At rho = 0.5: W = 2000 us, Wq = 1000 us, L = 1.
        let s = run(&single(0.5, Sizes::Exp, 200_000, 1)).stats;
        // 200,000 packets: sd of W over 20 seeds 0.48%, of L 0.58%.
        assert!(rel(s.system_us, 2000.0) < 0.02, "W = {}", s.system_us);
        assert!(rel(s.wait_us, 1000.0) < 0.04, "Wq = {}", s.wait_us);
        assert!(rel(s.l, 1.0) < 0.025, "L = {}", s.l);
        // Little's law holds on every sample path that starts and ends
        // empty: the time-average count, swept from the queue's changes,
        // equals the measured rate times the mean of the per-packet times.
        assert!(rel(s.l, s.lambda_pps / 1e6 * s.system_us) < 1e-9);
        assert!(rel(s.lq, s.lambda_pps / 1e6 * s.wait_us) < 1e-9);
        assert!(rel(s.busy, 0.5) < 0.01, "busy {}", s.busy);

        // At rho = 0.8: W = 5000 us, L = 4. 1,000,000 packets: sd of W about
        // 0.72% (1.6% at 200,000, scaled by the square root of five).
        let s = run(&single(0.8, Sizes::Exp, 1_000_000, 1)).stats;
        assert!(rel(s.system_us, 5000.0) < 0.03, "W = {}", s.system_us);
        assert!(rel(s.l, 4.0) < 0.03, "L = {}", s.l);
        assert!(rel(s.l, s.lambda_pps / 1e6 * s.system_us) < 1e-9);
    }

    #[test]
    fn md1_matches_pollaczek_khinchine_at_half_the_mm1_wait() {
        // M/D/1: Wq = rho / (2 mu (1 - rho)), half the M/M/1 wait
        // rho / (mu (1 - rho)), because E[S^2] = (E S)^2 instead of 2 (E S)^2.
        for (rho, n, tol_wq, tol_ratio) in [
            // 200,000 packets: sd of Wq 0.64%, of the ratio 0.0045.
            (0.5, 200_000, 0.03, 0.02),
            // 1,000,000 packets: sd of Wq 0.86%, of the ratio 0.0051.
            (0.8, 1_000_000, 0.035, 0.021),
        ] {
            let d = run(&single(rho, Sizes::Fixed, n, 1)).stats;
            let m = run(&single(rho, Sizes::Exp, n, 1)).stats;
            let pk = rho / (2.0 * (1.0 - rho)) * 1000.0;
            assert!(
                rel(d.wait_us, pk) < tol_wq,
                "rho {rho}: Wq = {} against {pk}",
                d.wait_us
            );
            assert!(rel(d.system_us, pk + 1000.0) < tol_wq);
            // The same arrival times feed both runs, so their ratio is tight.
            let ratio = d.wait_us / m.wait_us;
            assert!((ratio - 0.5).abs() < tol_ratio, "rho {rho}: ratio {ratio}");
        }
    }

    #[test]
    fn priority_matches_cobham_and_conserves_work() {
        // Two Poisson classes of 1000-byte packets, rho1 = 0.3 urgent and
        // rho2 = 0.4. Cobham (1954), non-preemptive: with
        // W0 = sum lambda_i E[S_i^2] / 2 = 350 us,
        // Wq1 = W0 / (1 - rho1) = 500 us and
        // Wq2 = W0 / ((1 - rho1)(1 - rho1 - rho2)) = 1666.7 us.
        let mut p = single(0.3, Sizes::Fixed, 300_000, 1);
        p.flows.push(flow("b", 400.0, 1000, 400_000));
        p.flows[1].priority = 1;
        p.discipline = Discipline::Priority;
        let s = run(&p).stats;
        // 300,000 and 400,000 packets: sd over 20 seeds 0.32% and 0.65%.
        assert!(
            rel(s.flows[0].wait_us, 500.0) < 0.015,
            "{}",
            s.flows[0].wait_us
        );
        assert!(
            rel(s.flows[1].wait_us, 5000.0 / 3.0) < 0.03,
            "{}",
            s.flows[1].wait_us
        );

        // Kleinrock's conservation law, here exact: with equal packet sizes
        // every work-conserving discipline leaves the same packets in the
        // queue at every moment, so the total wait cannot move.
        let mut p = single(0.35, Sizes::Fixed, 20_000, 2);
        p.flows.push(flow("b", 350.0, 1000, 20_000));
        p.flows[1].priority = 1;
        p.flows[1].weight = 3;
        let total = |d: Discipline| {
            let r = run(&Params {
                discipline: d,
                ..p.clone()
            });
            r.packets
                .iter()
                .map(|q| q.t_start.unwrap() - q.t_join.unwrap())
                .sum::<u64>()
        };
        let fifo = total(Discipline::Fifo);
        assert_eq!(fifo, total(Discipline::Priority));
        assert_eq!(fifo, total(Discipline::Wfq));
    }

    #[test]
    fn the_four_delays_add_up() {
        // 1500 bytes at 10 Mb/s: L/R = 1200 us. 2000 km at 2 x 10^8 m/s:
        // d/s = 10 ms. Processing 20 us. A second packet 600 us behind the
        // first finds it half sent and waits the other 600 us.
        let mut p = single(1.0, Sizes::Fixed, 2, 1);
        p.flows[0].arrivals = Arrivals::Periodic;
        p.flows[0].rate_pps = 1e6 / 600.0;
        p.flows[0].size_bytes = 1500;
        p.rate_bps = 10_000_000;
        p.proc_us = 20;
        p.distance_m = 2_000_000;
        p.trace = true;
        let r = run(&p);
        let a = &r.packets[0];
        assert_eq!(a.t_reach.unwrap() - a.t_arrive, 20 + 1200 + 10_000);
        let b = &r.packets[1];
        assert_eq!(b.t_start.unwrap() - b.t_join.unwrap(), 600);
        assert_eq!(b.t_reach.unwrap() - b.t_arrive, 20 + 600 + 1200 + 10_000);
        let steps: Vec<&str> = r.events.iter().map(|e| e.step).collect();
        assert_eq!(
            steps,
            ["A1", "P1", "S1", "A1", "P1", "S2", "S1", "S2", "R1", "R1"]
        );
    }

    /// Bytes let through by flow k's shaper in each microsecond, in order.
    fn released(r: &Run, k: usize) -> Vec<(u64, u64)> {
        let mut out: Vec<(u64, u64)> = r
            .packets
            .iter()
            .filter(|q| q.flow == k && q.dropped.is_none())
            .map(|q| (q.t_shaped.unwrap(), q.size_bytes as u64))
            .collect();
        out.sort();
        out
    }

    /// Whether the releases obey A(t) - A(s) <= b + r (t - s) over every
    /// interval [s, t], checked exactly in integers (bits times 10^6).
    fn conforms(out: &[(u64, u64)], rate_bps: u64, bucket: u64) -> bool {
        (0..out.len()).all(|i| {
            let mut bytes = 0u128;
            (i..out.len()).all(|j| {
                bytes += out[j].1 as u128;
                bytes * 8_000_000
                    <= bucket as u128 * 8_000_000 + rate_bps as u128 * (out[j].0 - out[i].0) as u128
            })
        })
    }

    fn bursty(police: bool) -> Params {
        // Bursts of 20 packets of 500 bytes at 2000 per second (8 Mb/s while
        // on), every 50 ms: 1.6 Mb/s on average, into a bucket of 2 Mb/s and
        // 3000 bytes.
        let mut p = single(1.0, Sizes::Fixed, 600, 1);
        let f = &mut p.flows[0];
        f.arrivals = Arrivals::Onoff;
        f.rate_pps = 2000.0;
        f.on_us = 10_000;
        f.off_us = 40_000;
        f.size_bytes = 500;
        f.shaper = Shaper {
            kind: ShaperKind::Token,
            rate_bps: 2_000_000,
            bucket_bytes: 3000,
            police,
        };
        p.rate_bps = 100_000_000;
        p.trace = true;
        p
    }

    #[test]
    fn token_bucket_output_obeys_its_arrival_curve() {
        let shaped = run(&bursty(false));
        let out = released(&shaped, 0);
        // A shaper drops nothing and lets out no more than r t + b in any interval...
        assert_eq!(out.len(), 600);
        assert!(conforms(&out, 2_000_000, 3000));
        // ...though the source itself does not conform: a burst is 10,000 bytes.
        let input: Vec<(u64, u64)> = shaped.packets.iter().map(|q| (q.t_arrive, 500)).collect();
        assert!(!conforms(&input, 2_000_000, 3000));
        // The full bucket, 3000 bytes, plus 750 bytes of refill lets the
        // first seven packets through as they come; after that one leaves
        // each time 500 bytes of tokens have built up, every 2 ms.
        let first: Vec<u64> = out.iter().take(9).map(|o| o.0).collect();
        assert_eq!(first, [0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000]);
        // Each burst of 10,000 bytes drains at 250 bytes a millisecond, within its period.
        assert!(shaped.stats.flows[0].shaper_us > 0.0);

        // A policer keeps the same envelope by dropping instead.
        let policed = run(&bursty(true));
        let kept = released(&policed, 0);
        assert!(conforms(&kept, 2_000_000, 3000));
        assert!(policed.stats.dropped > 0);
        assert_eq!(kept.len() + policed.stats.dropped, 600);
        // What it keeps it never delays.
        assert!(policed
            .packets
            .iter()
            .all(|q| q.dropped.is_some() || q.t_shaped == Some(q.t_arrive)));
    }

    #[test]
    fn leaky_bucket_output_is_paced() {
        let mut p = bursty(false);
        p.flows[0].shaper = Shaper {
            kind: ShaperKind::Leaky,
            rate_bps: 2_000_000,
            bucket_bytes: 4000,
            police: false,
        };
        let r = run(&p);
        let out = released(&r, 0);
        // At most eight 500-byte packets fit; the rest of each burst spills.
        assert!(r.stats.dropped > 0);
        // Packets leave at least L/r = 2 ms apart, whatever came in.
        assert!(out.windows(2).all(|w| w[1].0 - w[0].0 >= 2000));
        assert!(conforms(&out, 2_000_000, 500));
    }

    #[test]
    fn wfq_tracks_gps_within_parekh_gallager() {
        // Three flows that are never empty: weights 1, 2 and 4, packets of
        // 1500, 500 and 100 bytes, all arriving faster than the link of
        // 8 Mb/s can send (one byte a microsecond).
        let mut p = single(1.0, Sizes::Fixed, 300, 1);
        p.flows = vec![
            flow("a", 1e6, 1500, 300),
            flow("b", 1e6, 500, 600),
            flow("c", 1e6, 100, 3000),
        ];
        for (f, w) in p.flows.iter_mut().zip([1, 2, 4]) {
            f.arrivals = Arrivals::Periodic;
            f.weight = w;
        }
        p.discipline = Discipline::Wfq;
        let r = run(&p);
        let lmax = 1500.0;
        // Parekh and Gallager, Theorem 1: no packet leaves more than
        // L_max / R after it would have finished under GPS.
        for q in &r.packets {
            let late = q.t_depart.unwrap() as f64 - q.gps_finish;
            assert!(late <= lmax + 1e-6, "packet {} late by {late} us", q.id);
        }
        // Theorem 2: no flow falls more than L_max behind its GPS service,
        // which while all three are backlogged is R t w_i / W. So none can
        // be more than 2 L_max ahead either, the link being shared.
        let gps_end = r
            .packets
            .iter()
            .filter(|q| q.flow == 2)
            .map(|q| q.gps_finish)
            .fold(0.0, f64::max);
        let mut order: Vec<&Packet> = r.packets.iter().collect();
        order.sort_by_key(|q| q.t_depart);
        let mut served = [0.0f64; 3];
        for q in order {
            let t = q.t_depart.unwrap() as f64;
            if t > gps_end {
                break;
            }
            served[q.flow] += q.size_bytes as f64;
            for (k, w) in [1.0, 2.0, 4.0].iter().enumerate() {
                let fair = t * w / 7.0;
                assert!(served[k] >= fair - lmax - 1e-6 && served[k] <= fair + 2.0 * lmax + 1e-6);
            }
        }
        // FIFO, on the same packets, is nowhere near: flow c waits behind
        // the big packets queued before it.
        let fifo = run(&Params {
            discipline: Discipline::Fifo,
            ..p.clone()
        });
        let worst = fifo
            .packets
            .iter()
            .map(|q| q.t_depart.unwrap() as f64 - q.gps_finish)
            .fold(0.0, f64::max);
        assert!(worst > 100.0 * lmax);
    }

    #[test]
    fn shaped_flows_meet_the_parekh_gallager_delay_bound() {
        // Token-bucket flows (r_i, b_i) into WFQ with guaranteed rates
        // g_i = R w_i / W >= r_i: every packet's time in the queue, its own
        // transmission included, is at most b_i / g_i + L_max / R.
        let mut p = single(1.0, Sizes::Fixed, 400, 3);
        p.flows = vec![
            flow("a", 900.0, 1500, 400),
            flow("b", 900.0, 500, 1200),
            flow("c", 900.0, 1000, 800),
        ];
        let spec = [
            (1, 1_500_000, 6000),
            (1, 1_500_000, 3000),
            (2, 3_500_000, 10_000),
        ];
        for (f, (w, r, b)) in p.flows.iter_mut().zip(spec) {
            f.arrivals = Arrivals::Onoff;
            f.rate_pps = 1e6 / f.size_bytes as f64;
            f.on_us = 20_000;
            f.off_us = 30_000;
            f.weight = w;
            f.shaper = Shaper {
                kind: ShaperKind::Token,
                rate_bps: r,
                bucket_bytes: b,
                police: false,
            };
        }
        p.discipline = Discipline::Wfq;
        let r = run(&p);
        for (k, (w, _, b)) in spec.iter().enumerate() {
            let g = 8e6 * *w as f64 / 4.0;
            let bound = *b as f64 * 8e6 / g + 1500.0;
            let worst = r
                .packets
                .iter()
                .filter(|q| q.flow == k)
                .map(|q| q.t_depart.unwrap() - q.t_join.unwrap())
                .max()
                .unwrap() as f64;
            assert!(worst <= bound + 1.0, "flow {k}: {worst} us against {bound}");
            assert!(
                worst > bound / 4.0,
                "flow {k}: the bound should be nearly reached, {worst}"
            );
        }
    }

    #[test]
    fn sweep_follows_the_load() {
        let base = single(0.5, Sizes::Fixed, 1, 1);
        let pts = sweep(&base, &[0.2, 0.5, 0.8], 50_000);
        assert!(pts.windows(2).all(|w| w[1].wait_us > w[0].wait_us));
        // M/D/1 at 0.5: Wq = 500 us; 50,000 packets, sd about 1.3%.
        assert!(rel(pts[1].wait_us, 500.0) < 0.06);
    }

    #[test]
    fn a_full_buffer_drops_the_tail() {
        let mut p = single(1.5, Sizes::Fixed, 2000, 1);
        p.buffer_pkts = 10;
        let r = run(&p);
        assert!(r.stats.max_waiting <= 10);
        assert!(r.stats.dropped > 500, "{}", r.stats.dropped);
        assert!(r
            .packets
            .iter()
            .all(|q| q.dropped != Some("buffer") || q.t_start.is_none()));
    }
}
