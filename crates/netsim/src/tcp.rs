//! TCP congestion control on a dumbbell.
//!
//! Up to four senders share one bottleneck link of rate C with a drop-tail
//! queue of B packets. Each flow has its own propagation round trip; ACKs
//! come back on an uncongested path. Segments are all one size (the MSS) and
//! windows are counted in segments. The receiver keeps out-of-order data and
//! acknowledges every segment at once (no delayed ACKs, no SACK).
//!
//! The senders follow the RFCs: slow start, congestion avoidance, fast
//! retransmit and fast recovery from RFC 5681 (Tahoe has no fast recovery,
//! Reno has it, NewReno adds the partial-ACK rule of RFC 6582), the
//! retransmission timer of RFC 6298 with Karn's rule, and CUBIC from RFC 9438
//! on top of NewReno's loss recovery. Two simplifications are worth naming:
//! limited transmit (RFC 3042) is left out, and after a timeout the sender goes
//! back to the first unacknowledged segment and resends from there, as BSD
//! does; the receiver's buffer means the first new ACK usually skips ahead.
//!
//! Loss comes from the queue overflowing, from an optional random loss rate,
//! from dropping every n-th packet, or from drops the learner scripts.
//!
//! As in the other models the steps are lettered, and the trace names the
//! step that produced each event.

use std::collections::{BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Algo {
    Tahoe,
    Reno,
    NewReno,
    Cubic,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Flow {
    pub algo: Algo,
    /// Propagation round trip, without transmission or queueing.
    pub rtt_us: u64,
    #[serde(default)]
    pub start_us: u64,
}

/// Drop the `occurrence`-th transmission of segment `seg` of `flow` at the
/// bottleneck.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ScriptedDrop {
    pub flow: usize,
    pub seg: u64,
    #[serde(default = "first")]
    pub occurrence: u32,
}

fn first() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Params {
    pub flows: Vec<Flow>,
    pub rate_bps: u64,
    pub mss_bytes: u32,
    /// Packets that may wait at the bottleneck, besides the one being sent.
    pub buffer_pkts: u32,
    /// Probability that the bottleneck drops a packet at random.
    pub loss: f64,
    /// Drop every n-th packet of each flow at the bottleneck; 0 is off.
    #[serde(default)]
    pub drop_every: u32,
    /// Each packet waits a random time in [0, jitter] before the bottleneck,
    /// without overtaking the packet before it.
    pub jitter_us: u64,
    pub duration_us: u64,
    pub iw: f64,
    pub init_ssthresh: f64,
    /// The receiver's window, in segments.
    pub max_window: f64,
    pub min_rto_us: u64,
    /// RFC 9438 section 4.7; only used by CUBIC.
    #[serde(default)]
    pub fast_convergence: bool,
    pub seed: u64,
    #[serde(default)]
    pub drops: Vec<ScriptedDrop>,
    /// Record the event-level trace of flow 0 only in [from, to].
    #[serde(default)]
    pub detail: Option<(u64, u64)>,
}

/// The RFC 6298 estimator, kept apart so it can be checked against the RFC.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Rto {
    pub srtt_us: f64,
    pub rttvar_us: f64,
    pub rto_us: f64,
    pub samples: u32,
    pub backoffs: u32,
    pub floor_us: f64,
}

/// Clock granularity G, one tick of the simulator's clock.
const G_US: f64 = 1.0;
/// RFC 6298 (2.5): a maximum of at least 60 seconds may be placed on RTO.
const RTO_MAX_US: f64 = 60e6;

impl Rto {
    pub fn new(floor_us: f64) -> Self {
        // R1. [Before any sample.] RTO is one second (RFC 6298, 2.1).
        Rto {
            srtt_us: 0.0,
            rttvar_us: 0.0,
            rto_us: 1e6_f64.max(floor_us),
            samples: 0,
            backoffs: 0,
            floor_us,
        }
    }

    /// R2. [Take a sample.] The first sample R sets SRTT = R and
    /// RTTVAR = R/2. Later ones update RTTVAR first, with the old SRTT:
    /// RTTVAR = 3/4 RTTVAR + 1/4 |SRTT - R'|, then SRTT = 7/8 SRTT + 1/8 R'.
    /// RTO = SRTT + max(G, 4 RTTVAR), raised to the floor. A fresh sample
    /// also ends any backoff.
    pub fn sample(&mut self, r: f64) {
        if self.samples == 0 {
            self.srtt_us = r;
            self.rttvar_us = r / 2.0;
        } else {
            self.rttvar_us = 0.75 * self.rttvar_us + 0.25 * (self.srtt_us - r).abs();
            self.srtt_us = 0.875 * self.srtt_us + 0.125 * r;
        }
        self.samples += 1;
        self.backoffs = 0;
        self.rto_us = (self.srtt_us + G_US.max(4.0 * self.rttvar_us))
            .max(self.floor_us)
            .min(RTO_MAX_US);
    }

    /// R3. [Back off.] When the timer expires, double RTO (RFC 6298, 5.5).
    /// By Karn's rule no sample is taken from a retransmitted segment, so
    /// the doubled value stays until a segment sent only once is acknowledged.
    pub fn back_off(&mut self) {
        self.rto_us = (self.rto_us * 2.0).min(RTO_MAX_US);
        self.backoffs += 1;
    }
}

/// CUBIC's constants (RFC 9438, 4.1 and 4.6).
pub const CUBIC_C: f64 = 0.4;
pub const CUBIC_BETA: f64 = 0.7;

/// W_cubic(t) = C (t - K)^3 + W_max, with t in seconds (RFC 9438, eq. 1).
pub fn w_cubic(t: f64, k: f64, w_max: f64) -> f64 {
    CUBIC_C * (t - k).powi(3) + w_max
}

/// K = cbrt((W_max - cwnd_epoch) / C) (RFC 9438, eq. 2), so that
/// W_cubic(0) = cwnd_epoch and W_cubic(K) = W_max.
pub fn cubic_k(w_max: f64, cwnd_epoch: f64) -> f64 {
    ((w_max - cwnd_epoch) / CUBIC_C).cbrt()
}

#[derive(Clone, Debug, Default)]
struct Cubic {
    w_max: f64,
    k: f64,
    epoch: Option<u64>,
    cwnd_epoch: f64,
    w_est: f64,
    cwnd_prior: f64,
    /// No usable W_max: at the start, and after a timeout (RFC 9438, 4.8).
    reset: bool,
    region: char,
}

/// One packet of flow 0 on the wire, for the ladder.
#[derive(Serialize, Clone, Debug)]
pub struct Flight {
    pub id: usize,
    pub ack: bool,
    /// Segment number for data, the next expected segment for an ACK.
    pub seg: u64,
    pub retx: bool,
    pub t_start: u64,
    pub t_sent: u64,
    pub t_arrive: u64,
    pub lost: bool,
    pub fate: &'static str,
}

/// Flow 0's state after an event.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct State {
    pub cwnd: f64,
    pub ssthresh: f64,
    pub una: u64,
    pub nxt: u64,
    pub max: u64,
    pub dupacks: u32,
    /// 'S' slow start, 'A' congestion avoidance, 'R' fast recovery.
    pub phase: char,
    pub recover: i64,
    pub srtt_us: f64,
    pub rttvar_us: f64,
    pub rto_us: f64,
    pub timer_at: Option<u64>,
    pub queue: u32,
    /// CUBIC's region: 'F' Reno-friendly, 'C' concave, 'X' convex; '-' otherwise.
    pub region: char,
    pub w_max: f64,
    pub k: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: u64,
    pub step: &'static str,
    pub text: String,
    pub flight: Option<usize>,
    pub state: State,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Mark {
    pub t: u64,
    /// "drop", "fast" (fast retransmit), "partial" or "timeout".
    pub kind: &'static str,
    pub seg: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FlowSeries {
    pub cwnd: Vec<(u64, f64)>,
    pub ssthresh: Vec<(u64, f64)>,
    pub srtt: Vec<(u64, f64)>,
    pub rto: Vec<(u64, f64)>,
    pub marks: Vec<Mark>,
}

/// Values on a regular grid, for the phase plane and the rate chart.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Grid {
    pub dt_us: u64,
    pub t: Vec<u64>,
    /// cwnd per flow at each grid time.
    pub cwnd: Vec<Vec<f64>>,
    /// Goodput per flow over the interval ending at each grid time, bit/s.
    pub rate: Vec<Vec<f64>>,
    pub queue: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FlowTotals {
    pub delivered: u64,
    pub sent: u64,
    pub retransmissions: u64,
    pub fast_retransmits: u32,
    pub timeouts: u32,
    pub drops: u64,
    /// These three are measured over the second half of the run.
    pub goodput_bps: f64,
    pub loss_rate: f64,
    pub mean_rtt_us: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Totals {
    pub flows: Vec<FlowTotals>,
    /// Fraction of the second half of the run the bottleneck was sending.
    pub utilisation: f64,
    pub mean_queue: f64,
    pub max_queue: u32,
    /// Jain's index over the flows' goodputs in the second half.
    pub jain: f64,
}

/// Closed forms the page sets beside the run.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Theory {
    pub tx_us: f64,
    /// Bandwidth-delay product of flow 0's path, in packets.
    pub bdp_pkts: f64,
    /// Packets the path holds before the queue overflows: BDP + B + 1.
    pub pipe_pkts: f64,
    /// Utilisation of one Reno flow's sawtooth with this buffer (see `reno_utilisation`).
    pub reno_utilisation: f64,
    /// Mathis et al. with flow 0's measured loss rate and mean RTT, bit/s.
    pub mathis_bps: f64,
    /// Padhye et al. (PFTK) with the same p, RTT and the mean RTO, bit/s.
    pub pftk_bps: f64,
    /// CUBIC's K after a loss at the full pipe, seconds.
    pub cubic_k_s: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Run {
    pub series: Vec<FlowSeries>,
    pub queue: Vec<(u64, f64)>,
    pub grid: Grid,
    pub flights: Vec<Flight>,
    pub events: Vec<Event>,
    pub totals: Totals,
    pub theory: Theory,
    pub duration_us: u64,
}

/// One Reno flow, drop-tail buffer, no other loss. The window climbs one
/// segment per round trip from W/2 to W = P + B, where P is the
/// bandwidth-delay product in packets. Below P the link idles; above it the
/// queue grows and the round trip with it. Integrating over one cycle, the
/// sender delivers 3W^2/8 packets in the time the link could send
/// P(P - W/2) + (W^2 - P^2)/2, so U = 3W^2/8 divided by that, and U = 1 once
/// B >= P. With B = 0 this is the classic 3/4.
pub fn reno_utilisation(p: f64, b: f64) -> f64 {
    let w = p + b;
    if w >= 2.0 * p {
        return 1.0;
    }
    let link = p * (p - w / 2.0) + (w * w - p * p) / 2.0;
    (3.0 * w * w / 8.0 / link).min(1.0)
}

/// Mathis, Semke, Mahdavi and Ott (1997): rate = (MSS/RTT) sqrt(3/(2p)) for
/// one ACK per segment, periodic loss and no timeouts.
pub fn mathis_bps(mss_bytes: f64, rtt_us: f64, p: f64) -> f64 {
    mss_bytes * 8.0 / (rtt_us / 1e6) * (1.5 / p).sqrt()
}

/// Padhye, Firoiu, Towsley and Kurose (1998), with b = 1 and no receiver
/// window limit: packets per second
/// 1 / (RTT sqrt(2p/3) + T0 min(1, 3 sqrt(3p/8)) p (1 + 32 p^2)).
pub fn pftk_bps(mss_bytes: f64, rtt_us: f64, rto_us: f64, p: f64) -> f64 {
    let rtt = rtt_us / 1e6;
    let t0 = rto_us / 1e6;
    let pps = 1.0
        / (rtt * (2.0 * p / 3.0).sqrt()
            + t0 * (3.0 * (3.0 * p / 8.0).sqrt()).min(1.0) * p * (1.0 + 32.0 * p * p));
    pps * mss_bytes * 8.0
}

enum Ev {
    Start(usize),
    AtRouter {
        flow: usize,
        seg: u64,
        flight: Option<usize>,
    },
    LinkFree,
    AtReceiver {
        flow: usize,
        seg: u64,
        flight: Option<usize>,
    },
    AckArrive {
        flow: usize,
        ack: u64,
        flight: Option<usize>,
    },
    Timeout {
        flow: usize,
        generation: u64,
    },
    Sample,
}

struct Sender {
    algo: Algo,
    rtt_us: u64,
    started: bool,
    una: u64,
    nxt: u64,
    max: u64,
    cwnd: f64,
    ssthresh: f64,
    dupacks: u32,
    recovery: bool,
    partial_seen: bool,
    recover: i64,
    rto: Rto,
    timing: Option<(u64, u64)>,
    generation: u64,
    timer_at: Option<u64>,
    sends: Vec<u16>,
    last_access: u64,
    cubic: Cubic,
    // The receiver of this flow.
    rcv_next: u64,
    held: BTreeSet<u64>,
    // Counters.
    arrivals: u64,
    late_arrivals: u64,
    late_drops: u64,
    delivered_mark: u64,
    rtt_sum: f64,
    rtt_n: u64,
    totals: FlowTotals,
    series: FlowSeries,
}

struct Sim<'a> {
    p: &'a Params,
    rng: Rng,
    queue: Queue<Ev>,
    now: u64,
    tx_us: u64,
    flows: Vec<Sender>,
    // The bottleneck.
    waiting: VecDeque<(usize, u64, Option<usize>)>,
    sending: Option<(usize, u64, Option<usize>)>,
    busy_us: u64,
    queue_area: f64,
    queue_changed: u64,
    queue_len_before: u32,
    max_queue: u32,
    queue_series: Vec<(u64, f64)>,
    grid: Grid,
    // Flow 0's detailed trace.
    flights: Vec<Flight>,
    events: Vec<Event>,
    detail: (u64, u64),
}

pub const MAX_EVENTS: usize = 6000;
pub const MAX_FLIGHTS: usize = 4000;
const MAX_MARKS: usize = 3000;
const MAX_POINTS: usize = 3000;
const GRID_POINTS: u64 = 600;

pub fn run(p: &Params) -> Run {
    let tx_us = ((p.mss_bytes as f64 * 8.0 / p.rate_bps as f64) * 1e6)
        .round()
        .max(1.0) as u64;
    let dt = (p.duration_us / GRID_POINTS).max(1000);
    let mut sim = Sim {
        p,
        rng: Rng::new(p.seed),
        queue: Queue::default(),
        now: 0,
        tx_us,
        flows: p
            .flows
            .iter()
            .map(|f| Sender {
                algo: f.algo,
                rtt_us: f.rtt_us,
                started: false,
                una: 0,
                nxt: 0,
                max: 0,
                cwnd: p.iw,
                ssthresh: p.init_ssthresh,
                dupacks: 0,
                recovery: false,
                partial_seen: false,
                recover: -1,
                rto: Rto::new(p.min_rto_us as f64),
                timing: None,
                generation: 0,
                timer_at: None,
                sends: Vec::new(),
                last_access: 0,
                cubic: Cubic {
                    reset: true,
                    region: '-',
                    ..Cubic::default()
                },
                rcv_next: 0,
                held: BTreeSet::new(),
                arrivals: 0,
                late_arrivals: 0,
                late_drops: 0,
                delivered_mark: 0,
                rtt_sum: 0.0,
                rtt_n: 0,
                totals: FlowTotals::default(),
                series: FlowSeries::default(),
            })
            .collect(),
        waiting: VecDeque::new(),
        sending: None,
        busy_us: 0,
        queue_area: 0.0,
        queue_changed: p.duration_us / 2,
        queue_len_before: 0,
        max_queue: 0,
        queue_series: vec![(0, 0.0)],
        grid: Grid {
            dt_us: dt,
            cwnd: vec![Vec::new(); p.flows.len()],
            rate: vec![Vec::new(); p.flows.len()],
            ..Grid::default()
        },
        flights: Vec::new(),
        events: Vec::new(),
        detail: p.detail.unwrap_or((0, u64::MAX)),
    };
    for (i, f) in p.flows.iter().enumerate() {
        sim.queue.push(f.start_us, Ev::Start(i));
    }
    sim.queue.push(dt, Ev::Sample);
    while let Some((at, ev)) = sim.queue.pop() {
        if at > p.duration_us {
            break;
        }
        sim.now = at;
        match ev {
            Ev::Start(f) => sim.start(f),
            Ev::AtRouter { flow, seg, flight } => sim.at_router(flow, seg, flight),
            Ev::LinkFree => sim.link_free(),
            Ev::AtReceiver { flow, seg, flight } => sim.at_receiver(flow, seg, flight),
            Ev::AckArrive { flow, ack, flight } => sim.on_ack(flow, ack, flight),
            Ev::Timeout { flow, generation } => sim.on_timeout(flow, generation),
            Ev::Sample => sim.sample(),
        }
    }
    sim.finish()
}

impl Sim<'_> {
    fn queue_len(&self) -> u32 {
        self.waiting.len() as u32
    }

    fn state(&self) -> State {
        let s = &self.flows[0];
        State {
            cwnd: s.cwnd,
            ssthresh: s.ssthresh,
            una: s.una,
            nxt: s.nxt,
            max: s.max,
            dupacks: s.dupacks,
            phase: phase(s),
            recover: s.recover,
            srtt_us: s.rto.srtt_us,
            rttvar_us: s.rto.rttvar_us,
            rto_us: s.rto.rto_us,
            timer_at: s.timer_at,
            queue: self.queue_len(),
            region: if s.algo == Algo::Cubic && phase(s) == 'A' {
                s.cubic.region
            } else {
                '-'
            },
            w_max: s.cubic.w_max,
            k: s.cubic.k,
        }
    }

    fn in_detail(&self) -> bool {
        self.now >= self.detail.0 && self.now <= self.detail.1
    }

    fn note(&mut self, f: usize, step: &'static str, text: String, flight: Option<usize>) {
        if f == 0 && self.in_detail() && self.events.len() < MAX_EVENTS {
            let state = self.state();
            self.events.push(Event {
                t: self.now,
                step,
                text,
                flight,
                state,
            });
        }
    }

    fn mark(&mut self, f: usize, kind: &'static str, seg: u64) {
        let marks = &mut self.flows[f].series.marks;
        if marks.len() < MAX_MARKS {
            marks.push(Mark {
                t: self.now,
                kind,
                seg,
            });
        }
    }

    /// Record cwnd and ssthresh when they change.
    fn trace(&mut self, f: usize) {
        let now = self.now;
        let s = &mut self.flows[f];
        push_change(&mut s.series.cwnd, now, s.cwnd);
        push_change(&mut s.series.ssthresh, now, s.ssthresh);
    }

    fn trace_queue(&mut self) {
        let len = self.queue_len();
        let half = self.p.duration_us / 2;
        if self.now > half {
            self.queue_area +=
                self.queue_len_before as f64 * (self.now - self.queue_changed) as f64;
        }
        self.queue_changed = self.now.max(half);
        self.max_queue = self.max_queue.max(len);
        push_change(&mut self.queue_series, self.now, len as f64);
    }

    fn start(&mut self, f: usize) {
        self.flows[f].started = true;
        self.note(f, "S1", "the connection opens".into(), None);
        self.trace(f);
        self.pump(f, "S1");
    }

    /// S1. [Send what the window allows.] While nxt < una + min(cwnd, rwnd),
    /// send segment nxt and advance nxt. The window is counted in whole
    /// segments.
    fn pump(&mut self, f: usize, step: &'static str) {
        loop {
            let s = &self.flows[f];
            let window = s.cwnd.min(self.p.max_window).floor().max(1.0) as u64;
            if s.nxt >= s.una + window {
                break;
            }
            let seg = s.nxt;
            self.flows[f].nxt += 1;
            self.transmit(f, seg, step);
        }
    }

    /// S2. [Transmit.] Put segment `seg` on the wire. A segment sent before is
    /// a retransmission; by Karn's rule it also cancels any RTT measurement in
    /// progress. Otherwise, if nothing is being timed, time this one. Start
    /// the retransmission timer if it is not running (RFC 6298, 5.1).
    fn transmit(&mut self, f: usize, seg: u64, step: &'static str) {
        let jitter = self.rng.upto(self.p.jitter_us);
        let now = self.now;
        let tx = self.tx_us;
        let s = &mut self.flows[f];
        let i = seg as usize;
        if s.sends.len() <= i {
            s.sends.resize(i + 1, 0);
        }
        s.sends[i] = s.sends[i].saturating_add(1);
        let retx = seg < s.max;
        s.totals.sent += 1;
        if retx {
            s.totals.retransmissions += 1;
            s.timing = None;
        } else {
            s.max = seg + 1;
            if s.timing.is_none() {
                s.timing = Some((seg, now));
            }
        }
        let at = (now + jitter).max(s.last_access);
        s.last_access = at;
        let need_timer = s.timer_at.is_none();
        let flight = if f == 0 && self.in_detail() && self.flights.len() < MAX_FLIGHTS {
            let id = self.flights.len();
            self.flights.push(Flight {
                id,
                ack: false,
                seg,
                retx,
                t_start: now,
                t_sent: now + tx,
                t_arrive: u64::MAX,
                lost: false,
                fate: "",
            });
            Some(id)
        } else {
            None
        };
        self.queue.push(
            at,
            Ev::AtRouter {
                flow: f,
                seg,
                flight,
            },
        );
        let what = if retx { "retransmit" } else { "send" };
        self.note(f, step, format!("{what} segment {seg}"), flight);
        if need_timer {
            self.restart_timer(f);
        }
    }

    fn restart_timer(&mut self, f: usize) {
        let now = self.now;
        let s = &mut self.flows[f];
        s.generation += 1;
        let at = now + s.rto.rto_us.round() as u64;
        s.timer_at = Some(at);
        let generation = s.generation;
        self.queue.push(
            at,
            Ev::Timeout {
                flow: f,
                generation,
            },
        );
    }

    fn stop_timer(&mut self, f: usize) {
        let s = &mut self.flows[f];
        s.generation += 1;
        s.timer_at = None;
    }

    /// Q1. [Arrive at the bottleneck.] Drop the packet if the learner
    /// scripted it, if it is the n-th of its flow, if the random loss strikes,
    /// or if B packets already wait (drop-tail). Otherwise send it at once if
    /// the link is idle, or queue it. The random draw is made for every
    /// packet, so one edit never changes the luck of the others.
    fn at_router(&mut self, f: usize, seg: u64, flight: Option<usize>) {
        let luck = self.rng.unit();
        let late = self.now > self.p.duration_us / 2;
        let s = &mut self.flows[f];
        s.arrivals += 1;
        s.late_arrivals += late as u64;
        let occurrence = s.sends.get(seg as usize).copied().unwrap_or(1) as u32;
        let scripted = self
            .p
            .drops
            .iter()
            .any(|d| d.flow == f && d.seg == seg && d.occurrence == occurrence);
        let periodic = self.p.drop_every > 0 && s.arrivals % self.p.drop_every as u64 == 0;
        let full = self.sending.is_some() && self.queue_len() >= self.p.buffer_pkts;
        let reason = if scripted {
            Some("dropped as scripted")
        } else if periodic {
            Some("dropped: every n-th packet")
        } else if luck < self.p.loss {
            Some("dropped at random")
        } else if full {
            Some("dropped: queue full")
        } else {
            None
        };
        if let Some(reason) = reason {
            self.flows[f].totals.drops += 1;
            self.flows[f].late_drops += late as u64;
            if let Some(id) = flight {
                let fl = &mut self.flights[id];
                fl.lost = true;
                fl.t_arrive = self.now;
                fl.fate = reason;
            }
            self.mark(f, "drop", seg);
            self.note(f, "Q1", format!("segment {seg} {reason}"), flight);
            return;
        }
        self.queue_len_before = self.queue_len();
        if self.sending.is_none() {
            self.serve(f, seg, flight);
        } else {
            self.waiting.push_back((f, seg, flight));
            self.trace_queue();
        }
    }

    fn serve(&mut self, f: usize, seg: u64, flight: Option<usize>) {
        self.sending = Some((f, seg, flight));
        let half = self.p.duration_us / 2;
        let end = (self.now + self.tx_us).min(self.p.duration_us);
        if end > half {
            self.busy_us += end - self.now.max(half);
        }
        self.queue.push(self.now + self.tx_us, Ev::LinkFree);
    }

    /// Q2. [Finish sending.] The last bit has left; the packet reaches the
    /// receiver one half round trip later. Start on the head of the queue.
    fn link_free(&mut self) {
        if let Some((f, seg, flight)) = self.sending.take() {
            let at = self.now + self.flows[f].rtt_us / 2;
            self.queue.push(
                at,
                Ev::AtReceiver {
                    flow: f,
                    seg,
                    flight,
                },
            );
        }
        self.queue_len_before = self.queue_len();
        if let Some((f, seg, flight)) = self.waiting.pop_front() {
            self.trace_queue();
            self.serve(f, seg, flight);
        }
    }

    /// V1. [Receive.] Keep the segment if it is new, deliver the in-order run
    /// to the application, and acknowledge at once with the next segment
    /// expected. An out-of-order arrival repeats the last ACK: a duplicate.
    fn at_receiver(&mut self, f: usize, seg: u64, flight: Option<usize>) {
        let now = self.now;
        let s = &mut self.flows[f];
        let fate = if seg == s.rcv_next {
            s.rcv_next += 1;
            while s.held.remove(&s.rcv_next) {
                s.rcv_next += 1;
            }
            "delivered"
        } else if seg > s.rcv_next {
            s.held.insert(seg);
            "buffered out of order"
        } else {
            "duplicate, already had it"
        };
        let ack = s.rcv_next;
        s.totals.delivered = ack;
        let back = now + s.rtt_us / 2;
        if let Some(id) = flight {
            let fl = &mut self.flights[id];
            fl.t_arrive = now;
            fl.fate = fate;
        }
        let ack_flight = if f == 0 && self.in_detail() && self.flights.len() < MAX_FLIGHTS {
            let id = self.flights.len();
            self.flights.push(Flight {
                id,
                ack: true,
                seg: ack,
                retx: false,
                t_start: now,
                t_sent: now,
                t_arrive: back,
                lost: false,
                fate: "",
            });
            Some(id)
        } else {
            None
        };
        self.note(
            f,
            "V1",
            format!("receiver gets {seg}: {fate}; ACK {ack}"),
            flight,
        );
        self.queue.push(
            back,
            Ev::AckArrive {
                flow: f,
                ack,
                flight: ack_flight,
            },
        );
    }

    fn on_ack(&mut self, f: usize, ack: u64, flight: Option<usize>) {
        let s = &self.flows[f];
        if ack > s.una {
            self.new_ack(f, ack, flight);
        } else if ack == s.una && s.una < s.max {
            self.dup_ack(f, ack, flight);
        }
        if let Some(id) = flight {
            let fate = match self.flights[id].fate {
                "" => "old ACK, ignored",
                other => other,
            };
            self.flights[id].fate = fate;
        }
        self.trace(f);
    }

    /// A1. [New data acknowledged.] Take an RTT sample if the timed segment
    /// is now covered, slide una forward, and reset the duplicate count.
    fn new_ack(&mut self, f: usize, ack: u64, flight: Option<usize>) {
        let now = self.now;
        let s = &mut self.flows[f];
        let acked = ack - s.una;
        if let Some((seg, at)) = s.timing {
            if seg < ack {
                let r = (now - at) as f64;
                s.rto.sample(r);
                s.timing = None;
                if now > self.p.duration_us / 2 {
                    s.rtt_sum += r;
                    s.rtt_n += 1;
                }
                let (t, srtt, rto) = (now, s.rto.srtt_us, s.rto.rto_us);
                push_change(&mut s.series.srtt, t, srtt);
                push_change(&mut s.series.rto, t, rto);
            }
        }
        s.una = ack;
        s.nxt = s.nxt.max(ack);
        s.dupacks = 0;
        if let Some(id) = flight {
            self.flights[id].fate = "new data acknowledged";
        }

        if self.flows[f].recovery {
            let s = &mut self.flows[f];
            let newreno = matches!(s.algo, Algo::NewReno | Algo::Cubic);
            if !newreno {
                // F4. [Leave fast recovery.] Reno deflates the window to
                // ssthresh on the first new ACK, partial or not (RFC 5681, step 6).
                s.cwnd = s.ssthresh;
                s.recovery = false;
                self.note(
                    f,
                    "F4",
                    format!("ACK {ack}: leave fast recovery, cwnd = ssthresh"),
                    flight,
                );
            } else if ack as i64 >= s.recover {
                // F4. [Full acknowledgement.] Everything outstanding when
                // recovery began is acknowledged. Set
                // cwnd = min(ssthresh, max(FlightSize, 1) + 1) (RFC 6582, 3.2 step 3).
                let flight_size = (s.max - s.una) as f64;
                s.cwnd = s.ssthresh.min(flight_size.max(1.0) + 1.0);
                s.recovery = false;
                self.note(
                    f,
                    "F4",
                    format!("full ACK {ack}: leave fast recovery"),
                    flight,
                );
            } else {
                // F5. [Partial acknowledgement.] Another segment of the same
                // window was lost. Retransmit it at once, deflate cwnd by the
                // amount acknowledged and add one back, and stay in recovery.
                // Only the first partial ACK resets the timer.
                s.cwnd = (s.cwnd - acked as f64 + 1.0).max(1.0);
                let first = !s.partial_seen;
                s.partial_seen = true;
                let una = s.una;
                self.mark(f, "partial", una);
                self.note(
                    f,
                    "F5",
                    format!("partial ACK {ack}: retransmit {una} and stay"),
                    flight,
                );
                self.transmit(f, una, "F5");
                if first {
                    self.restart_timer(f);
                }
                self.pump(f, "F5");
                return;
            }
        } else {
            self.grow(f, acked, ack, flight);
        }
        // R4. [Timer.] All data acknowledged: stop the timer. Otherwise
        // restart it for the oldest outstanding segment (RFC 6298, 5.2 and 5.3).
        let s = &self.flows[f];
        if s.una >= s.max {
            self.stop_timer(f);
        } else {
            self.restart_timer(f);
        }
        self.pump(f, "S1");
    }

    /// A2. [Open the window.] Below ssthresh, slow start adds one segment per
    /// ACK (RFC 5681: cwnd += min(N, SMSS)), doubling cwnd every round trip.
    /// At or above it, Reno's congestion avoidance adds 1/cwnd per ACK, one
    /// segment per round trip; CUBIC follows its curve instead (A3).
    fn grow(&mut self, f: usize, acked: u64, ack: u64, flight: Option<usize>) {
        let s = &mut self.flows[f];
        if s.cwnd >= self.p.max_window {
            return;
        }
        if s.cwnd < s.ssthresh {
            s.cwnd += 1.0;
            self.note(f, "A2", format!("ACK {ack}: slow start, cwnd + 1"), flight);
        } else if s.algo == Algo::Cubic {
            self.cubic_grow(f, acked, ack, flight);
        } else {
            s.cwnd += 1.0 / s.cwnd;
            self.note(
                f,
                "A2",
                format!("ACK {ack}: congestion avoidance, cwnd + 1/cwnd"),
                flight,
            );
        }
    }

    /// A3. [CUBIC.] At the start of an epoch, record cwnd and compute K so the
    /// curve leaves today's window and reaches W_max after K seconds (with no
    /// usable W_max, K = 0 and W_max = cwnd). On each ACK aim for
    /// W_cubic(t + RTT), kept within [cwnd, 1.5 cwnd], and move cwnd by
    /// (target - cwnd)/cwnd. Alongside, W_est estimates what Reno would have,
    /// growing by alpha per round trip (alpha = 3(1 - beta)/(1 + beta) until
    /// it passes the window before the last loss, 1 after). If the curve is
    /// below W_est, use W_est: the Reno-friendly region.
    fn cubic_grow(&mut self, f: usize, acked: u64, ack: u64, flight: Option<usize>) {
        let now = self.now;
        let s = &mut self.flows[f];
        let c = &mut s.cubic;
        if c.epoch.is_none() {
            c.epoch = Some(now);
            c.cwnd_epoch = s.cwnd;
            if c.reset {
                c.w_max = s.cwnd;
                c.cwnd_prior = s.cwnd;
                c.k = 0.0;
                c.reset = false;
            } else {
                c.k = cubic_k(c.w_max, c.cwnd_epoch);
            }
            c.w_est = c.cwnd_epoch;
        }
        let t = (now - c.epoch.unwrap_or(now)) as f64 / 1e6;
        let rtt = if s.rto.samples > 0 {
            s.rto.srtt_us
        } else {
            s.rtt_us as f64
        } / 1e6;
        let target = w_cubic(t + rtt, c.k, c.w_max).clamp(s.cwnd, 1.5 * s.cwnd);
        let alpha = if c.w_est >= c.cwnd_prior {
            1.0
        } else {
            3.0 * (1.0 - CUBIC_BETA) / (1.0 + CUBIC_BETA)
        };
        c.w_est += alpha * acked as f64 / s.cwnd;
        let text = if w_cubic(t, c.k, c.w_max) < c.w_est {
            s.cwnd = c.w_est.max(s.cwnd);
            c.region = 'F';
            format!("ACK {ack}: CUBIC, Reno-friendly, cwnd = W_est")
        } else {
            s.cwnd += (target - s.cwnd) / s.cwnd;
            c.region = if s.cwnd < c.w_max { 'C' } else { 'X' };
            format!("ACK {ack}: CUBIC, cwnd moves toward W_cubic(t + RTT)")
        };
        self.note(f, "A3", text, flight);
    }

    /// D1. [Duplicate ACK.] The receiver got something out of order. In fast
    /// recovery each one means a packet has left the network, so inflate
    /// cwnd by one and perhaps send new data (RFC 5681, step 4). Outside
    /// recovery, the third in a row means a loss (D2).
    fn dup_ack(&mut self, f: usize, ack: u64, flight: Option<usize>) {
        let s = &mut self.flows[f];
        s.dupacks += 1;
        let n = s.dupacks;
        if let Some(id) = flight {
            self.flights[id].fate = "duplicate ACK";
        }
        if s.recovery {
            s.cwnd += 1.0;
            self.note(
                f,
                "D1",
                format!("duplicate ACK {ack} in recovery: cwnd + 1"),
                flight,
            );
            self.pump(f, "D1");
            return;
        }
        self.note(f, "D1", format!("duplicate ACK {ack} (#{n})"), flight);
        if n == 3 {
            self.three_dupacks(f, ack, flight);
        }
    }

    /// D2. [Third duplicate ACK.] NewReno and CUBIC first check that this ACK
    /// covers more than `recover`; if not, these duplicates belong to a loss
    /// already handled and are ignored (RFC 6582, 3.2 step 2). Then set
    /// ssthresh from the data in flight, FlightSize/2 (at least 2) for the
    /// Reno family and FlightSize times beta for CUBIC, and retransmit the
    /// missing segment. Tahoe drops to one segment and slow-starts from una.
    /// The others enter fast recovery with cwnd = ssthresh + 3 (F1).
    fn three_dupacks(&mut self, f: usize, ack: u64, flight: Option<usize>) {
        let s = &mut self.flows[f];
        let newreno = matches!(s.algo, Algo::NewReno | Algo::Cubic);
        if newreno && ack as i64 <= s.recover {
            let recover = s.recover;
            self.note(
                f,
                "D2",
                format!("ACK {ack} does not cover recover = {recover}: no fast retransmit"),
                flight,
            );
            return;
        }
        let flight_size = (s.max - s.una) as f64;
        s.recover = s.max as i64;
        s.totals.fast_retransmits += 1;
        if s.algo == Algo::Cubic {
            cubic_loss(s, self.p.fast_convergence);
            s.ssthresh = (flight_size * CUBIC_BETA).max(2.0);
        } else {
            s.ssthresh = (flight_size / 2.0).max(2.0);
        }
        let una = s.una;
        self.mark(f, "fast", una);
        if self.flows[f].algo == Algo::Tahoe {
            let s = &mut self.flows[f];
            s.cwnd = 1.0;
            s.nxt = s.una;
            self.note(
                f,
                "D2",
                format!("third duplicate: fast retransmit {una}; Tahoe sets cwnd = 1"),
                flight,
            );
            self.pump(f, "D2");
            return;
        }
        // F1. [Enter fast recovery.] Retransmit una, then cwnd = ssthresh + 3:
        // the three duplicates stand for three packets that have left.
        self.note(
            f,
            "D2",
            format!("third duplicate: fast retransmit {una}"),
            flight,
        );
        self.transmit(f, una, "D2");
        let s = &mut self.flows[f];
        s.cwnd = s.ssthresh + 3.0;
        s.recovery = true;
        s.partial_seen = false;
        self.note(
            f,
            "F1",
            "enter fast recovery: cwnd = ssthresh + 3".into(),
            flight,
        );
        self.pump(f, "F1");
    }

    /// T1. [Timeout.] The oldest segment's timer expired. Set ssthresh as for
    /// a loss, unless this segment has already timed out (then keep it; RFC
    /// 5681, 3.1) or the timer fired during fast recovery (then keep the
    /// smaller of the two; this model's choice, see below), drop cwnd to one segment, leave fast recovery, set
    /// recover to the highest segment sent (RFC 6582, step 4), back off the
    /// timer, go back to una and resend from there.
    fn on_timeout(&mut self, f: usize, generation: u64) {
        let s = &mut self.flows[f];
        if generation != s.generation || s.timer_at.is_none() || s.una >= s.max {
            return;
        }
        s.timer_at = None;
        s.totals.timeouts += 1;
        let flight_size = (s.max - s.una) as f64;
        if s.rto.backoffs == 0 {
            let cut = if s.algo == Algo::Cubic {
                (flight_size * CUBIC_BETA).max(2.0)
            } else {
                (flight_size / 2.0).max(2.0)
            };
            // During fast recovery this window's loss has already lowered
            // ssthresh, and FlightSize is swollen by the inflated window, so
            // keep the smaller value: one reduction per loss episode.
            s.ssthresh = if s.recovery { cut.min(s.ssthresh) } else { cut };
        }
        if s.algo == Algo::Cubic {
            s.cubic.epoch = None;
            s.cubic.reset = true;
        }
        s.cwnd = 1.0;
        s.recovery = false;
        s.dupacks = 0;
        s.recover = s.max as i64;
        s.rto.back_off();
        s.timing = None;
        s.nxt = s.una;
        let (una, rto, now) = (s.una, s.rto.rto_us, self.now);
        push_change(&mut s.series.rto, now, rto);
        self.mark(f, "timeout", una);
        self.note(
            f,
            "T1",
            format!(
                "timeout on {una}: cwnd = 1, RTO doubles to {:.0} ms",
                rto / 1000.0
            ),
            None,
        );
        self.trace(f);
        self.pump(f, "T1");
        if self.flows[f].timer_at.is_none() {
            self.restart_timer(f);
        }
    }

    fn sample(&mut self) {
        let dt = self.grid.dt_us;
        self.grid.t.push(self.now);
        for f in 0..self.flows.len() {
            let s = &mut self.flows[f];
            let bits = (s.rcv_next - s.delivered_mark) as f64 * self.p.mss_bytes as f64 * 8.0;
            s.delivered_mark = s.rcv_next;
            self.grid.cwnd[f].push(if s.started { s.cwnd } else { 0.0 });
            self.grid.rate[f].push(bits / (dt as f64 / 1e6));
        }
        self.grid.queue.push(self.queue_len());
        self.queue.push(self.now + dt, Ev::Sample);
    }

    fn finish(mut self) -> Run {
        let end = self.p.duration_us;
        let half = end / 2;
        self.now = end;
        self.queue_len_before = self.queue_len();
        self.trace_queue();
        let span = (end - half).max(1) as f64;
        let mss_bits = self.p.mss_bytes as f64 * 8.0;
        let mut flows = Vec::new();
        let mut series = Vec::new();
        for f in 0..self.flows.len() {
            self.now = end;
            self.trace(f);
            let s = &mut self.flows[f];
            // Goodput over the second half, from the grid's rate samples.
            let mut t = s.totals.clone();
            let late: Vec<f64> = self
                .grid
                .t
                .iter()
                .zip(&self.grid.rate[f])
                .filter(|(t, _)| **t > half)
                .map(|(_, r)| *r)
                .collect();
            t.goodput_bps = if late.is_empty() {
                s.rcv_next as f64 * mss_bits / (end as f64 / 1e6)
            } else {
                late.iter().sum::<f64>() / late.len() as f64
            };
            t.loss_rate = if s.late_arrivals > 0 {
                s.late_drops as f64 / s.late_arrivals as f64
            } else {
                0.0
            };
            t.mean_rtt_us = if s.rtt_n > 0 {
                s.rtt_sum / s.rtt_n as f64
            } else {
                s.rto.srtt_us
            };
            flows.push(t);
            let mut fs = std::mem::take(&mut s.series);
            fs.cwnd = decimate(fs.cwnd, MAX_POINTS);
            fs.ssthresh = decimate(fs.ssthresh, MAX_POINTS);
            fs.srtt = decimate(fs.srtt, MAX_POINTS);
            fs.rto = decimate(fs.rto, MAX_POINTS);
            series.push(fs);
        }
        let rates: Vec<f64> = flows.iter().map(|t| t.goodput_bps).collect();
        let sum: f64 = rates.iter().sum();
        let squares: f64 = rates.iter().map(|x| x * x).sum();
        let jain = if squares > 0.0 {
            sum * sum / (rates.len() as f64 * squares)
        } else {
            1.0
        };
        let theory = self.theory(&flows[0]);
        Run {
            series,
            queue: decimate(std::mem::take(&mut self.queue_series), MAX_POINTS),
            grid: std::mem::take(&mut self.grid),
            flights: std::mem::take(&mut self.flights),
            events: std::mem::take(&mut self.events),
            totals: Totals {
                flows,
                utilisation: self.busy_us as f64 / span,
                mean_queue: self.queue_area / span,
                max_queue: self.max_queue,
                jain,
            },
            theory,
            duration_us: end,
        }
    }

    fn theory(&self, flow0: &FlowTotals) -> Theory {
        let p = self.p;
        let tx = self.tx_us as f64;
        let rtt0 = p.flows[0].rtt_us as f64 + tx;
        let bdp = rtt0 / tx;
        let b = p.buffer_pkts as f64;
        let pipe = bdp + b + 1.0;
        let mss = p.mss_bytes as f64;
        let loss = flow0.loss_rate;
        let rtt = if flow0.mean_rtt_us > 0.0 {
            flow0.mean_rtt_us
        } else {
            rtt0
        };
        let rto = self.flows[0].rto.rto_us;
        let (mathis, pftk) = if loss > 0.0 {
            (mathis_bps(mss, rtt, loss), pftk_bps(mss, rtt, rto, loss))
        } else {
            (0.0, 0.0)
        };
        Theory {
            tx_us: tx,
            bdp_pkts: bdp,
            pipe_pkts: pipe,
            reno_utilisation: reno_utilisation(bdp, b + 1.0),
            mathis_bps: mathis,
            pftk_bps: pftk,
            cubic_k_s: cubic_k(pipe, pipe * CUBIC_BETA),
        }
    }
}

fn phase(s: &Sender) -> char {
    if s.recovery {
        'R'
    } else if s.cwnd < s.ssthresh {
        'S'
    } else {
        'A'
    }
}

/// F0. [CUBIC's loss response.] Remember the window before the cut as W_max;
/// with fast convergence, if it is below the last W_max the flow is losing
/// ground, so remember less, cwnd (1 + beta)/2 (RFC 9438, 4.6 and 4.7).
/// A new epoch starts at the next ACK in congestion avoidance.
fn cubic_loss(s: &mut Sender, fast_convergence: bool) {
    let c = &mut s.cubic;
    c.w_max = if fast_convergence && !c.reset && s.cwnd < c.w_max {
        s.cwnd * (1.0 + CUBIC_BETA) / 2.0
    } else {
        s.cwnd
    };
    c.cwnd_prior = s.cwnd;
    c.epoch = None;
    c.reset = false;
}

fn push_change(points: &mut Vec<(u64, f64)>, t: u64, v: f64) {
    match points.last_mut() {
        Some(&mut (_, last)) if last == v => {}
        Some(last) if last.0 == t => last.1 = v,
        _ => points.push((t, v)),
    }
}

/// Keep at most about `max` points: in each bucket the lowest and the highest,
/// in time order, so peaks and troughs survive.
fn decimate(points: Vec<(u64, f64)>, max: usize) -> Vec<(u64, f64)> {
    if points.len() <= max {
        return points;
    }
    let size = points.len().div_ceil(max / 2);
    let mut out = Vec::with_capacity(max + 1);
    for chunk in points.chunks(size) {
        let lo = chunk
            .iter()
            .enumerate()
            .min_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
            .map(|(i, _)| i)
            .unwrap_or(0);
        let hi = chunk
            .iter()
            .enumerate()
            .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
            .map(|(i, _)| i)
            .unwrap_or(0);
        let (a, b) = if lo <= hi { (lo, hi) } else { (hi, lo) };
        out.push(chunk[a]);
        if b != a {
            out.push(chunk[b]);
        }
    }
    if out.last() != points.last() {
        out.push(*points.last().unwrap_or(&(0, 0.0)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(algo: Algo) -> Params {
        Params {
            flows: vec![Flow {
                algo,
                rtt_us: 100_000,
                start_us: 0,
            }],
            rate_bps: 10_000_000,
            mss_bytes: 1500,
            buffer_pkts: 1000,
            loss: 0.0,
            drop_every: 0,
            jitter_us: 0,
            duration_us: 5_000_000,
            iw: 1.0,
            init_ssthresh: 40.0,
            max_window: 1e6,
            min_rto_us: 1_000_000,
            fast_convergence: false,
            seed: 1,
            drops: vec![],
            detail: None,
        }
    }

    fn with_drops(algo: Algo, segs: &[u64]) -> Run {
        let mut p = base(algo);
        p.drops = segs
            .iter()
            .map(|&seg| ScriptedDrop {
                flow: 0,
                seg,
                occurrence: 1,
            })
            .collect();
        run(&p)
    }

    #[test]
    fn rto_follows_rfc_6298() {
        let mut r = Rto::new(0.0);
        assert_eq!(r.rto_us, 1e6);
        r.sample(100_000.0);
        assert_eq!(
            (r.srtt_us, r.rttvar_us, r.rto_us),
            (100_000.0, 50_000.0, 300_000.0)
        );
        // RTTVAR is updated with the old SRTT; the other order gives 350 ms.
        r.sample(200_000.0);
        assert_eq!(
            (r.srtt_us, r.rttvar_us, r.rto_us),
            (112_500.0, 62_500.0, 362_500.0)
        );
        r.back_off();
        r.back_off();
        assert_eq!(r.rto_us, 1_450_000.0);
        r.sample(112_500.0);
        assert!(r.rto_us < 400_000.0 && r.backoffs == 0);
        let mut floored = Rto::new(1e6);
        floored.sample(10_000.0);
        assert_eq!(floored.rto_us, 1e6);
    }

    #[test]
    fn one_loss_is_repaired_by_fast_retransmit() {
        for algo in [Algo::Reno, Algo::NewReno, Algo::Cubic] {
            let r = with_drops(algo, &[30]);
            let t = &r.totals.flows[0];
            assert_eq!(
                (t.fast_retransmits, t.timeouts, t.retransmissions),
                (1, 0, 1),
                "{algo:?}"
            );
            // Reno deflates to ssthresh; NewReno to min(ssthresh, FlightSize + 1).
            let x = r.events.iter().find(|e| e.step == "F4").unwrap().state;
            let expected = match algo {
                Algo::Reno => x.ssthresh,
                _ => x.ssthresh.min((x.max - x.una).max(1) as f64 + 1.0),
            };
            assert_eq!(x.cwnd, expected, "{algo:?}");
            let enter = r.events.iter().find(|e| e.step == "F1").unwrap();
            assert_eq!(enter.state.cwnd, enter.state.ssthresh + 3.0);
        }
        let tahoe = with_drops(Algo::Tahoe, &[30]);
        let d2 = tahoe.events.iter().find(|e| e.step == "D2").unwrap();
        assert_eq!(d2.state.cwnd, 1.0);
    }

    #[test]
    fn newreno_survives_the_losses_that_stall_reno() {
        // Fall and Floyd (1996): three losses in one window.
        let reno = with_drops(Algo::Reno, &[30, 32, 34]);
        let newreno = with_drops(Algo::NewReno, &[30, 32, 34]);
        assert!(reno.totals.flows[0].timeouts >= 1);
        let t = &newreno.totals.flows[0];
        assert_eq!(
            (t.fast_retransmits, t.timeouts, t.retransmissions),
            (1, 0, 3)
        );
        let partials = newreno.series[0]
            .marks
            .iter()
            .filter(|m| m.kind == "partial")
            .count();
        assert_eq!(partials, 2);
        assert!(newreno.totals.flows[0].delivered > reno.totals.flows[0].delivered);
    }

    #[test]
    fn utilisation_follows_the_sawtooth_formula() {
        for b in [5, 20, 41, 84] {
            let mut p = base(Algo::NewReno);
            p.init_ssthresh = 1e9;
            p.buffer_pkts = b;
            p.duration_us = 120_000_000;
            let r = run(&p);
            let predicted = r.theory.reno_utilisation;
            assert!(
                (r.totals.utilisation - predicted).abs() < 0.02,
                "B = {b}: {} vs {predicted}",
                r.totals.utilisation
            );
        }
    }

    #[test]
    fn square_root_law_holds_as_loss_falls() {
        // Periodic loss, a link too fast to queue, no timeouts in the measured half.
        let ratio = |every: u32| {
            let mut p = base(Algo::Reno);
            p.init_ssthresh = 1e9;
            p.rate_bps = 1_000_000_000;
            p.drop_every = every;
            p.duration_us = 300_000_000;
            let r = run(&p);
            r.totals.flows[0].goodput_bps / r.theory.mathis_bps
        };
        let (high, low) = (ratio(100), ratio(1000));
        assert!(high < low, "{high} {low}");
        assert!((0.92..1.05).contains(&low), "{low}");
    }

    #[test]
    fn cubic_curve_meets_its_definition() {
        let (w_max, epoch) = (100.0, 70.0);
        let k = cubic_k(w_max, epoch);
        assert!((w_cubic(0.0, k, w_max) - epoch).abs() < 1e-9);
        assert!((w_cubic(k, k, w_max) - w_max).abs() < 1e-12);
        let r = with_drops(Algo::Cubic, &[30]);
        let cut = r.events.iter().find(|e| e.step == "D2").unwrap();
        let flight = (cut.state.max - cut.state.una) as f64;
        assert!((cut.state.ssthresh - CUBIC_BETA * flight).abs() < 1e-9);
    }

    #[test]
    fn equal_flows_share_and_longer_round_trips_lose() {
        let mut p = base(Algo::Reno);
        p.init_ssthresh = 1e9;
        p.buffer_pkts = 40;
        p.duration_us = 120_000_000;
        p.flows.push(Flow {
            algo: Algo::Reno,
            rtt_us: 100_000,
            start_us: 2_000_000,
        });
        assert!(run(&p).totals.jain > 0.99);
        p.flows[1].rtt_us = 200_000;
        let r = run(&p);
        let (a, b) = (r.totals.flows[0].goodput_bps, r.totals.flows[1].goodput_bps);
        assert!(a > 1.5 * b, "{a} {b}");
    }
}
