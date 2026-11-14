//! Reliable data transfer over a lossy, reordering channel.
//!
//! One sender, one receiver, a link of rate R in each direction and a
//! propagation delay with optional jitter (jitter is what reorders packets).
//! The protocol is not hard-coded: four rules, given as data, decide how the
//! sender and receiver behave. Stop-and-wait (rdt3.0), Go-Back-N and Selective
//! Repeat are three settings of those rules; the learner can mix them.
//!
//! Sequence numbers on the wire are taken modulo 2^k, and both ends interpret
//! them only from what they can see. Every packet also carries, hidden from
//! the protocol, the index of the message it really holds, so the model can
//! detect when a too-large window makes the receiver accept an old packet as
//! new (Kurose and Ross, Figure 3.27).
//!
//! The algorithms below are written in lettered steps; the trace names the
//! step that produced each event, and the page highlights it in this source.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum AckMode {
    /// "I have everything up to and including n."
    Cumulative,
    /// "I have n."
    Individual,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TimerMode {
    /// One timer, for the oldest unacknowledged packet.
    Single,
    /// One timer per outstanding packet.
    Each,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Resend {
    /// Retransmit every outstanding packet.
    All,
    /// Retransmit only the packet whose timer expired.
    One,
}

/// The protocol, as data.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rules {
    /// Receiver keeps correctly received out-of-order packets.
    pub buffer: bool,
    pub ack: AckMode,
    pub timer: TimerMode,
    pub resend: Resend,
}

impl Rules {
    pub const GO_BACK_N: Rules = Rules {
        buffer: false,
        ack: AckMode::Cumulative,
        timer: TimerMode::Single,
        resend: Resend::All,
    };
    pub const SELECTIVE_REPEAT: Rules = Rules {
        buffer: true,
        ack: AckMode::Individual,
        timer: TimerMode::Each,
        resend: Resend::One,
    };
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Data,
    Ack,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Drop,
    Keep,
    Delay,
}

/// A learner's edit to one transmission, recorded so that replay, links and
/// lab checks all see the same run. `number` is the message index for data and
/// the acknowledged index for ACKs; `occurrence` counts from 1.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Intervention {
    pub kind: Kind,
    pub number: i64,
    pub occurrence: u32,
    pub action: Action,
    #[serde(default)]
    pub delay_us: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Params {
    pub rules: Rules,
    pub window: u32,
    pub seq_bits: u32,
    pub messages: u32,
    pub data_bytes: u32,
    pub ack_bytes: u32,
    pub rate_bps: u64,
    pub prop_us: u64,
    pub jitter_us: u64,
    pub timeout_us: u64,
    pub loss_data: f64,
    pub loss_ack: f64,
    pub seed: u64,
    #[serde(default)]
    pub interventions: Vec<Intervention>,
}

/// One packet on the wire, from the start of its transmission to its fate.
#[derive(Serialize, Clone, Debug)]
pub struct Flight {
    pub id: usize,
    pub kind: Kind,
    /// Sequence or acknowledgement number as carried on the wire (mod 2^k).
    pub wire: u32,
    /// Message index really carried (data) or acknowledged (ACK). Hidden from the protocol.
    pub number: i64,
    pub occurrence: u32,
    pub t_start: u64,
    pub t_sent: u64,
    pub t_arrive: u64,
    pub lost: bool,
    /// What the far end did with it, once it arrived.
    pub fate: &'static str,
}

/// State after an event, compact enough to keep one per event.
#[derive(Serialize, Clone, Debug)]
pub struct Snapshot {
    /// Per message at the sender: '.' not yet sent, 'q' waiting for the link,
    /// 's' sent and unacknowledged, 'a' acknowledged.
    pub sender: String,
    /// Per message index as the receiver understands it: '.' nothing,
    /// 'b' buffered, 'd' delivered, 'x' delivered but it held other data.
    pub receiver: String,
    pub base: i64,
    pub next: i64,
    pub rcv_base: i64,
    /// Running timers as (message index, expiry time).
    pub timers: Vec<(i64, u64)>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: u64,
    pub who: char,
    pub step: &'static str,
    pub text: String,
    pub flight: Option<usize>,
    pub state: Snapshot,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Totals {
    pub completion_us: u64,
    pub transmissions: u32,
    pub retransmissions: u32,
    pub timeouts: u32,
    pub delivered: u32,
    pub misdelivered: u32,
    pub correct: bool,
    pub finished: bool,
    /// Useful bits divided by (R times completion time).
    pub utilisation: f64,
    pub goodput_bps: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Run {
    pub flights: Vec<Flight>,
    pub events: Vec<Event>,
    pub totals: Totals,
    pub theory: Theory,
}

/// The closed forms the page compares with the run (see `theory`).
#[derive(Serialize, Clone, Debug, Default)]
pub struct Theory {
    pub t_data_us: f64,
    pub t_ack_us: f64,
    pub rtt_us: f64,
    /// Expected time a window slot is held by one message, E[S].
    pub slot_us: f64,
    pub q_success: f64,
    /// Link bound (1 - p_d) and window bound N t / E[S].
    pub link_bound: f64,
    pub window_bound: f64,
    /// min(link, window); exact for stop-and-wait.
    pub bound: f64,
    /// Stallings' textbook approximations (timeout = round trip, lossless ACKs).
    pub stallings_sw: f64,
    pub stallings_gbn: f64,
    pub stallings_sr: f64,
    /// Smallest window that can keep the link busy without loss.
    pub window_to_fill: f64,
    pub seq_space: u32,
    /// Largest safe window for these rules and this sequence space.
    pub safe_window: u32,
}

/// The closed forms. With t = L/R, a = d_prop / t, q = (1-p_d)(1-p_a),
/// and timer T started when a transmission begins, one message holds its
/// window slot for E[S] = (1/q - 1) T + t + 2 d_prop + t_ack. The link can
/// carry at most a fraction (1 - p_d) of useful packets and the window at
/// most N t / E[S] (Little's law on the N slots), so U <= min of the two.
pub fn theory(p: &Params) -> Theory {
    let t = p.data_bytes as f64 * 8.0 / p.rate_bps as f64 * 1e6;
    let ta = p.ack_bytes as f64 * 8.0 / p.rate_bps as f64 * 1e6;
    let d = p.prop_us as f64 + p.jitter_us as f64 / 2.0;
    let rtt = 2.0 * d;
    let q = (1.0 - p.loss_data) * (1.0 - p.loss_ack);
    let slot = (1.0 / q - 1.0) * p.timeout_us as f64 + t + rtt + ta;
    let n = p.window as f64;
    let link = 1.0 - p.loss_data;
    let window = n * t / slot;
    let a = d / t;
    let pd = p.loss_data;
    let fill = 1.0 + 2.0 * a;
    let stallings_sw = (1.0 - pd) / (1.0 + 2.0 * a);
    let stallings_sr = if n >= fill {
        1.0 - pd
    } else {
        n * (1.0 - pd) / fill
    };
    let stallings_gbn = if n >= fill {
        (1.0 - pd) / (1.0 + 2.0 * a * pd)
    } else {
        n * (1.0 - pd) / (fill * (1.0 - pd + n * pd))
    };
    let m = 1u32 << p.seq_bits.min(16);
    let safe = if p.rules.buffer { m / 2 } else { m - 1 };
    Theory {
        t_data_us: t,
        t_ack_us: ta,
        rtt_us: rtt,
        slot_us: slot,
        q_success: q,
        link_bound: link,
        window_bound: window,
        bound: link.min(window),
        stallings_sw,
        stallings_gbn,
        stallings_sr,
        window_to_fill: (t + rtt + ta) / t,
        seq_space: m,
        safe_window: safe,
    }
}

enum Ev {
    DataLinkFree,
    AckLinkFree,
    DataArrive(usize),
    AckArrive(usize),
    Timeout { index: i64, generation: u64 },
}

struct Sim<'a> {
    p: &'a Params,
    rng: Rng,
    queue: Queue<Ev>,
    now: u64,
    modulus: i64,
    // Sender.
    status: Vec<u8>,
    base: i64,
    next: i64,
    sends: Vec<u32>,
    data_queue: VecDeque<i64>,
    data_busy: bool,
    generation: u64,
    single_timer: Option<(i64, u64, u64)>,
    timers: Vec<Option<(u64, u64)>>,
    // Receiver.
    rcv_base: i64,
    held: Vec<Option<i64>>,
    delivered: Vec<bool>,
    ack_queue: VecDeque<i64>,
    ack_busy: bool,
    ack_sends: std::collections::HashMap<i64, u32>,
    // Output.
    flights: Vec<Flight>,
    events: Vec<Event>,
    totals: Totals,
}

/// Events kept for the page; the run continues past this but stops recording.
pub const MAX_EVENTS: usize = 20_000;
/// Simulated time limit, as a guard against settings that never finish.
const TIME_LIMIT_US: u64 = 600_000_000;

pub fn run(p: &Params) -> Run {
    let n = p.messages as usize;
    let mut sim = Sim {
        p,
        rng: Rng::new(p.seed),
        queue: Queue::default(),
        now: 0,
        modulus: 1i64 << p.seq_bits.clamp(1, 16),
        status: vec![b'.'; n],
        base: 0,
        next: 0,
        sends: vec![0; n],
        data_queue: VecDeque::new(),
        data_busy: false,
        generation: 0,
        single_timer: None,
        timers: vec![None; n],
        rcv_base: 0,
        held: vec![None; n],
        delivered: vec![false; n],
        ack_queue: VecDeque::new(),
        ack_busy: false,
        ack_sends: Default::default(),
        flights: Vec::new(),
        events: Vec::new(),
        totals: Totals::default(),
    };
    sim.record(
        'S',
        "S1",
        "start: the application hands over all messages".into(),
        None,
    );
    sim.fill_window();
    while let Some((at, ev)) = sim.queue.pop() {
        if at > TIME_LIMIT_US {
            break;
        }
        sim.now = at;
        match ev {
            Ev::DataLinkFree => {
                sim.data_busy = false;
                sim.start_data();
            }
            Ev::AckLinkFree => {
                sim.ack_busy = false;
                sim.start_ack();
            }
            Ev::DataArrive(id) => sim.receive_data(id),
            Ev::AckArrive(id) => sim.receive_ack(id),
            Ev::Timeout { index, generation } => sim.timeout(index, generation),
        }
    }
    sim.finish()
}

impl Sim<'_> {
    fn wire(&self, index: i64) -> u32 {
        index.rem_euclid(self.modulus) as u32
    }

    fn snapshot(&self) -> Snapshot {
        let receiver = (0..self.p.messages as usize)
            .map(|i| match (self.delivered[i], self.held[i]) {
                (true, Some(real)) if real != i as i64 => 'x',
                (true, _) => 'd',
                (false, Some(_)) => 'b',
                _ => '.',
            })
            .collect();
        let mut timers: Vec<(i64, u64)> = match self.p.rules.timer {
            TimerMode::Single => self
                .single_timer
                .iter()
                .map(|&(i, _, at)| (i, at))
                .collect(),
            TimerMode::Each => self
                .timers
                .iter()
                .enumerate()
                .filter_map(|(i, t)| t.map(|(_, at)| (i as i64, at)))
                .collect(),
        };
        timers.sort_unstable();
        Snapshot {
            sender: String::from_utf8_lossy(&self.status).into_owned(),
            receiver,
            base: self.base,
            next: self.next,
            rcv_base: self.rcv_base,
            timers,
        }
    }

    fn record(&mut self, who: char, step: &'static str, text: String, flight: Option<usize>) {
        if self.events.len() < MAX_EVENTS {
            let state = self.snapshot();
            self.events.push(Event {
                t: self.now,
                who,
                step,
                text,
                flight,
                state,
            });
        }
    }

    /// The channel's verdict on one transmission. Two random draws are made for
    /// every packet whether or not an intervention overrides them, so editing
    /// one packet never changes the luck of the packets after it.
    fn channel(&mut self, kind: Kind, number: i64, occurrence: u32) -> (bool, u64) {
        let loss = if kind == Kind::Data {
            self.p.loss_data
        } else {
            self.p.loss_ack
        };
        let mut lost = self.rng.unit() < loss;
        let mut delay = self.p.prop_us + self.rng.upto(self.p.jitter_us);
        for iv in &self.p.interventions {
            if iv.kind == kind && iv.number == number && iv.occurrence == occurrence {
                match iv.action {
                    Action::Drop => lost = true,
                    Action::Keep => lost = false,
                    Action::Delay => delay += iv.delay_us,
                }
            }
        }
        (lost, delay)
    }

    // Algorithm S, the sender.

    /// S1. [Fill the window.] While next < base + N and messages remain,
    /// hand message `next` to the link and advance `next`.
    fn fill_window(&mut self) {
        let n = self.p.messages as i64;
        while self.next < n && self.next < self.base + self.p.window as i64 {
            let i = self.next;
            self.status[i as usize] = b'q';
            self.data_queue.push_back(i);
            self.next += 1;
            let text = format!("send message {i} as seq {}", self.wire(i));
            self.record('S', "S1", text, None);
        }
        self.start_data();
    }

    /// S2. [Transmit.] If the link is idle, put the head of the queue on the
    /// wire and start its timer (rule: one timer, or one per packet).
    fn start_data(&mut self) {
        if self.data_busy {
            return;
        }
        let Some(i) = self.data_queue.pop_front() else {
            return;
        };
        if self.status[i as usize] == b'a' {
            return self.start_data();
        }
        self.status[i as usize] = b's';
        self.sends[i as usize] += 1;
        let occurrence = self.sends[i as usize];
        self.totals.transmissions += 1;
        if occurrence > 1 {
            self.totals.retransmissions += 1;
        }
        let t = (self.p.data_bytes as u64 * 8 * 1_000_000).div_ceil(self.p.rate_bps.max(1));
        let (lost, delay) = self.channel(Kind::Data, i, occurrence);
        let id = self.flights.len();
        self.flights.push(Flight {
            id,
            kind: Kind::Data,
            wire: self.wire(i),
            number: i,
            occurrence,
            t_start: self.now,
            t_sent: self.now + t,
            t_arrive: self.now + t + delay,
            lost,
            fate: if lost { "lost" } else { "in flight" },
        });
        self.data_busy = true;
        self.queue.push(self.now + t, Ev::DataLinkFree);
        if !lost {
            self.queue.push(self.now + t + delay, Ev::DataArrive(id));
        }
        match self.p.rules.timer {
            TimerMode::Single => {
                if self.single_timer.is_none() {
                    self.arm_single(i);
                }
            }
            TimerMode::Each => {
                self.generation += 1;
                let at = self.now + self.p.timeout_us;
                self.timers[i as usize] = Some((self.generation, at));
                self.queue.push(
                    at,
                    Ev::Timeout {
                        index: i,
                        generation: self.generation,
                    },
                );
            }
        }
        let again = if occurrence > 1 { " (again)" } else { "" };
        let text = format!("transmit seq {}{again}, start timer", self.wire(i));
        self.record('S', "S2", text, Some(id));
    }

    fn arm_single(&mut self, index: i64) {
        self.generation += 1;
        let at = self.now + self.p.timeout_us;
        self.single_timer = Some((index, self.generation, at));
        self.queue.push(
            at,
            Ev::Timeout {
                index,
                generation: self.generation,
            },
        );
    }

    /// S3. [Receive ACK.] Read the number as the sender must: as the one
    /// index in its window with that value mod 2^k. A cumulative ACK
    /// acknowledges everything up to it; an individual ACK one packet.
    /// Then slide `base` past acknowledged packets and refill (S1).
    fn receive_ack(&mut self, id: usize) {
        let wire = self.flights[id].wire as i64;
        let window_lo = match self.p.rules.ack {
            AckMode::Cumulative => self.base - 1,
            AckMode::Individual => self.base,
        };
        let mut candidates =
            (window_lo.max(-1)..self.next).filter(|k| k.rem_euclid(self.modulus) == wire);
        let k = match self.p.rules.ack {
            AckMode::Cumulative => candidates.next_back(),
            AckMode::Individual => candidates.find(|&k| k >= 0 && self.status[k as usize] != b'a'),
        };
        let before = self.base;
        let fate = match (self.p.rules.ack, k) {
            (_, None) => "ignored",
            (AckMode::Cumulative, Some(k)) if k < self.base => "duplicate",
            (AckMode::Cumulative, Some(k)) => {
                for j in self.base..=k {
                    self.acknowledge(j);
                }
                "advances base"
            }
            (AckMode::Individual, Some(k)) => {
                self.acknowledge(k);
                "marks one"
            }
        };
        while self.base < self.next && self.status[self.base as usize] == b'a' {
            self.base += 1;
        }
        self.flights[id].fate = fate;
        if self.p.rules.timer == TimerMode::Single && self.base != before {
            self.single_timer = None;
            if self.base < self.next {
                self.arm_single(self.base);
            }
        }
        let text = match k {
            Some(k) => format!("ACK {wire} read as {k}: {fate}; base = {}", self.base),
            None => format!("ACK {wire} matches nothing outstanding: ignored"),
        };
        self.record('S', "S3", text, Some(id));
        // S5. [Done.] When the base passes the last message, every message
        // has been delivered and acknowledged; record the completion time.
        if self.base == self.p.messages as i64 && !self.totals.finished {
            self.totals.finished = true;
            self.totals.completion_us = self.now;
            self.record('S', "S5", "every message acknowledged".into(), None);
        }
        self.fill_window();
    }

    fn acknowledge(&mut self, k: i64) {
        self.status[k as usize] = b'a';
        self.timers[k as usize] = None;
    }

    /// S4. [Timeout.] Retransmit by rule: every outstanding packet (Go-Back-N)
    /// or only the one whose timer expired (Selective Repeat); then S2.
    fn timeout(&mut self, index: i64, generation: u64) {
        let live = match self.p.rules.timer {
            TimerMode::Single => self.single_timer.is_some_and(|(_, g, _)| g == generation),
            TimerMode::Each => self.timers[index as usize].is_some_and(|(g, _)| g == generation),
        };
        if !live {
            return;
        }
        self.totals.timeouts += 1;
        self.single_timer = None;
        self.timers[index as usize] = None;
        let resend: Vec<i64> = match self.p.rules.resend {
            Resend::All => (self.base..self.next)
                .filter(|&j| self.status[j as usize] == b's')
                .collect(),
            Resend::One => vec![index],
        };
        for &j in &resend {
            if !self.data_queue.contains(&j) && self.status[j as usize] != b'a' {
                self.status[j as usize] = b'q';
                self.data_queue.push_back(j);
            }
        }
        let list: Vec<String> = resend.iter().map(|&j| self.wire(j).to_string()).collect();
        let text = format!(
            "timer for seq {} expires: resend {}",
            self.wire(index),
            list.join(", ")
        );
        self.record('S', "S4", text, None);
        self.start_data();
    }

    // Algorithm R, the receiver.

    /// R1. [Interpret.] The receiver sees only the wire number s. With
    /// d = (s - rcv_base) mod 2^k: if d < W it is new, index rcv_base + d
    /// (W = N when buffering, else 1). Otherwise, if it is one of the N
    /// before rcv_base, it is old. When N > 2^(k-1) these two ranges
    /// overlap and an old packet can be taken for a new one.
    fn interpret(&self, wire: i64) -> Option<(i64, bool)> {
        let w = if self.p.rules.buffer {
            self.p.window as i64
        } else {
            1
        };
        let d = (wire - self.rcv_base).rem_euclid(self.modulus);
        if d < w {
            return Some((self.rcv_base + d, true));
        }
        let e = (self.rcv_base - wire).rem_euclid(self.modulus);
        if e >= 1 && e <= self.p.window as i64 && self.rcv_base - e >= 0 {
            return Some((self.rcv_base - e, false));
        }
        None
    }

    fn receive_data(&mut self, id: usize) {
        let wire = self.flights[id].wire as i64;
        let real = self.flights[id].number;
        let n = self.p.messages as i64;
        let (fate, step, text) = match self.interpret(wire) {
            Some((k, true)) if k < n => {
                // R2. [Accept.] Keep the packet at index k.
                if self.held[k as usize].is_none() {
                    self.held[k as usize] = Some(real);
                }
                // R3. [Deliver.] Pass the in-order run up to the application.
                let mut run = Vec::new();
                while self.rcv_base < n && self.held[self.rcv_base as usize].is_some() {
                    let j = self.rcv_base as usize;
                    self.delivered[j] = true;
                    self.totals.delivered += 1;
                    if self.held[j] != Some(j as i64) {
                        self.totals.misdelivered += 1;
                    }
                    run.push(j);
                    self.rcv_base += 1;
                }
                let wrong = k != real;
                let fate = match (wrong, run.is_empty()) {
                    (true, _) => "accepted as the wrong message",
                    (false, true) => "buffered",
                    (false, false) => "delivered",
                };
                let text = if run.is_empty() {
                    format!("seq {wire} read as {k}: buffer it")
                } else {
                    format!("seq {wire} read as {k}: deliver {}", ranges(&run))
                };
                (fate, if run.is_empty() { "R2" } else { "R3" }, text)
            }
            Some((k, true)) => (
                // A real receiver does not know where the stream ends: an old
                // packet read as a message past the last one is accepted too.
                "accepted as the wrong message",
                "R2",
                format!("seq {wire} read as {k}, past the last message: buffer it (it holds message {real})"),
            ),
            Some((k, _)) => (
                "duplicate",
                "R1",
                format!("seq {wire} read as old {k}: re-acknowledge"),
            ),
            None => {
                let fate = if self.p.rules.buffer {
                    "outside window"
                } else {
                    "out of order"
                };
                (
                    fate,
                    "R1",
                    format!(
                        "seq {wire} is not the expected {}: discard",
                        self.wire(self.rcv_base)
                    ),
                )
            }
        };
        self.flights[id].fate = fate;
        self.record('R', step, text, Some(id));
        // R4. [Acknowledge.] Cumulative: the last in-order index. Individual:
        // the index just received, if it is new or one of the N old ones.
        let ack = match self.p.rules.ack {
            AckMode::Cumulative => Some(self.rcv_base - 1),
            AckMode::Individual => self.interpret_for_ack(wire),
        };
        if let Some(a) = ack {
            self.ack_queue.push_back(a);
            let text = format!("queue ACK {}", self.wire(a));
            self.record('R', "R4", text, None);
            self.start_ack();
        }
    }

    fn interpret_for_ack(&self, wire: i64) -> Option<i64> {
        // After delivery rcv_base may have moved; re-read the number against
        // the window as it was a moment ago by trying both readings.
        let w = self.p.window as i64;
        (self.rcv_base - w..self.rcv_base + w)
            .filter(|&k| k >= 0 && k < self.p.messages as i64)
            .find(|&k| k.rem_euclid(self.modulus) == wire && self.held[k as usize].is_some())
    }

    fn start_ack(&mut self) {
        if self.ack_busy {
            return;
        }
        let Some(a) = self.ack_queue.pop_front() else {
            return;
        };
        let count = self.ack_sends.entry(a).or_insert(0);
        *count += 1;
        let occurrence = *count;
        let t = (self.p.ack_bytes as u64 * 8 * 1_000_000).div_ceil(self.p.rate_bps.max(1));
        let (lost, delay) = self.channel(Kind::Ack, a, occurrence);
        let id = self.flights.len();
        self.flights.push(Flight {
            id,
            kind: Kind::Ack,
            wire: self.wire(a),
            number: a,
            occurrence,
            t_start: self.now,
            t_sent: self.now + t,
            t_arrive: self.now + t + delay,
            lost,
            fate: if lost { "lost" } else { "in flight" },
        });
        self.ack_busy = true;
        self.queue.push(self.now + t, Ev::AckLinkFree);
        if !lost {
            self.queue.push(self.now + t + delay, Ev::AckArrive(id));
        }
    }

    fn finish(mut self) -> Run {
        let n = self.p.messages as usize;
        self.totals.correct = self.totals.delivered as usize == n && self.totals.misdelivered == 0;
        if !self.totals.finished {
            self.totals.completion_us = self.now;
        }
        if self.totals.completion_us > 0 {
            // Count only messages that reached the application as themselves:
            // an unfinished run has delivered fewer than n.
            let good = (self.totals.delivered - self.totals.misdelivered) as f64;
            let bits = good * self.p.data_bytes as f64 * 8.0;
            let secs = self.totals.completion_us as f64 / 1e6;
            self.totals.goodput_bps = bits / secs;
            self.totals.utilisation = self.totals.goodput_bps / self.p.rate_bps as f64;
        }
        Run {
            flights: self.flights,
            events: self.events,
            totals: self.totals,
            theory: theory(self.p),
        }
    }
}

fn ranges(items: &[usize]) -> String {
    match items {
        [one] => one.to_string(),
        [first, .., last] => format!("{first} to {last}"),
        [] => String::new(),
    }
}

/// Utilisation against data loss for the three classic protocols, for the
/// page's sweep chart. Each row is (p, then measured stop-and-wait, Go-Back-N
/// and Selective Repeat, then the stop-and-wait closed form, Stallings'
/// Go-Back-N approximation and the Selective Repeat bound min(link, window)).
pub fn sweep(base: &Params, losses: &[f64]) -> Vec<[f64; 7]> {
    losses
        .iter()
        .map(|&loss| {
            let mut row = [loss, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
            let variants = [
                (Rules::GO_BACK_N, 1u32),
                (Rules::GO_BACK_N, base.window),
                (Rules::SELECTIVE_REPEAT, base.window),
            ];
            for (slot, (rules, window)) in variants.into_iter().enumerate() {
                let p = Params {
                    rules,
                    window,
                    seq_bits: 16,
                    loss_data: loss,
                    interventions: Vec::new(),
                    ..base.clone()
                };
                let r = run(&p);
                row[slot + 1] = r.totals.utilisation;
                match slot {
                    0 => row[4] = r.theory.bound,
                    1 => row[5] = r.theory.stallings_gbn,
                    _ => row[6] = r.theory.bound,
                }
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(rules: Rules, window: u32) -> Params {
        Params {
            rules,
            window,
            seq_bits: 16,
            messages: 3000,
            data_bytes: 1000,
            ack_bytes: 40,
            rate_bps: 8_000_000,
            prop_us: 5_000,
            jitter_us: 0,
            timeout_us: 12_000,
            loss_data: 0.0,
            loss_ack: 0.0,
            seed: 1,
            interventions: Vec::new(),
        }
    }

    #[test]
    fn every_mix_of_rules_is_reliable_with_enough_sequence_numbers() {
        // The four rules are offered as independent switches, so all 16
        // protocols must deliver every message, once and in order, on a
        // channel that loses in both directions and reorders.
        for bits in 0..16u32 {
            let rules = Rules {
                buffer: bits & 1 != 0,
                ack: if bits & 2 != 0 {
                    AckMode::Cumulative
                } else {
                    AckMode::Individual
                },
                timer: if bits & 4 != 0 {
                    TimerMode::Single
                } else {
                    TimerMode::Each
                },
                resend: if bits & 8 != 0 {
                    Resend::All
                } else {
                    Resend::One
                },
            };
            let mut p = params(rules, 8);
            p.messages = 300;
            p.loss_data = 0.1;
            p.loss_ack = 0.1;
            p.jitter_us = 2_000;
            p.timeout_us = 30_000;
            let r = run(&p);
            assert!(
                r.totals.finished && r.totals.correct,
                "{rules:?}: {:?}",
                r.totals
            );
        }
    }

    #[test]
    fn extreme_settings_still_run() {
        for (rate, bytes, prop) in [(10_000_000_000u64, 40u32, 0u64), (1_000, 12_000, 200_000)] {
            let mut p = params(Rules::SELECTIVE_REPEAT, 64);
            p.rate_bps = rate;
            p.data_bytes = bytes;
            p.ack_bytes = 0;
            p.prop_us = prop;
            p.messages = 20;
            p.timeout_us = 1_000_000;
            let r = run(&p);
            // The slow link cannot finish inside the 600 s limit; it must
            // still stop cleanly and report sane numbers.
            assert_eq!(r.totals.misdelivered, 0);
            assert!(
                r.totals.utilisation <= 1.0 + 1e-9,
                "{rate} {bytes} {prop}: {:?}",
                r.totals
            );
            assert_eq!(r.totals.finished, rate > 1_000);
        }
    }

    #[test]
    fn stop_and_wait_matches_its_closed_form() {
        // N = 1 with loss in both directions: U = t / E[S] exactly in expectation.
        let mut p = params(Rules::GO_BACK_N, 1);
        p.loss_data = 0.1;
        p.loss_ack = 0.05;
        let run = run(&p);
        assert!(run.totals.correct);
        let predicted = run.theory.bound;
        let measured = run.totals.utilisation;
        assert!(
            (measured / predicted - 1.0).abs() < 0.04,
            "{measured} vs {predicted}"
        );
    }

    #[test]
    fn lossless_pipelining_matches_window_formula_and_saturates() {
        for window in [1, 4, 8, 20] {
            let run = run(&params(Rules::SELECTIVE_REPEAT, window));
            let predicted = run.theory.bound;
            assert!(
                (run.totals.utilisation / predicted - 1.0).abs() < 0.01,
                "N = {window}"
            );
        }
        // The bound is min(1, N t / RTT'), so N = 20 saturates the link.
        assert!(run(&params(Rules::GO_BACK_N, 20)).totals.utilisation > 0.99);
    }

    #[test]
    fn selective_repeat_beats_go_back_n_under_loss_and_respects_the_link_bound() {
        let mut gbn = params(Rules::GO_BACK_N, 16);
        let mut sr = params(Rules::SELECTIVE_REPEAT, 16);
        gbn.loss_data = 0.1;
        sr.loss_data = 0.1;
        let (g, s) = (run(&gbn), run(&sr));
        assert!(g.totals.correct && s.totals.correct);
        assert!(s.totals.utilisation > 1.3 * g.totals.utilisation);
        assert!(s.totals.utilisation <= s.theory.link_bound + 0.01);
    }

    #[test]
    fn window_beyond_half_the_sequence_space_breaks_selective_repeat() {
        // Kurose and Ross, Figure 3.27: sequence numbers 0..3, window 3, all
        // three ACKs lost. The retransmitted packet 0 is accepted as message 4.
        let mut p = params(Rules::SELECTIVE_REPEAT, 3);
        p.seq_bits = 2;
        p.messages = 6;
        for number in 0..3 {
            let iv = Intervention {
                kind: Kind::Ack,
                number,
                occurrence: 1,
                action: Action::Drop,
                delay_us: 0,
            };
            p.interventions.push(iv);
        }
        let bad = run(&p);
        assert!(bad.totals.misdelivered > 0 && !bad.totals.correct);
        p.window = 2; // N <= 2^(k-1)
        assert!(run(&p).totals.correct);
    }
}
