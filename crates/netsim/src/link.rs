//! The link layer's first problem: many stations, one medium.
//!
//! Three ways of sharing it, each a pure function of its parameters and a
//! seed:
//!
//! - ALOHA and slotted ALOHA (Abramson 1970; Roberts 1972): send when you
//!   like (or at the next slot boundary) and hope nobody else does.
//! - CSMA/CD with binary exponential backoff, as classic shared Ethernet does
//!   it (IEEE 802.3, Clause 4): listen first, keep listening while sending,
//!   stop and jam on a collision, then wait a random number of slot times.
//!   Signals take time to cross the cable, so this model works in
//!   nanoseconds and tracks every signal's edges at every station.
//! - CSMA/CA, the distributed coordination function of IEEE 802.11: listen,
//!   count down a random backoff only while the medium is idle, and have
//!   every frame acknowledged. Optional RTS/CTS lets stations that cannot
//!   hear the sender learn from the receiver how long to stay quiet (the
//!   network allocation vector, NAV).
//!
//! The steps are lettered; the trace names the step behind each event and the
//! page highlights it in this source.

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------
// ALOHA and slotted ALOHA
// ---------------------------------------------------------------------------

/// N stations that always have a frame to send, all frames one frame time
/// long. A station that collides simply tries again later; whether its next
/// frame is new or a retransmission makes no difference to the channel.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AlohaParams {
    pub slotted: bool,
    pub stations: usize,
    /// Offered load G: attempts per frame time, all stations together.
    pub g: f64,
    pub frame_us: u64,
    /// Length of the run, in frame times.
    pub length: u64,
    pub seed: u64,
    #[serde(default = "yes")]
    pub trace: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AlohaFrame {
    pub id: usize,
    pub station: usize,
    /// Which attempt at the station's current frame, from 1.
    pub attempt: u32,
    /// May be negative: a frame already on the air when the run begins.
    pub start_us: i64,
    pub end_us: i64,
    pub ok: bool,
    /// The earliest other frame it overlapped.
    pub hit: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AlohaEvent {
    pub t: i64,
    pub step: &'static str,
    pub frame: usize,
    /// "clear" or "collides" for a start; "delivered" or "garbled" for an end.
    pub what: &'static str,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct AlohaStats {
    /// Frames started in [0, length).
    pub attempts: usize,
    pub delivered: usize,
    /// Measured attempts and successes per frame time.
    pub g: f64,
    pub s: f64,
    /// The exact throughput for this many stations, and the Poisson limit.
    pub theory: f64,
    pub limit: f64,
    pub per_station: Vec<usize>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AlohaRun {
    pub frames: Vec<AlohaFrame>,
    pub events: Vec<AlohaEvent>,
    pub stats: AlohaStats,
}

/// Throughput per frame time at offered load `g` with `n` stations: exact
/// for this model, and its limit as n grows with g fixed, which is the
/// textbook S = G e^{-G} (slotted) or S = G e^{-2G} (pure).
///
/// Slotted: each station sends in a slot with probability q = g/n, and a
/// frame succeeds if none of the other n - 1 does, so S = g (1 - q)^{n-1}.
/// Pure: each station alternates a frame of one frame time with an
/// exponential silence of mean m = n/g - 1 frame times. A frame starting at
/// t survives if no other station is on the air at any moment of
/// (t, t + 1): that station must be silent at t (probability m/(1+m)) and
/// stay silent one more frame time (probability e^{-1/m}, since silences
/// are memoryless). So S = g ((1 - q) e^{-q/(1-q)})^{n-1}.
pub fn aloha_theory(slotted: bool, n: usize, g: f64) -> (f64, f64) {
    let n_f = n as f64;
    let q = g / n_f;
    if slotted {
        (g * (1.0 - q).powf(n_f - 1.0), g * (-g).exp())
    } else {
        let exact = if q >= 1.0 {
            if n == 1 {
                1.0
            } else {
                0.0
            }
        } else {
            g * ((1.0 - q) * (-q / (1.0 - q)).exp()).powf(n_f - 1.0)
        };
        (exact, g * (-2.0 * g).exp())
    }
}

/// Failures before the first success in trials of probability q.
fn geometric(rng: &mut Rng, q: f64) -> i64 {
    if q >= 1.0 {
        rng.next_u64();
        0
    } else {
        ((1.0 - rng.unit()).ln() / (1.0 - q).ln()).floor() as i64
    }
}

pub fn aloha_run(p: &AlohaParams) -> AlohaRun {
    let f = p.frame_us as i64;
    let end = p.length as i64 * f;
    let n = p.stations;
    let q = p.g / n as f64;
    let mut starts: Vec<(i64, usize)> = Vec::new();
    for k in 0..n {
        let mut rng = Rng::new(p.seed ^ (k as u64 + 1).wrapping_mul(0xA24B_AED4_963E_E407));
        if q <= 0.0 {
            continue;
        }
        if p.slotted {
            // A1. [Choose when to send.] Slotted: frames start only at slot
            // boundaries, and each station sends in each slot with
            // probability q = G/n, independently. The gap to its next slot
            // is drawn at once, as a geometric number of skipped slots.
            let mut slot: i64 = -1;
            loop {
                slot += 1 + geometric(&mut rng, q);
                if slot * f >= end + f {
                    break;
                }
                starts.push((slot * f, k));
            }
        } else {
            // Pure: after each frame the station falls silent for an
            // exponential time of mean m frame times, m = n/G - 1, so it
            // starts 1/(1 + m) = G/n frames per frame time. The run begins
            // in the steady state: with probability G/n the station is part
            // way through a frame, otherwise it is silent, and a silence
            // has no memory of how long it has lasted.
            let m = (1.0 / q - 1.0) * f as f64;
            let mut t = if rng.unit() < q {
                -((rng.unit() * f as f64) as i64)
            } else {
                rng.exp(m).round() as i64
            };
            while t < end + f {
                starts.push((t, k));
                t += f + rng.exp(m).round() as i64;
            }
        }
    }
    starts.sort();
    let mut frames: Vec<AlohaFrame> = starts
        .iter()
        .enumerate()
        .map(|(id, &(s, k))| AlohaFrame {
            id,
            station: k,
            attempt: 1,
            start_us: s,
            end_us: s + f,
            ok: true,
            hit: None,
        })
        .collect();
    // A3. [Check for overlap.] Every frame lasts one frame time, so two
    // frames overlap exactly when they start less than a frame time apart:
    // a pure-ALOHA frame is vulnerable for two frame times, a slotted one
    // only to others in its own slot. Overlapping frames are both lost.
    for i in 0..frames.len() {
        let mut j = i + 1;
        while j < frames.len() && frames[j].start_us < frames[i].start_us + f {
            frames[i].ok = false;
            frames[j].ok = false;
            frames[i].hit.get_or_insert(j);
            frames[j].hit = Some(frames[j].hit.map_or(i, |h| h.min(i)));
            j += 1;
        }
    }
    // A station that lost its last frame is retrying it.
    let mut last_ok = vec![true; n];
    let mut tries = vec![0u32; n];
    for fr in frames.iter_mut() {
        let k = fr.station;
        tries[k] = if last_ok[k] { 1 } else { tries[k] + 1 };
        fr.attempt = tries[k];
        last_ok[k] = fr.ok;
    }

    let mut events = Vec::new();
    if p.trace {
        for fr in frames.iter().filter(|fr| fr.start_us < end) {
            // A2. [Send.] The station puts its frame on the air without
            // listening first.
            let earlier = fr.hit.is_some_and(|h| h < fr.id);
            let what = if earlier { "collides" } else { "clear" };
            events.push((fr.start_us, 1, fr.id, "A2", what));
            let what = if fr.ok { "delivered" } else { "garbled" };
            events.push((fr.end_us, 0, fr.id, "A3", what));
        }
        events.sort_by_key(|e| (e.0, e.1, e.2));
    }
    let events = events
        .into_iter()
        .map(|(t, _, frame, step, what)| AlohaEvent {
            t,
            step,
            frame,
            what,
        })
        .collect();

    let mut stats = AlohaStats {
        per_station: vec![0; n],
        ..Default::default()
    };
    for fr in frames
        .iter()
        .filter(|fr| fr.start_us >= 0 && fr.start_us < end)
    {
        stats.attempts += 1;
        if fr.ok {
            stats.delivered += 1;
            stats.per_station[fr.station] += 1;
        }
    }
    stats.g = stats.attempts as f64 / p.length as f64;
    stats.s = stats.delivered as f64 / p.length as f64;
    (stats.theory, stats.limit) = aloha_theory(p.slotted, n, p.g);
    // The page draws frames on the air during the run, not the extra frame
    // time generated past its end to settle the last overlaps.
    frames.retain(|fr| fr.start_us < end);
    AlohaRun {
        frames,
        events,
        stats,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AlohaPoint {
    pub g: f64,
    pub measured_g: f64,
    pub s: f64,
}

/// Throughput at each offered load, without traces.
pub fn aloha_sweep(base: &AlohaParams, gs: &[f64]) -> Vec<AlohaPoint> {
    gs.iter()
        .map(|&g| {
            let r = aloha_run(&AlohaParams {
                g,
                trace: false,
                ..base.clone()
            });
            AlohaPoint {
                g,
                measured_g: r.stats.g,
                s: r.stats.s,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// CSMA/CD with binary exponential backoff
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CdStation {
    pub name: String,
    /// Where the station taps the cable, in metres from one end.
    pub pos_m: u32,
    /// When its first frame is ready.
    #[serde(default)]
    pub start_ns: u64,
    /// Frames it has to send; 0 means it always has another.
    #[serde(default)]
    pub frames: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CdParams {
    pub stations: Vec<CdStation>,
    pub rate_bps: u64,
    /// Every frame's length, header and checksum included (the preamble is
    /// left out, as the 64-byte minimum leaves it out).
    pub frame_bytes: u32,
    /// 512 bit times in IEEE 802.3 at 10 and 100 Mb/s.
    pub slot_bits: u32,
    /// 32 bits.
    pub jam_bits: u32,
    /// The interframe gap, 96 bit times.
    pub ifg_bits: u32,
    pub speed_mps: u64,
    /// 16: a frame is dropped after its sixteenth collision.
    pub attempt_limit: u32,
    /// 10: the backoff range stops doubling after the tenth collision.
    pub backoff_cap: u32,
    pub duration_ns: u64,
    pub seed: u64,
    #[serde(default = "yes")]
    pub trace: bool,
}

/// One transmission: a frame, or the start of one cut short and jammed.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CdTx {
    pub id: usize,
    pub station: usize,
    /// The station's frame number, from 0, and which attempt at it, from 1.
    pub frame: u32,
    pub attempt: u32,
    pub start_ns: u64,
    /// When the station stopped: the frame's end, or the end of the jam.
    pub end_ns: u64,
    /// When the station heard another signal and began to jam.
    pub detect_ns: Option<u64>,
    /// "delivered", "collided" (detected and jammed), "undetected" (sent in
    /// full, so the sender thinks it got through, but another signal
    /// overlapped it at some station), "aborted" (its sixteenth collision),
    /// or "unfinished" (still on the air when the run ends).
    pub outcome: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CdBackoff {
    pub station: usize,
    pub t_ns: u64,
    /// Collisions of this frame so far, n.
    pub collisions: u32,
    pub k: u64,
    /// The largest K allowed: 2^min(n, 10) - 1.
    pub max: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct CdEvent {
    pub t: u64,
    pub step: &'static str,
    pub station: usize,
    pub tx: Option<usize>,
    pub what: &'static str,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct CdStats {
    pub delivered: usize,
    pub collided: usize,
    pub aborted: usize,
    pub undetected: usize,
    /// Fraction of the run spent carrying frames that got through.
    pub efficiency: f64,
    pub frame_ns: u64,
    pub slot_ns: u64,
    pub jam_ns: u64,
    pub ifg_ns: u64,
    /// The longest one-way trip between two stations.
    pub tau_ns: u64,
    /// a = tau / frame time.
    pub a: f64,
    /// The longest a station sent before it heard a collision.
    pub max_detect_ns: u64,
    pub per_station: Vec<usize>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CdRun {
    pub txs: Vec<CdTx>,
    pub backoffs: Vec<CdBackoff>,
    pub events: Vec<CdEvent>,
    pub stats: CdStats,
}

/// E5's range: after a frame's nth collision K is drawn from 0 to
/// 2^min(n, cap) - 1; at the attempt limit there is no range, because the
/// frame is dropped.
pub fn beb_max(n: u32, cap: u32, limit: u32) -> Option<u64> {
    (n < limit).then(|| (1u64 << n.min(cap)) - 1)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CdState {
    /// Nothing to send.
    Idle,
    /// A frame is ready but the medium is busy.
    Defer,
    /// The medium is idle; waiting out the interframe gap.
    Gap,
    Send,
    Jam,
    Backoff,
}

struct CdSt {
    state: CdState,
    /// Other stations' signals passing this station now.
    heard: usize,
    /// Bumped to cancel a pending timer.
    gen: u64,
    /// Frames left; u32::MAX for a station that always has one.
    left: u32,
    frame: u32,
    collisions: u32,
    tx: usize,
}

enum CdEv {
    Ready(usize),
    Gap(usize, u64),
    End(usize, u64),
    Retry(usize, u64),
    /// The leading or trailing edge of a transmission reaches a station.
    On(usize, usize),
    Off(usize),
}

struct CdSim<'a> {
    p: &'a CdParams,
    st: Vec<CdSt>,
    q: Queue<CdEv>,
    rng: Rng,
    txs: Vec<CdTx>,
    backoffs: Vec<CdBackoff>,
    events: Vec<CdEvent>,
    frame_ns: u64,
    slot_ns: u64,
    jam_ns: u64,
    ifg_ns: u64,
}

impl CdSim<'_> {
    fn bits_ns(&self, bits: u64) -> u64 {
        ((bits as u128 * 1_000_000_000 + self.p.rate_bps as u128 / 2) / self.p.rate_bps as u128)
            as u64
    }

    fn d(&self, i: usize, j: usize) -> u64 {
        cd_prop_ns(self.p, i, j)
    }

    fn log(
        &mut self,
        t: u64,
        step: &'static str,
        station: usize,
        tx: Option<usize>,
        what: &'static str,
    ) {
        if self.p.trace {
            self.events.push(CdEvent {
                t,
                step,
                station,
                tx,
                what,
            });
        }
    }

    /// E1. [Sense the carrier.] A station with a frame listens. If no other
    /// signal is passing its tap it waits out the interframe gap; if one is,
    /// it defers and tries again the moment the cable falls quiet
    /// (1-persistent).
    fn try_send(&mut self, t: u64, i: usize) {
        self.st[i].gen += 1;
        if self.st[i].heard == 0 {
            self.st[i].state = CdState::Gap;
            let g = self.st[i].gen;
            self.q.push(t + self.ifg_ns, CdEv::Gap(i, g));
            self.log(t, "E1", i, None, "idle");
        } else {
            self.st[i].state = CdState::Defer;
            self.log(t, "E1", i, None, "busy");
        }
    }

    /// E2. [Transmit.] The gap passed in silence, so the station sends. Its
    /// signal spreads both ways along the cable and reaches each other
    /// station after the distance over the signal speed.
    fn transmit(&mut self, t: u64, i: usize) {
        let id = self.txs.len();
        self.txs.push(CdTx {
            id,
            station: i,
            frame: self.st[i].frame,
            attempt: self.st[i].collisions + 1,
            start_ns: t,
            end_ns: t + self.frame_ns,
            detect_ns: None,
            outcome: "unfinished",
        });
        let s = &mut self.st[i];
        s.state = CdState::Send;
        s.tx = id;
        s.gen += 1;
        let g = s.gen;
        self.q.push(t + self.frame_ns, CdEv::End(i, g));
        for j in 0..self.st.len() {
            if j != i {
                self.q.push(t + self.d(i, j), CdEv::On(j, id));
            }
        }
        self.log(t, "E2", i, Some(id), "");
    }

    fn on(&mut self, t: u64, j: usize, from: usize) {
        self.st[j].heard += 1;
        match self.st[j].state {
            CdState::Gap => {
                self.st[j].gen += 1;
                self.st[j].state = CdState::Defer;
                self.log(t, "E1", j, Some(from), "busy");
            }
            CdState::Send => {
                // E3. [Detect the collision and jam.] Another signal arrives
                // while the station is still sending: the frame is lost. It
                // stops the frame at once and sends 32 bits of jam, so that
                // every station sees the collision too.
                let tx = self.st[j].tx;
                self.txs[tx].detect_ns = Some(t);
                self.txs[tx].end_ns = t + self.jam_ns;
                self.st[j].state = CdState::Jam;
                self.st[j].gen += 1;
                let g = self.st[j].gen;
                self.q.push(t + self.jam_ns, CdEv::End(j, g));
                self.log(t, "E3", j, Some(tx), "");
            }
            _ => {}
        }
    }

    fn off(&mut self, t: u64, j: usize) {
        self.st[j].heard -= 1;
        if self.st[j].heard == 0 && self.st[j].state == CdState::Defer {
            self.try_send(t, j);
        }
    }

    fn next_frame(&mut self, t: u64, i: usize) {
        let s = &mut self.st[i];
        s.collisions = 0;
        s.frame += 1;
        if s.left != u32::MAX {
            s.left -= 1;
        }
        if s.left > 0 {
            self.try_send(t, i);
        } else {
            s.state = CdState::Idle;
        }
    }

    fn end(&mut self, t: u64, i: usize) {
        let tx = self.st[i].tx;
        self.txs[tx].end_ns = t;
        for j in 0..self.st.len() {
            if j != i {
                self.q.push(t + self.d(i, j), CdEv::Off(j));
            }
        }
        if self.st[i].state == CdState::Send {
            // E4. [Finish.] The whole frame went out and the station heard
            // nothing else while sending it. If the frame lasts at least a
            // round trip across the cable, that means it got through.
            self.txs[tx].outcome = "delivered";
            self.log(t, "E4", i, Some(tx), "");
            self.next_frame(t, i);
            return;
        }
        self.txs[tx].outcome = "collided";
        self.st[i].collisions += 1;
        let n = self.st[i].collisions;
        match beb_max(n, self.p.backoff_cap, self.p.attempt_limit) {
            Some(max) => {
                // E5. [Back off.] After the nth collision of this frame the
                // station waits K slot times, K uniform on 0 to
                // 2^min(n, 10) - 1, then listens again. Each collision
                // doubles the range, so the more stations are contending, the
                // more widely their retries spread.
                let k = self.rng.upto(max);
                self.backoffs.push(CdBackoff {
                    station: i,
                    t_ns: t,
                    collisions: n,
                    k,
                    max,
                });
                let s = &mut self.st[i];
                s.state = CdState::Backoff;
                s.gen += 1;
                let g = s.gen;
                self.q.push(t + k * self.slot_ns, CdEv::Retry(i, g));
                self.log(t, "E5", i, Some(tx), "");
            }
            None => {
                // E6. [Give up.] Sixteen collisions in a row: the frame is
                // dropped and reported as excessive collisions, and the
                // station moves on to its next frame.
                self.txs[tx].outcome = "aborted";
                self.log(t, "E6", i, Some(tx), "");
                self.next_frame(t, i);
            }
        }
    }
}

/// One-way propagation time between stations i and j.
pub fn cd_prop_ns(p: &CdParams, i: usize, j: usize) -> u64 {
    let m = p.stations[i].pos_m.abs_diff(p.stations[j].pos_m) as u128;
    ((m * 1_000_000_000 + p.speed_mps as u128 / 2) / p.speed_mps as u128) as u64
}

pub fn cd_run(p: &CdParams) -> CdRun {
    let n = p.stations.len();
    let mut sim = CdSim {
        p,
        st: p
            .stations
            .iter()
            .map(|s| CdSt {
                state: CdState::Idle,
                heard: 0,
                gen: 0,
                left: if s.frames == 0 { u32::MAX } else { s.frames },
                frame: 0,
                collisions: 0,
                tx: 0,
            })
            .collect(),
        q: Queue::default(),
        rng: Rng::new(p.seed),
        txs: Vec::new(),
        backoffs: Vec::new(),
        events: Vec::new(),
        frame_ns: 0,
        slot_ns: 0,
        jam_ns: 0,
        ifg_ns: 0,
    };
    sim.frame_ns = sim.bits_ns(p.frame_bytes as u64 * 8);
    sim.slot_ns = sim.bits_ns(p.slot_bits as u64);
    sim.jam_ns = sim.bits_ns(p.jam_bits as u64);
    sim.ifg_ns = sim.bits_ns(p.ifg_bits as u64);
    for (i, s) in p.stations.iter().enumerate() {
        sim.q.push(s.start_ns, CdEv::Ready(i));
    }
    while let Some((t, ev)) = sim.q.pop() {
        if t > p.duration_ns {
            break;
        }
        let live = |sim: &CdSim, i: usize, g: u64| sim.st[i].gen == g;
        match ev {
            CdEv::Ready(i) => sim.try_send(t, i),
            CdEv::Gap(i, g) => {
                if live(&sim, i, g) && sim.st[i].state == CdState::Gap {
                    sim.transmit(t, i);
                }
            }
            CdEv::End(i, g) => {
                if live(&sim, i, g) {
                    sim.end(t, i);
                }
            }
            CdEv::Retry(i, g) => {
                if live(&sim, i, g) {
                    sim.try_send(t, i);
                }
            }
            CdEv::On(j, from) => sim.on(t, j, from),
            CdEv::Off(j) => sim.off(t, j),
        }
    }

    // A frame the sender finished without hearing anything may still have
    // met another signal somewhere on the cable, after its own last bit had
    // left the sender: possible only when frames are shorter than a round
    // trip. Look for any overlap at any station's tap.
    let tau_ns = (0..n)
        .flat_map(|i| (0..n).map(move |j| (i, j)))
        .map(|(i, j)| cd_prop_ns(p, i, j))
        .max()
        .unwrap_or(0);
    let span = sim.frame_ns + 2 * tau_ns;
    let mut txs = sim.txs;
    for x in 0..txs.len() {
        if txs[x].outcome != "delivered" {
            continue;
        }
        let (sx, ex, ix) = (txs[x].start_ns, txs[x].end_ns, txs[x].station);
        let lo = txs.partition_point(|z| z.start_ns + span < sx);
        let hit = txs[lo..]
            .iter()
            .take_while(|z| z.start_ns <= ex + span)
            .filter(|z| z.id != x)
            .any(|z| {
                (0..n).any(|y| {
                    let (dx, dz) = (cd_prop_ns(p, ix, y), cd_prop_ns(p, z.station, y));
                    sx + dx < z.end_ns + dz && z.start_ns + dz < ex + dx
                })
            });
        if hit {
            txs[x].outcome = "undetected";
        }
    }

    let mut stats = CdStats {
        frame_ns: sim.frame_ns,
        slot_ns: sim.slot_ns,
        jam_ns: sim.jam_ns,
        ifg_ns: sim.ifg_ns,
        tau_ns,
        a: tau_ns as f64 / sim.frame_ns as f64,
        per_station: vec![0; n],
        ..Default::default()
    };
    let mut carried = 0u64;
    for tx in &txs {
        match tx.outcome {
            "delivered" => {
                stats.delivered += 1;
                stats.per_station[tx.station] += 1;
                carried += tx.end_ns - tx.start_ns;
            }
            "collided" => stats.collided += 1,
            "aborted" => {
                stats.collided += 1;
                stats.aborted += 1;
            }
            "undetected" => stats.undetected += 1,
            _ => {}
        }
        if let Some(d) = tx.detect_ns {
            stats.max_detect_ns = stats.max_detect_ns.max(d - tx.start_ns);
        }
    }
    stats.efficiency = carried as f64 / p.duration_ns as f64;
    CdRun {
        txs,
        backoffs: sim.backoffs,
        events: sim.events,
        stats,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CdPoint {
    pub frame_bytes: u32,
    pub a: f64,
    pub efficiency: f64,
}

/// Efficiency at each frame length, without traces.
pub fn cd_sweep(base: &CdParams, frame_bytes: &[u32]) -> Vec<CdPoint> {
    frame_bytes
        .iter()
        .map(|&b| {
            let r = cd_run(&CdParams {
                frame_bytes: b,
                trace: false,
                ..base.clone()
            });
            CdPoint {
                frame_bytes: b,
                a: r.stats.a,
                efficiency: r.stats.efficiency,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// CSMA/CA: the 802.11 distributed coordination function
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CaNode {
    pub name: String,
    pub x_m: f64,
    pub y_m: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CaFlow {
    pub from: usize,
    pub to: usize,
    /// Frames to send; 0 means the sender always has another.
    #[serde(default)]
    pub frames: u32,
    #[serde(default)]
    pub start_us: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CaParams {
    pub nodes: Vec<CaNode>,
    /// One range for hearing and for decoding: within it a frame is decoded
    /// if nothing else overlaps it there; beyond it, nothing is heard.
    pub range_m: f64,
    pub flows: Vec<CaFlow>,
    /// Precede every data frame with RTS/CTS.
    pub rts: bool,
    pub rate_bps: u64,
    pub payload_bytes: u32,
    /// 9 and 16 microseconds in 802.11a/g; DIFS = SIFS + 2 slots.
    pub slot_us: u64,
    pub sifs_us: u64,
    /// The contention window runs from 15 to 1023 slots.
    pub cw_min: u32,
    pub cw_max: u32,
    /// Attempts before a frame is dropped (the short retry limit, 7).
    pub attempt_limit: u32,
    /// The physical-layer preamble and header before every frame.
    pub preamble_us: u64,
    pub duration_us: u64,
    pub seed: u64,
    #[serde(default = "yes")]
    pub trace: bool,
}

/// A frame on the air.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Air {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    /// "rts", "cts", "data" or "ack".
    pub kind: &'static str,
    pub flow: usize,
    pub start_us: u64,
    pub end_us: u64,
    /// The duration field: how long after this frame the exchange goes on.
    pub nav_us: u64,
    /// Nodes in range that decoded it, and nodes in range that could not
    /// (another frame overlapped it there, or they were sending).
    pub heard_by: Vec<usize>,
    pub lost_at: Vec<usize>,
    /// Decoded by its addressee.
    pub ok: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CaNav {
    pub node: usize,
    pub air: usize,
    pub from_us: u64,
    pub until_us: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct CaEvent {
    pub t: u64,
    pub step: &'static str,
    pub node: usize,
    pub air: Option<usize>,
    pub what: &'static str,
    /// The node's backoff counter after the event, in slots.
    pub backoff: u32,
    pub cw: u32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct CaFlowStats {
    pub delivered: usize,
    pub data_sent: usize,
    pub data_lost: usize,
    pub rts_sent: usize,
    pub rts_lost: usize,
    pub dropped: usize,
    pub throughput_bps: f64,
    /// Time the sender spent held back only by transmissions that could
    /// not have collided with its own: it heard them, but its receiver could
    /// not, and their receivers could not hear it.
    pub needless_us: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct CaStats {
    pub flows: Vec<CaFlowStats>,
    pub difs_us: u64,
    pub data_us: u64,
    pub ack_us: u64,
    pub rts_us: u64,
    pub cts_us: u64,
    /// Data frames not decoded by their addressee, over data frames sent.
    pub data_loss: f64,
    pub rts_loss: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct CaRun {
    pub airs: Vec<Air>,
    pub navs: Vec<CaNav>,
    pub events: Vec<CaEvent>,
    pub stats: CaStats,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Idle,
    Contend,
    Sending,
    WaitCts,
    WaitAck,
}

struct CaNodeSt {
    flow: Option<usize>,
    left: u32,
    phase: Phase,
    backoff: u32,
    cw: u32,
    attempts: u32,
    /// In-range transmitters on the air.
    cs: usize,
    sending: bool,
    nav: u64,
    busy: bool,
    idle_since: u64,
    /// A countdown is running: it began at `count_from` and fires at `fire`.
    counting: bool,
    count_from: u64,
    fire: u64,
    cgen: u64,
    tgen: u64,
}

enum CaEv {
    Arrive(usize),
    Count(usize, u64),
    End(usize),
    /// A reply SIFS after a frame: (node, kind, to, flow, nav).
    Reply(usize, &'static str, usize, usize, u64),
    Timeout(usize, u64),
    Nav(usize),
}

struct CaSim<'a> {
    p: &'a CaParams,
    n: Vec<CaNodeSt>,
    near: Vec<Vec<bool>>,
    q: Queue<CaEv>,
    rng: Rng,
    airs: Vec<Air>,
    navs: Vec<CaNav>,
    events: Vec<CaEvent>,
    stats: CaStats,
    max_air: u64,
}

/// Whether two nodes hear each other.
pub fn ca_near(p: &CaParams, a: usize, b: usize) -> bool {
    let (u, v) = (&p.nodes[a], &p.nodes[b]);
    (u.x_m - v.x_m).hypot(u.y_m - v.y_m) <= p.range_m
}

/// Air time of a frame of `bytes`: the preamble, then the bits at the rate.
pub fn ca_air_us(p: &CaParams, bytes: u32) -> u64 {
    p.preamble_us + (bytes as u64 * 8_000_000).div_ceil(p.rate_bps)
}

/// MAC header and checksum of a data frame; RTS, CTS and ACK lengths.
pub const DATA_HEADER: u32 = 28;
pub const RTS_BYTES: u32 = 20;
pub const CTS_BYTES: u32 = 14;
pub const ACK_BYTES: u32 = 14;

impl CaSim<'_> {
    fn difs(&self) -> u64 {
        self.p.sifs_us + 2 * self.p.slot_us
    }

    fn log(
        &mut self,
        t: u64,
        step: &'static str,
        node: usize,
        air: Option<usize>,
        what: &'static str,
    ) {
        if self.p.trace {
            self.events.push(CaEvent {
                t,
                step,
                node,
                air,
                what,
                backoff: self.n[node].backoff,
                cw: self.n[node].cw,
            });
        }
    }

    /// W1. [Sense the medium.] A node treats the medium as busy while it is
    /// sending, while it hears another node in range sending (physical
    /// carrier sense), and until its NAV runs out (virtual carrier sense).
    fn is_busy(&self, x: usize, t: u64) -> bool {
        let s = &self.n[x];
        s.sending || s.cs > 0 || s.nav > t
    }

    /// W2. [Count down, or freeze.] A contending node counts its backoff
    /// down one slot for every slot the medium stays idle after a DIFS of
    /// silence. When the medium turns busy it freezes the count, keeping the
    /// slots it has not yet used, and resumes after the next DIFS of
    /// silence. A count that reaches zero in the very slot another node
    /// starts sending still sends: nodes cannot hear a frame that begins in
    /// the same slot, which is how two nodes that drew the same slot collide.
    fn refresh(&mut self, x: usize, t: u64) {
        let b = self.is_busy(x, t);
        if b == self.n[x].busy {
            return;
        }
        self.n[x].busy = b;
        if b {
            let s = &mut self.n[x];
            if s.counting && s.fire > t {
                let used = if t > s.count_from {
                    (t - s.count_from) / self.p.slot_us
                } else {
                    0
                };
                s.backoff -= (used as u32).min(s.backoff);
                s.counting = false;
                s.cgen += 1;
                self.log(t, "W2", x, None, "freeze");
            }
        } else {
            self.n[x].idle_since = t;
            if self.n[x].phase == Phase::Contend {
                self.countdown(x, t);
            }
        }
    }

    fn countdown(&mut self, x: usize, t: u64) {
        let difs = self.difs();
        let s = &mut self.n[x];
        s.count_from = (s.idle_since + difs).max(t);
        s.fire = s.count_from + s.backoff as u64 * self.p.slot_us;
        s.counting = true;
        s.cgen += 1;
        let g = s.cgen;
        let fire = s.fire;
        self.q.push(fire, CaEv::Count(x, g));
        self.log(t, "W2", x, None, "count");
    }

    /// Enter contention with a backoff of `slots`.
    fn contend(&mut self, x: usize, t: u64, slots: u32) {
        self.n[x].phase = Phase::Contend;
        self.n[x].backoff = slots;
        if self.is_busy(x, t) {
            self.n[x].busy = true;
        } else {
            // The medium may have fallen idle this very instant, before
            // this node's sensing caught up.
            if self.n[x].busy {
                self.n[x].idle_since = t;
            }
            self.n[x].busy = false;
            self.countdown(x, t);
        }
    }

    fn put_on_air(
        &mut self,
        x: usize,
        t: u64,
        kind: &'static str,
        to: usize,
        flow: usize,
        nav_us: u64,
    ) -> usize {
        let bytes = match kind {
            "rts" => RTS_BYTES,
            "cts" => CTS_BYTES,
            "ack" => ACK_BYTES,
            _ => self.p.payload_bytes + DATA_HEADER,
        };
        let id = self.airs.len();
        let end = t + ca_air_us(self.p, bytes);
        self.airs.push(Air {
            id,
            from: x,
            to,
            kind,
            flow,
            start_us: t,
            end_us: end,
            nav_us,
            heard_by: vec![],
            lost_at: vec![],
            ok: false,
        });
        self.n[x].sending = true;
        self.q.push(end, CaEv::End(id));
        for y in 0..self.n.len() {
            if y != x && self.near[x][y] {
                self.n[y].cs += 1;
                self.refresh(y, t);
            }
        }
        self.refresh(x, t);
        id
    }

    /// W3. [Send.] The countdown reached zero: send RTS first if RTS/CTS is
    /// on, otherwise the data frame itself. Each frame's duration field says
    /// how much longer the exchange will hold the medium after it ends:
    /// RTS, three SIFS plus CTS, data and ACK; data, one SIFS plus the ACK.
    fn send_own(&mut self, x: usize, t: u64) {
        let f = self.n[x].flow.expect("only senders contend");
        let to = self.p.flows[f].to;
        let st = &self.stats;
        let (sifs, cts, data, ack) = (self.p.sifs_us, st.cts_us, st.data_us, st.ack_us);
        self.n[x].phase = Phase::Sending;
        self.n[x].counting = false;
        let id = if self.p.rts {
            self.stats.flows[f].rts_sent += 1;
            self.put_on_air(x, t, "rts", to, f, 3 * sifs + cts + data + ack)
        } else {
            self.stats.flows[f].data_sent += 1;
            self.put_on_air(x, t, "data", to, f, sifs + ack)
        };
        self.log(t, "W3", x, Some(id), "");
    }

    /// Whether node y decoded frame `a`: in range, not sending itself at any
    /// moment of it, and no other in-range frame overlapping it.
    fn decoded(&self, a: usize, y: usize) -> bool {
        let air = &self.airs[a];
        let lo = air.start_us.saturating_sub(self.max_air);
        self.airs
            .iter()
            .rev()
            .take_while(|b| b.start_us >= lo)
            .all(|b| {
                b.id == a
                    || b.end_us <= air.start_us
                    || b.start_us >= air.end_us
                    || (b.from != y && !self.near[b.from][y])
            })
    }

    fn end(&mut self, a: usize, t: u64) {
        let (x, to, kind, flow, nav) = {
            let air = &self.airs[a];
            (air.from, air.to, air.kind, air.flow, air.nav_us)
        };
        self.n[x].sending = false;
        for y in 0..self.n.len() {
            if y != x && self.near[x][y] {
                self.n[y].cs -= 1;
            }
        }
        // W4. [Receive.] Every node in range that decoded the frame acts on
        // it. Its addressee answers after a SIFS, shorter than any DIFS, so
        // nobody can take the medium in between: CTS for an RTS (only if its
        // own NAV is clear), ACK for data. Every other node that decoded it
        // sets its NAV to the end of the duration field and stays quiet that
        // long, whether or not it can hear the rest of the exchange.
        let mut heard = vec![];
        let mut lost = vec![];
        for y in 0..self.n.len() {
            if y == x || !self.near[x][y] {
                continue;
            }
            if !self.decoded(a, y) {
                lost.push(y);
                continue;
            }
            heard.push(y);
            if y == to {
                match kind {
                    "rts" if self.n[y].nav <= t => {
                        let cts = self.stats.cts_us;
                        let back = nav.saturating_sub(self.p.sifs_us + cts);
                        self.q
                            .push(t + self.p.sifs_us, CaEv::Reply(y, "cts", x, flow, back));
                    }
                    "data" => self
                        .q
                        .push(t + self.p.sifs_us, CaEv::Reply(y, "ack", x, flow, 0)),
                    "cts" if self.n[y].phase == Phase::WaitCts => {
                        // W5. [Data after CTS.] The sender has the floor: it
                        // sends its data one SIFS after the CTS.
                        self.n[y].tgen += 1;
                        let ack = self.stats.ack_us;
                        self.q.push(
                            t + self.p.sifs_us,
                            CaEv::Reply(y, "data", x, flow, self.p.sifs_us + ack),
                        );
                    }
                    "ack" if self.n[y].phase == Phase::WaitAck => {
                        self.n[y].tgen += 1;
                        self.success(y, t);
                    }
                    _ => {}
                }
            } else if nav > 0 && t + nav > self.n[y].nav {
                self.n[y].nav = t + nav;
                self.navs.push(CaNav {
                    node: y,
                    air: a,
                    from_us: t,
                    until_us: t + nav,
                });
                self.q.push(t + nav, CaEv::Nav(y));
                self.log(t, "W4", y, Some(a), "nav");
            }
        }
        let ok = heard.contains(&to);
        match kind {
            "data" if !ok => self.stats.flows[flow].data_lost += 1,
            "rts" if !ok => self.stats.flows[flow].rts_lost += 1,
            _ => {}
        }
        let air = &mut self.airs[a];
        air.heard_by = heard;
        air.lost_at = lost;
        air.ok = ok;
        self.log(t, "W4", x, Some(a), if ok { "decoded" } else { "lost" });
        // The sender of RTS or data now waits for the answer: one SIFS, the
        // answer's air time, and a slot of grace.
        if kind == "rts" || kind == "data" {
            let (phase, wait) = if kind == "rts" {
                (Phase::WaitCts, self.stats.cts_us)
            } else {
                (Phase::WaitAck, self.stats.ack_us)
            };
            self.n[x].phase = phase;
            self.n[x].tgen += 1;
            let g = self.n[x].tgen;
            self.q.push(
                t + self.p.sifs_us + wait + self.p.slot_us,
                CaEv::Timeout(x, g),
            );
        }
        for y in 0..self.n.len() {
            if y == x || self.near[x][y] {
                self.refresh(y, t);
            }
        }
    }

    /// W7. [Delivered.] The ACK came back: reset the window and start
    /// contending for the next frame with a fresh backoff, so that a node
    /// with a queue does not grab the medium straight back.
    fn success(&mut self, x: usize, t: u64) {
        let f = self.n[x].flow.expect("sender");
        self.stats.flows[f].delivered += 1;
        self.log(t, "W7", x, None, "");
        self.next_frame(x, t);
    }

    fn next_frame(&mut self, x: usize, t: u64) {
        let s = &mut self.n[x];
        s.cw = self.p.cw_min;
        s.attempts = 0;
        if s.left != u32::MAX {
            s.left -= 1;
        }
        if s.left == 0 {
            s.phase = Phase::Idle;
            return;
        }
        let slots = self.rng.upto(self.p.cw_min as u64) as u32;
        self.contend(x, t, slots);
    }

    /// W6. [Time out and back off.] No CTS or no ACK: count the attempt,
    /// double the contention window (to at most 1023 slots) and draw a new
    /// backoff from it. After seven attempts the frame is dropped.
    fn timeout(&mut self, x: usize, t: u64) {
        let f = self.n[x].flow.expect("sender");
        self.n[x].attempts += 1;
        if self.n[x].attempts >= self.p.attempt_limit {
            self.stats.flows[f].dropped += 1;
            self.log(t, "W6", x, None, "drop");
            self.next_frame(x, t);
            return;
        }
        let cw = (2 * self.n[x].cw + 1).min(self.p.cw_max);
        self.n[x].cw = cw;
        let slots = self.rng.upto(cw as u64) as u32;
        self.contend(x, t, slots);
        self.log(t, "W6", x, None, "retry");
    }
}

pub fn ca_run(p: &CaParams) -> CaRun {
    let k = p.nodes.len();
    let near: Vec<Vec<bool>> = (0..k)
        .map(|a| (0..k).map(|b| a != b && ca_near(p, a, b)).collect())
        .collect();
    let mut nodes: Vec<CaNodeSt> = (0..k)
        .map(|_| CaNodeSt {
            flow: None,
            left: 0,
            phase: Phase::Idle,
            backoff: 0,
            cw: p.cw_min,
            attempts: 0,
            cs: 0,
            sending: false,
            nav: 0,
            busy: false,
            idle_since: 0,
            counting: false,
            count_from: 0,
            fire: 0,
            cgen: 0,
            tgen: 0,
        })
        .collect();
    for (f, fl) in p.flows.iter().enumerate() {
        nodes[fl.from].flow = Some(f);
        nodes[fl.from].left = if fl.frames == 0 { u32::MAX } else { fl.frames };
    }
    let stats = CaStats {
        flows: vec![CaFlowStats::default(); p.flows.len()],
        difs_us: p.sifs_us + 2 * p.slot_us,
        data_us: ca_air_us(p, p.payload_bytes + DATA_HEADER),
        ack_us: ca_air_us(p, ACK_BYTES),
        rts_us: ca_air_us(p, RTS_BYTES),
        cts_us: ca_air_us(p, CTS_BYTES),
        ..Default::default()
    };
    let mut sim = CaSim {
        p,
        n: nodes,
        near,
        q: Queue::default(),
        rng: Rng::new(p.seed),
        airs: vec![],
        navs: vec![],
        events: vec![],
        max_air: stats.data_us.max(stats.rts_us),
        stats,
    };
    for fl in &p.flows {
        sim.q.push(fl.start_us, CaEv::Arrive(fl.from));
    }
    while let Some((t, ev)) = sim.q.pop() {
        if t > p.duration_us {
            break;
        }
        match ev {
            CaEv::Arrive(x) => {
                // A first frame that finds the medium idle goes after one
                // DIFS with no backoff; one that finds it busy draws one.
                let slots = if sim.is_busy(x, t) {
                    sim.rng.upto(p.cw_min as u64) as u32
                } else {
                    0
                };
                sim.contend(x, t, slots);
            }
            CaEv::Count(x, g) => {
                if sim.n[x].cgen == g && sim.n[x].phase == Phase::Contend {
                    sim.n[x].backoff = 0;
                    sim.send_own(x, t);
                }
            }
            CaEv::End(a) => sim.end(a, t),
            CaEv::Reply(y, kind, to, flow, nav) => {
                if sim.n[y].sending {
                    continue;
                }
                if kind == "data" {
                    if sim.n[y].phase != Phase::WaitCts {
                        continue;
                    }
                    sim.n[y].phase = Phase::Sending;
                    sim.stats.flows[flow].data_sent += 1;
                }
                let id = sim.put_on_air(y, t, kind, to, flow, nav);
                let step = if kind == "data" { "W5" } else { "W4" };
                sim.log(t, step, y, Some(id), kind);
            }
            CaEv::Timeout(x, g) => {
                if sim.n[x].tgen == g && matches!(sim.n[x].phase, Phase::WaitCts | Phase::WaitAck) {
                    sim.timeout(x, t);
                }
            }
            CaEv::Nav(x) => sim.refresh(x, t),
        }
    }

    let mut stats = sim.stats;
    let airs = sim.airs;
    let (mut sent, mut lost, mut rsent, mut rlost) = (0, 0, 0, 0);
    for (f, fl) in p.flows.iter().enumerate() {
        let s = &mut stats.flows[f];
        s.throughput_bps = s.delivered as f64 * p.payload_bytes as f64 * 8e6 / p.duration_us as f64;
        s.needless_us = needless(p, &airs, fl.from, fl.to);
        sent += s.data_sent;
        lost += s.data_lost;
        rsent += s.rts_sent;
        rlost += s.rts_lost;
    }
    stats.data_loss = if sent > 0 {
        lost as f64 / sent as f64
    } else {
        0.0
    };
    stats.rts_loss = if rsent > 0 {
        rlost as f64 / rsent as f64
    } else {
        0.0
    };
    CaRun {
        airs,
        navs: sim.navs,
        events: sim.events,
        stats,
    }
}

/// W8. [Exposed terminals.] Time node x heard the medium busy only because
/// of frames it could safely have talked over: the sender is out of range of
/// x's receiver r, and the frame's own receiver is out of range of x.
fn needless(p: &CaParams, airs: &[Air], x: usize, r: usize) -> u64 {
    let near = |a: usize, b: usize| a != b && ca_near(p, a, b);
    let mut marks: Vec<(u64, i32, i32)> = vec![];
    for a in airs.iter().filter(|a| a.from != x && near(a.from, x)) {
        let harmless = a.to != x && a.from != r && !near(a.from, r) && !near(a.to, x);
        let (h, o) = if harmless { (1, 0) } else { (0, 1) };
        marks.push((a.start_us, h, o));
        marks.push((a.end_us, -h, -o));
    }
    marks.sort();
    let (mut h, mut o, mut last, mut total) = (0, 0, 0, 0);
    for (t, dh, d_o) in marks {
        if h > 0 && o == 0 {
            total += t - last;
        }
        h += dh;
        o += d_o;
        last = t;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aloha(slotted: bool, g: f64, length: u64, seed: u64) -> AlohaParams {
        AlohaParams {
            slotted,
            stations: 50,
            g,
            frame_us: 1000,
            length,
            seed,
            trace: false,
        }
    }

    /// Prints the run-to-run spread the tolerances below are set from:
    /// `cargo test -p netsim spread -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn spread() {
        let sd = |xs: &[f64]| {
            let m = xs.iter().sum::<f64>() / xs.len() as f64;
            (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() - 1) as f64).sqrt()
        };
        for slotted in [true, false] {
            for g in [0.25, 0.5, 1.0, 2.0] {
                let s: Vec<f64> = (1..=20)
                    .map(|seed| aloha_run(&aloha(slotted, g, 20_000, seed)).stats.s)
                    .collect();
                let th = aloha_theory(slotted, 50, g).0;
                let m = s.iter().sum::<f64>() / 20.0;
                println!(
                    "aloha slotted={slotted} g={g}: theory {th:.5}, mean {m:.5}, sd {:.5}",
                    sd(&s)
                );
            }
        }
        for b in [64u32, 128, 256, 512, 1518] {
            let e: Vec<f64> = (1..=20)
                .map(|seed| cd_run(&cd_saturated(10, b, 2500, seed)).stats.efficiency)
                .collect();
            println!(
                "cd frame {b}: mean {:.4} sd {:.4}",
                e.iter().sum::<f64>() / 20.0,
                sd(&e)
            );
        }
        for rts in [false, true] {
            let l: Vec<f64> = (1..=20)
                .map(|seed| ca_run(&hidden(rts, seed)).stats.data_loss)
                .collect();
            println!(
                "hidden rts={rts}: mean data loss {:.4} max {:.4}",
                l.iter().sum::<f64>() / 20.0,
                l.iter().cloned().fold(0.0, f64::max)
            );
        }
    }

    // Tolerances. Each test runs one seed over 20,000 frame times (50
    // stations), so its tolerance is four standard deviations of S, measured
    // over seeds 1 to 20 by `spread` and written beside each check.
    #[test]
    fn slotted_aloha_matches_g_e_to_the_minus_g() {
        // Over seeds 1 to 20 the mean of S is within 0.0012 of the exact
        // value at every load (no bias), and its sd is 0.0035 at G = 0.25,
        // 0.0030 at 0.5, 0.0040 at 1, 0.0023 at 2; tolerance 0.016, four sd
        // of the largest.
        for g in [0.25, 0.5, 1.0, 2.0] {
            let s = aloha_run(&aloha(true, g, 20_000, 1)).stats;
            let (exact, limit) = aloha_theory(true, 50, g);
            println!(
                "slotted G {g}: S {:.4}, exact {exact:.4}, limit {limit:.4}",
                s.s
            );
            assert!(
                (s.s - exact).abs() < 0.016,
                "G {g}: S {} against {exact}",
                s.s
            );
            // Fifty stations are close to the Poisson limit: the exact value
            // differs from G e^{-G} by at most 0.011 over these loads.
            assert!(
                (exact - limit).abs() < 0.011,
                "G {g}: {exact} against {limit}"
            );
            assert!((s.g - g).abs() < 0.03, "measured G {}", s.g);
        }
        // The maximum, 1/e at G = 1.
        let (_, peak) = aloha_theory(true, 50, 1.0);
        assert!((peak - (-1.0f64).exp()).abs() < 1e-12);
    }

    #[test]
    fn pure_aloha_matches_g_e_to_the_minus_2g() {
        // Over seeds 1 to 20 the mean of S is within 0.0011 of the exact
        // value at every load, and its sd is 0.0027 at G = 0.25, 0.0026 at
        // 0.5, 0.0024 at 1, 0.0016 at 2; tolerance 0.011, four sd of the
        // largest.
        for g in [0.25, 0.5, 1.0, 2.0] {
            let s = aloha_run(&aloha(false, g, 20_000, 1)).stats;
            let (exact, limit) = aloha_theory(false, 50, g);
            println!(
                "pure G {g}: S {:.4}, exact {exact:.4}, limit {limit:.4}",
                s.s
            );
            assert!(
                (s.s - exact).abs() < 0.011,
                "G {g}: S {} against {exact}",
                s.s
            );
            assert!(
                (exact - limit).abs() < 0.008,
                "G {g}: {exact} against {limit}"
            );
        }
        let (_, peak) = aloha_theory(false, 50, 0.5);
        assert!((peak - 0.5 / 1f64.exp()).abs() < 1e-12);
    }

    #[test]
    fn aloha_marks_exactly_the_overlapping_frames() {
        let r = aloha_run(&AlohaParams {
            trace: true,
            ..aloha(false, 1.0, 300, 3)
        });
        for a in &r.frames {
            let clash = r
                .frames
                .iter()
                .any(|b| b.id != a.id && (a.start_us - b.start_us).abs() < 1000);
            // Frames near the end may clash with ones just past it, which
            // the page does not draw.
            if a.start_us < 299_000 {
                assert_eq!(a.ok, !clash, "frame {}", a.id);
            }
        }
        assert_eq!(r.events.len(), 2 * r.frames.len());
    }

    pub(super) fn bus(positions: &[u32], frames: u32) -> Vec<CdStation> {
        positions
            .iter()
            .enumerate()
            .map(|(i, &pos_m)| CdStation {
                name: format!("{}", (b'A' + i as u8) as char),
                pos_m,
                start_ns: 0,
                frames,
            })
            .collect()
    }

    pub(super) fn cd(
        stations: Vec<CdStation>,
        frame_bytes: u32,
        duration_ns: u64,
        seed: u64,
    ) -> CdParams {
        CdParams {
            stations,
            rate_bps: 10_000_000,
            frame_bytes,
            slot_bits: 512,
            jam_bits: 32,
            ifg_bits: 96,
            speed_mps: 200_000_000,
            attempt_limit: 16,
            backoff_cap: 10,
            duration_ns,
            seed,
            trace: true,
        }
    }

    fn cd_saturated(n: usize, frame_bytes: u32, length_m: u32, seed: u64) -> CdParams {
        let pos: Vec<u32> = (0..n)
            .map(|i| (i as u32 * length_m) / (n as u32 - 1))
            .collect();
        CdParams {
            trace: false,
            ..cd(bus(&pos, 0), frame_bytes, 200_000_000, seed)
        }
    }

    #[test]
    fn backoff_range_doubles_to_1023_and_stops_at_sixteen() {
        assert_eq!(beb_max(1, 10, 16), Some(1));
        assert_eq!(beb_max(2, 10, 16), Some(3));
        assert_eq!(beb_max(3, 10, 16), Some(7));
        assert_eq!(beb_max(10, 10, 16), Some(1023));
        assert_eq!(beb_max(15, 10, 16), Some(1023));
        assert_eq!(beb_max(16, 10, 16), None);
    }

    #[test]
    fn two_stations_collide_detect_within_a_round_trip_and_back_off() {
        // A and B, 2000 m apart, both have a frame at time 0: both wait the
        // 9.6 us gap, both send, and each hears the other 10 us later.
        let r = cd_run(&cd(bus(&[0, 2000], 1), 64, 2_000_000, 1));
        let first: Vec<&CdTx> = r.txs.iter().take(2).collect();
        for tx in &first {
            assert_eq!(tx.start_ns, 9_600);
            assert_eq!(tx.detect_ns, Some(19_600));
            assert_eq!(tx.end_ns, 19_600 + 3_200);
            assert_eq!(tx.outcome, "collided");
        }
        assert_eq!(r.backoffs[0].max, 1);
        assert_eq!(r.stats.delivered, 2);
        assert_eq!(r.stats.undetected, 0);
    }

    #[test]
    fn heavy_ethernet_obeys_802_3() {
        // Sixteen stations that always have a 64-byte frame, on 2500 m.
        let p = CdParams {
            duration_ns: 1_000_000_000,
            ..cd_saturated(16, 64, 2500, 1)
        };
        let r = cd_run(&p);
        let tau = r.stats.tau_ns;
        assert_eq!(tau, 12_500);
        // Every K lies in its range, and the ranges are 2^min(n,10) - 1.
        for b in &r.backoffs {
            assert_eq!(Some(b.max), beb_max(b.collisions, 10, 16));
            assert!(b.k <= b.max);
        }
        // A collision is heard at most a round trip after the start: the
        // other station began before our first bit reached it.
        assert!(
            r.stats.max_detect_ns <= 2 * tau,
            "{}",
            r.stats.max_detect_ns
        );
        // 64 bytes at 10 Mb/s is 51.2 us, longer than the 25 us round trip,
        // so no collision goes unnoticed.
        assert!(r.stats.frame_ns >= 2 * tau);
        assert_eq!(r.stats.undetected, 0);
        // Every aborted frame was tried exactly sixteen times.
        let aborted: Vec<&CdTx> = r.txs.iter().filter(|t| t.outcome == "aborted").collect();
        for a in &aborted {
            assert_eq!(a.attempt, 16);
        }
        assert!(r.txs.iter().all(|t| t.attempt <= 16));
        // K is uniform: after a first collision it is 0 or 1 about equally
        // often, after a second its mean is near 1.5. Hundreds of draws each;
        // tolerances are 4 standard errors.
        for n in [1u32, 2, 3] {
            let ks: Vec<f64> = r
                .backoffs
                .iter()
                .filter(|b| b.collisions == n)
                .map(|b| b.k as f64)
                .collect();
            let m = ks.iter().sum::<f64>() / ks.len() as f64;
            let max = ((1u64 << n) - 1) as f64;
            let se = ((max + 1.0).powi(2) - 1.0).sqrt() / 12f64.sqrt() / (ks.len() as f64).sqrt();
            assert!(ks.len() > 100, "{n}: {} draws", ks.len());
            assert!((m - max / 2.0).abs() < 4.0 * se, "n {n}: mean {m}");
        }
    }

    #[test]
    fn frames_shorter_than_a_round_trip_collide_unnoticed() {
        // 20-byte frames (16 us) on 2500 m (25 us round trip): a sender can
        // finish before the other signal reaches it.
        let r = cd_run(&CdParams {
            duration_ns: 20_000_000,
            ..cd_saturated(4, 20, 2500, 1)
        });
        assert!(r.stats.frame_ns < 2 * r.stats.tau_ns);
        assert!(r.stats.undetected > 0);
    }

    #[test]
    fn ethernet_efficiency_falls_with_a() {
        // Ten saturated stations on 2500 m; frames from 64 to 1518 bytes,
        // so a = tau / frame time runs from 0.244 to 0.010. Each run is
        // 200 ms; sd over 20 seeds at most 0.005 (from `spread`).
        let e: Vec<f64> = [64u32, 256, 1518]
            .iter()
            .map(|&b| cd_run(&cd_saturated(10, b, 2500, 1)).stats.efficiency)
            .collect();
        assert!(e[0] < e[1] && e[1] < e[2], "{e:?}");
        assert!(e[2] > 0.85, "{e:?}");
    }

    pub(super) fn ca(nodes: &[(&str, f64)], flows: Vec<CaFlow>, rts: bool, seed: u64) -> CaParams {
        CaParams {
            nodes: nodes
                .iter()
                .map(|&(name, x_m)| CaNode {
                    name: name.into(),
                    x_m,
                    y_m: 0.0,
                })
                .collect(),
            range_m: 100.0,
            flows,
            rts,
            rate_bps: 6_000_000,
            payload_bytes: 1000,
            slot_us: 9,
            sifs_us: 16,
            cw_min: 15,
            cw_max: 1023,
            attempt_limit: 7,
            preamble_us: 20,
            duration_us: 1_000_000,
            seed,
            trace: true,
        }
    }

    fn flow(from: usize, to: usize) -> CaFlow {
        CaFlow {
            from,
            to,
            frames: 0,
            start_us: 0,
        }
    }

    /// A and C cannot hear each other; both send to B between them.
    fn hidden(rts: bool, seed: u64) -> CaParams {
        ca(
            &[("A", 0.0), ("B", 90.0), ("C", 180.0)],
            vec![flow(0, 1), flow(2, 1)],
            rts,
            seed,
        )
    }

    #[test]
    fn rts_cts_cures_the_hidden_terminal() {
        // Data loss over seeds 1 to 20 (from `spread`): without RTS/CTS mean
        // 0.81, never below 0.78; with it, mean 0.020 and at most 0.029.
        let plain = ca_run(&hidden(false, 1)).stats;
        let rts = ca_run(&hidden(true, 1)).stats;
        assert!(plain.data_loss > 0.5, "{}", plain.data_loss);
        assert!(rts.data_loss < 0.05, "{}", rts.data_loss);
        // What collides now is the short RTS frames.
        assert!(rts.rts_loss > 0.05, "{}", rts.rts_loss);
        let got = |s: &CaStats| s.flows.iter().map(|f| f.delivered).sum::<usize>();
        assert!(got(&rts) > 2 * got(&plain), "{} {}", got(&rts), got(&plain));
    }

    #[test]
    fn nav_ends_exactly_when_the_ack_does() {
        // A sends to B with RTS/CTS; C hears only B, D hears only A.
        let p = ca(
            &[("D", -90.0), ("A", 0.0), ("B", 90.0), ("C", 180.0)],
            vec![CaFlow {
                frames: 3,
                ..flow(1, 2)
            }],
            true,
            1,
        );
        let r = ca_run(&p);
        let s = &r.stats;
        assert_eq!(s.flows[0].delivered, 3);
        // RTS's duration field is 3 SIFS + CTS + data + ACK; CTS's is RTS's
        // less a SIFS and the CTS; data's is a SIFS and the ACK.
        let rts = r.airs.iter().find(|a| a.kind == "rts").unwrap();
        let cts = r.airs.iter().find(|a| a.kind == "cts").unwrap();
        let data = r.airs.iter().find(|a| a.kind == "data").unwrap();
        let ack = r.airs.iter().find(|a| a.kind == "ack").unwrap();
        assert_eq!(rts.nav_us, 3 * 16 + s.cts_us + s.data_us + s.ack_us);
        assert_eq!(cts.nav_us, rts.nav_us - 16 - s.cts_us);
        assert_eq!(data.nav_us, 16 + s.ack_us);
        // Each answer comes exactly one SIFS after the frame before.
        assert_eq!(cts.start_us, rts.end_us + 16);
        assert_eq!(data.start_us, cts.end_us + 16);
        assert_eq!(ack.start_us, data.end_us + 16);
        // D set its NAV from the RTS, C from the CTS, and both end with the
        // ACK.
        let d = r
            .navs
            .iter()
            .find(|n| n.node == 0 && n.air == rts.id)
            .unwrap();
        let c = r
            .navs
            .iter()
            .find(|n| n.node == 3 && n.air == cts.id)
            .unwrap();
        assert_eq!(d.until_us, ack.end_us);
        assert_eq!(c.until_us, ack.end_us);
    }

    #[test]
    fn senders_wait_a_difs_of_silence_or_share_a_slot() {
        // Every RTS or unprompted data frame starts after the sender has
        // sensed the medium idle for at least a DIFS, or in the same
        // microsecond as another frame it could not yet hear (same slot).
        for rts in [false, true] {
            let p = ca(
                &[("A", 0.0), ("B", 50.0), ("C", 100.0), ("D", 60.0)],
                vec![flow(0, 1), flow(2, 1), flow(3, 0)],
                rts,
                2,
            );
            let r = ca_run(&p);
            let difs = r.stats.difs_us;
            let near = |a: usize, b: usize| a != b && ca_near(&p, a, b);
            for a in r
                .airs
                .iter()
                .filter(|a| a.kind == "rts" || (a.kind == "data" && !rts))
            {
                let x = a.from;
                let clash = r
                    .airs
                    .iter()
                    .any(|b| b.id != a.id && b.start_us == a.start_us && near(b.from, x));
                let quiet = r
                    .airs
                    .iter()
                    .filter(|b| b.id != a.id && (b.from == x || near(b.from, x)))
                    .all(|b| b.end_us + difs <= a.start_us || b.start_us >= a.start_us);
                let nav_ok = r
                    .navs
                    .iter()
                    .filter(|n| n.node == x)
                    .all(|n| n.until_us + difs <= a.start_us || n.from_us >= a.start_us);
                assert!(
                    clash || (quiet && nav_ok),
                    "rts {rts}: frame {} at {}",
                    a.id,
                    a.start_us
                );
            }
        }
    }

    #[test]
    fn exposed_terminal_defers_for_nothing() {
        // A <- B ... C -> D: B and C hear each other, but each one's
        // receiver is out of the other's range.
        let p = ca(
            &[("A", 0.0), ("B", 90.0), ("C", 180.0), ("D", 270.0)],
            vec![flow(1, 0), flow(2, 3)],
            false,
            1,
        );
        let r = ca_run(&p);
        for f in &r.stats.flows {
            assert!(
                f.needless_us as f64 > 0.3 * p.duration_us as f64,
                "{}",
                f.needless_us
            );
            assert_eq!(f.data_lost, 0);
        }
    }

    #[test]
    fn runs_are_reproducible() {
        let a = ca_run(&hidden(true, 5));
        let b = ca_run(&hidden(true, 5));
        assert_eq!(a.airs, b.airs);
        let c = cd_run(&cd_saturated(5, 64, 1000, 4));
        let d = cd_run(&cd_saturated(5, 64, 1000, 4));
        assert_eq!(c.txs, d.txs);
    }
}
