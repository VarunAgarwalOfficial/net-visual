//! Loading a web page: HTTP/1.0, HTTP/1.1, HTTP/2 over TCP and HTTP/3 over
//! QUIC, on one path with a round-trip time, a bottleneck rate and loss.
//!
//! A page is a base object (the HTML) and the objects it names. The browser
//! asks for the base first and for the rest once the base has arrived.
//!
//! - HTTP/1.0 (RFC 1945) opens a TCP connection per object and closes it
//!   after the response, so every object pays a handshake and a fresh slow
//!   start. Browsers ran up to `parallel` of them at once.
//! - HTTP/1.1 (RFC 9112) keeps the connection open for the next request.
//!   Without pipelining a connection carries one request at a time; with it
//!   the client sends several and the server must answer in order, so a large
//!   response holds up the small ones behind it: head-of-line blocking in
//!   the application. Browsers open up to six connections instead.
//! - HTTP/2 (RFC 9113) multiplexes every request on one TCP connection as
//!   streams whose frames interleave, so no response waits for another to
//!   finish. But TCP delivers bytes in order: a lost segment holds back every
//!   byte behind it, whichever stream it belongs to, until the
//!   retransmission arrives. That is head-of-line blocking in the transport.
//! - HTTP/3 (RFC 9114) runs the same streams over QUIC (RFC 9000), which
//!   orders bytes per stream, not per connection: a loss holds back only the
//!   stream whose data was in the lost packet.
//!
//! Handshakes: TCP needs one round trip before the request can go; TLS 1.3
//! (RFC 8446) adds one more, or none on a resumed session with 0-RTT data.
//! QUIC combines the transport and cryptographic handshakes in one round
//! trip, and on resumption sends the request in its first flight (0-RTT).
//!
//! Simplifications, all stated on the page: only the server's data packets
//! can be lost (handshakes, requests and acknowledgements always arrive);
//! the bottleneck queue at the server is a FIFO without a limit; every packet
//! carries data of one object only and has no header; the client
//! acknowledges every packet at once; congestion control is Reno's slow start
//! and additive increase with one halving per recovery period (as RFC 9002
//! Section 7.3.2 specifies for QUIC), the same for TCP and QUIC; a loss is
//! detected when three packets sent after it have been acknowledged (TCP's
//! fast retransmit, QUIC's packet threshold, RFC 9002 Section 6.1.1) or, if
//! fewer follow it, by a timer two round trips after it left, the scale of
//! RACK-TLP's and QUIC's probe timeouts; servers take no time to respond.
//!
//! Times are in nanoseconds, so that transmission times at round rates are
//! exact and the textbook formulas can be checked to the nanosecond. The
//! steps are lettered; the trace names the step behind each event.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::sim::{Queue, Rng};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    H10,
    H11,
    H2,
    H3,
}

/// How an HTTP/2 or HTTP/3 server shares its packets among streams.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Schedule {
    /// One packet from each stream in turn (RFC 9218's incremental streams).
    #[default]
    Interleave,
    /// Each stream to the end before the next (RFC 9218's default for
    /// streams of equal urgency).
    Sequential,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Object {
    pub name: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HttpParams {
    pub protocol: Protocol,
    /// Most connections open at once (HTTP/1.x only).
    #[serde(default = "one")]
    pub parallel: u32,
    /// HTTP/1.1 only: send every request a connection will carry at once.
    #[serde(default)]
    pub pipelining: bool,
    /// TLS 1.3 over TCP. HTTP/3 is always encrypted.
    #[serde(default)]
    pub tls: bool,
    /// Resumed session: TLS 1.3 early data, or QUIC 0-RTT.
    #[serde(default)]
    pub zero_rtt: bool,
    #[serde(default)]
    pub schedule: Schedule,
    /// The base page first, then the objects it names.
    pub objects: Vec<Object>,
    pub rtt_us: u64,
    pub rate_bps: u64,
    #[serde(default = "mss")]
    pub mss_bytes: u32,
    /// Initial congestion window in packets (RFC 6928, RFC 9002: 10).
    #[serde(default = "iw")]
    pub iw: u32,
    /// Probability that each data packet is lost.
    #[serde(default)]
    pub loss: f64,
    /// Data packets to lose, numbered from 0 in the order the server sends
    /// them (retransmissions included).
    #[serde(default)]
    pub drops: Vec<u32>,
    #[serde(default = "one_u64")]
    pub seed: u64,
    #[serde(default = "yes")]
    pub trace: bool,
}

fn one() -> u32 {
    1
}
fn one_u64() -> u64 {
    1
}
fn mss() -> u32 {
    1460
}
fn iw() -> u32 {
    10
}
fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct Conn {
    pub quic: bool,
    pub opened_ns: u64,
    /// When the first request can leave the client.
    pub ready_ns: u64,
    /// When the last response on it was complete.
    pub closed_ns: u64,
    /// Objects it carried, in the order they were asked for.
    pub objects: Vec<usize>,
}

/// A handshake message or a request: everything that is not response data.
#[derive(Clone, Debug, Serialize)]
pub struct Msg {
    pub conn: usize,
    /// Client to server.
    pub up: bool,
    pub send_ns: u64,
    pub arrive_ns: u64,
    pub label: String,
    pub request: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Packet {
    pub conn: usize,
    /// Packet number on its connection (QUIC's packet number; for TCP the
    /// order of transmission).
    pub num: u32,
    /// Position in the connection's byte stream, in packets (TCP), shared by
    /// a retransmission and the packet it replaces.
    pub seq: u32,
    pub obj: usize,
    pub offset: u64,
    pub len: u32,
    /// When it began to leave the server, and when its last bit had left.
    pub start_ns: u64,
    pub depart_ns: u64,
    pub arrive_ns: Option<u64>,
    pub lost: bool,
    pub retx_of: Option<usize>,
    /// When the server declared it lost.
    pub detected_ns: Option<u64>,
    /// "threshold" or "timer".
    pub detected_by: Option<String>,
    /// When its bytes reached the application.
    pub delivered_ns: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ObjResult {
    pub name: String,
    pub bytes: u64,
    pub conn: usize,
    pub requested_ns: u64,
    pub first_byte_ns: u64,
    pub done_ns: u64,
    /// Total time its packets sat at the client, arrived but not delivered.
    pub held_ns: u64,
    /// Packets of it held back by a gap.
    pub held_packets: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct HttpEvent {
    pub t: u64,
    pub step: &'static str,
    pub conn: Option<usize>,
    pub obj: Option<usize>,
    pub pkt: Option<usize>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct HttpStats {
    /// Page load time: the last object complete.
    pub plt_ns: u64,
    /// The first byte of the base page delivered.
    pub ttfb_ns: u64,
    /// Round trips before a connection's first request can leave.
    pub setup_rtts: u64,
    pub connections: usize,
    pub packets: usize,
    pub lost: usize,
    pub bytes: u64,
    /// Objects with at least one packet held back.
    pub held_objects: usize,
    pub held_ns: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HttpRun {
    pub conns: Vec<Conn>,
    pub msgs: Vec<Msg>,
    pub packets: Vec<Packet>,
    pub objects: Vec<ObjResult>,
    pub events: Vec<HttpEvent>,
    pub stats: HttpStats,
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Chunk {
    obj: usize,
    offset: u64,
    len: u32,
    seq: u32,
    of: usize,
}

struct ConnState {
    assigned: Vec<usize>,
    first_request: bool,
    cwnd: f64,
    ssthresh: f64,
    inflight: u32,
    /// Start of the current recovery period.
    recovery: Option<u64>,
    next_num: u32,
    next_seq: u32,
    retx: VecDeque<Chunk>,
    /// HTTP/1.x: responses in the order they must go.
    h1: VecDeque<usize>,
    /// HTTP/2 and HTTP/3: streams with data still to send, and the turn.
    active: Vec<usize>,
    turn: usize,
    /// Sent, neither acknowledged nor declared lost, by packet index, with
    /// the count of later packets acknowledged.
    outstanding: Vec<(usize, u32)>,
    /// TCP's receive side: the next packet in order and those waiting.
    rcv_next: u32,
    rcv_buf: BTreeMap<u32, usize>,
}

struct ObjState {
    sent: u64,
    delivered: u64,
    /// QUIC's per-stream receive side, by byte offset.
    rcv_next: u64,
    rcv_buf: BTreeMap<u64, usize>,
}

enum Ev {
    Ready(usize),
    Requests(usize, Vec<usize>),
    Arrive(usize),
    Ack(usize),
    Timer(usize),
}

struct Sim<'a> {
    p: &'a HttpParams,
    rtt: u64,
    half: u64,
    q: Queue<Ev>,
    rng: Rng,
    link_free: u64,
    conns: Vec<Conn>,
    cs: Vec<ConnState>,
    msgs: Vec<Msg>,
    packets: Vec<Packet>,
    objs: Vec<ObjResult>,
    os: Vec<ObjState>,
    events: Vec<HttpEvent>,
    pending: VecDeque<usize>,
    complete: usize,
    plt: u64,
}

/// Round trips before the first request can leave (step C1).
pub fn setup_rtts(p: &HttpParams) -> u64 {
    match p.protocol {
        Protocol::H3 => u64::from(!p.zero_rtt),
        _ => 1 + u64::from(p.tls && !p.zero_rtt),
    }
}

/// Nanoseconds to put `bytes` on a link of `rate` bits a second.
pub fn tx_ns(bytes: u64, rate: u64) -> u64 {
    (bytes as u128 * 8 * 1_000_000_000 / rate as u128) as u64
}

impl<'a> Sim<'a> {
    fn new(p: &'a HttpParams) -> Self {
        let rtt = p.rtt_us * 1000;
        Sim {
            p,
            rtt,
            half: rtt / 2,
            q: Queue::default(),
            rng: Rng::new(p.seed),
            link_free: 0,
            conns: Vec::new(),
            cs: Vec::new(),
            msgs: Vec::new(),
            packets: Vec::new(),
            objs: p
                .objects
                .iter()
                .map(|o| ObjResult {
                    name: o.name.clone(),
                    bytes: o.bytes,
                    conn: 0,
                    requested_ns: 0,
                    first_byte_ns: 0,
                    done_ns: 0,
                    held_ns: 0,
                    held_packets: 0,
                })
                .collect(),
            os: p
                .objects
                .iter()
                .map(|_| ObjState {
                    sent: 0,
                    delivered: 0,
                    rcv_next: 0,
                    rcv_buf: BTreeMap::new(),
                })
                .collect(),
            events: Vec::new(),
            pending: VecDeque::new(),
            complete: 0,
            plt: 0,
        }
    }

    fn record(
        &mut self,
        t: u64,
        step: &'static str,
        conn: Option<usize>,
        obj: Option<usize>,
        pkt: Option<usize>,
        text: impl FnOnce() -> String,
    ) {
        if self.p.trace {
            self.events.push(HttpEvent {
                t,
                step,
                conn,
                obj,
                pkt,
                text: text(),
            });
        }
    }

    fn quic(&self) -> bool {
        self.p.protocol == Protocol::H3
    }

    fn name(&self, o: usize) -> String {
        self.p.objects[o].name.clone()
    }

    // C1. [Open a connection.] The client starts a handshake. TCP's SYN and
    // SYN-ACK take one round trip; TLS 1.3's ClientHello and the server's
    // reply up to Finished take another, unless a resumed session sends the
    // request as early data with the ClientHello. QUIC's Initial packets
    // carry both handshakes in one round trip, and with 0-RTT the request
    // rides in the first flight.
    fn open(&mut self, t: u64, assigned: Vec<usize>) -> usize {
        let c = self.conns.len();
        let quic = self.quic();
        let setup = setup_rtts(self.p);
        let (rtt, half) = (self.rtt, self.half);
        let mut hs: Vec<(bool, u64, u64, String)> = Vec::new();
        if quic {
            if !self.p.zero_rtt {
                hs.push((true, t, t + half, "Initial: ClientHello".into()));
            }
            hs.push((
                false,
                t + half,
                t + rtt,
                "Initial + Handshake: ServerHello … Finished".into(),
            ));
        } else {
            hs.push((true, t, t + half, "SYN".into()));
            hs.push((false, t + half, t + rtt, "SYN-ACK".into()));
            if self.p.tls && !self.p.zero_rtt {
                hs.push((true, t + rtt, t + rtt + half, "ClientHello".into()));
                hs.push((
                    false,
                    t + rtt + half,
                    t + 2 * rtt,
                    "ServerHello … Finished".into(),
                ));
            } else if self.p.tls {
                hs.push((
                    false,
                    t + rtt + half,
                    t + 2 * rtt,
                    "ServerHello … Finished".into(),
                ));
            }
        }
        for (up, s, a, label) in hs {
            self.msgs.push(Msg {
                conn: c,
                up,
                send_ns: s,
                arrive_ns: a,
                label,
                request: false,
            });
        }
        self.conns.push(Conn {
            quic,
            opened_ns: t,
            ready_ns: t + setup * rtt,
            closed_ns: 0,
            objects: Vec::new(),
        });
        let iw = f64::from(self.p.iw);
        self.cs.push(ConnState {
            assigned,
            first_request: true,
            cwnd: iw,
            ssthresh: f64::INFINITY,
            inflight: 0,
            recovery: None,
            next_num: 0,
            next_seq: 0,
            retx: VecDeque::new(),
            h1: VecDeque::new(),
            active: Vec::new(),
            turn: 0,
            outstanding: Vec::new(),
            rcv_next: 0,
            rcv_buf: BTreeMap::new(),
        });
        let what = if quic {
            if self.p.zero_rtt {
                "a QUIC connection, resuming with 0-RTT: the request goes in the first flight"
                    .to_string()
            } else {
                "a QUIC connection: transport and TLS handshakes together, one round trip"
                    .to_string()
            }
        } else if self.p.tls {
            if self.p.zero_rtt {
                "a TCP connection, then a resumed TLS 1.3 session whose request rides with the ClientHello".to_string()
            } else {
                "a TCP connection (one round trip), then TLS 1.3 (one more)".to_string()
            }
        } else {
            "a TCP connection: SYN, SYN-ACK, then the request with the ACK".to_string()
        };
        let n = c + 1;
        self.record(t, "C1", Some(c), None, None, || {
            format!("The client opens connection {n}, {what}. It can send its first request after {setup} round trip{}.", if setup == 1 { "" } else { "s" })
        });
        self.q.push(t + setup * rtt, Ev::Ready(c));
        c
    }

    // C2. [Ask.] The client sends requests on a connection: on HTTP/1.x one
    // at a time, or all it has with pipelining; on HTTP/2 and HTTP/3 every
    // request at once, each on its own stream.
    fn request(&mut self, c: usize, objs: Vec<usize>, t: u64) {
        if objs.is_empty() {
            return;
        }
        let quic = self.quic();
        let prefix = if self.cs[c].first_request {
            if quic {
                if self.p.zero_rtt {
                    "0-RTT "
                } else {
                    "Finished + "
                }
            } else if self.p.tls {
                if self.p.zero_rtt {
                    "ClientHello + early data: "
                } else {
                    "Finished + "
                }
            } else {
                "ACK + "
            }
        } else {
            ""
        };
        self.cs[c].first_request = false;
        let names: Vec<String> = objs.iter().map(|&o| format!("/{}", self.name(o))).collect();
        let label = if names.len() <= 2 {
            format!("{prefix}GET {}", names.join(", "))
        } else {
            format!("{prefix}GET {} and {} more", names[0], names.len() - 1)
        };
        for &o in &objs {
            self.objs[o].requested_ns = t;
            self.objs[o].conn = c;
            self.conns[c].objects.push(o);
        }
        self.msgs.push(Msg {
            conn: c,
            up: true,
            send_ns: t,
            arrive_ns: t + self.half,
            label,
            request: true,
        });
        let n = c + 1;
        let list = names.join(", ");
        self.record(t, "C2", Some(c), objs.first().copied(), None, || {
            format!("The client asks for {list} on connection {n}.")
        });
        self.q.push(t + self.half, Ev::Requests(c, objs));
    }

    fn on_ready(&mut self, c: usize, t: u64) {
        let mut list = std::mem::take(&mut self.cs[c].assigned);
        if list.is_empty() && self.p.protocol == Protocol::H11 && !self.p.pipelining {
            if let Some(o) = self.pending.pop_front() {
                list.push(o);
            }
        }
        if list.is_empty() {
            let n = c + 1;
            self.record(t, "C2", Some(c), None, None, || {
                format!("Connection {n} is ready, but nothing is left to ask for on it.")
            });
        }
        self.request(c, list, t);
    }

    // S1. [Queue the responses.] The server has the requests. On HTTP/1.x
    // the responses must go in the order asked; on HTTP/2 and HTTP/3 each
    // becomes a stream with data to send.
    fn on_requests(&mut self, c: usize, objs: Vec<usize>, t: u64) {
        let h1 = matches!(self.p.protocol, Protocol::H10 | Protocol::H11);
        for &o in &objs {
            if h1 {
                self.cs[c].h1.push_back(o);
            } else {
                self.cs[c].active.push(o);
            }
        }
        let n = c + 1;
        let k = objs.len();
        let how = if h1 {
            "queues the responses in the order asked"
        } else {
            "opens a stream for each"
        };
        self.record(t, "S1", Some(c), objs.first().copied(), None, || {
            format!(
                "The server receives {k} request{} on connection {n} and {how}.",
                if k == 1 { "" } else { "s" }
            )
        });
        self.pump(c, t);
    }

    /// The next new data the server would send on connection c.
    fn next_chunk(&mut self, c: usize) -> Option<Chunk> {
        let mss = u64::from(self.p.mss_bytes);
        let o = if matches!(self.p.protocol, Protocol::H10 | Protocol::H11) {
            *self.cs[c].h1.front()?
        } else {
            let st = &mut self.cs[c];
            if st.active.is_empty() {
                return None;
            }
            match self.p.schedule {
                Schedule::Interleave => {
                    st.turn %= st.active.len();
                    st.active[st.turn]
                }
                Schedule::Sequential => st.active[0],
            }
        };
        let offset = self.os[o].sent;
        let len = mss.min(self.p.objects[o].bytes - offset);
        self.os[o].sent += len;
        let st = &mut self.cs[c];
        let seq = st.next_seq;
        st.next_seq += 1;
        if self.os[o].sent == self.p.objects[o].bytes {
            if matches!(self.p.protocol, Protocol::H10 | Protocol::H11) {
                st.h1.pop_front();
            } else {
                let i = st.active.iter().position(|&x| x == o).unwrap();
                st.active.remove(i);
                // The stream after it now has this turn.
                if i < st.turn {
                    st.turn -= 1;
                }
            }
        } else if self.p.schedule == Schedule::Interleave
            && !matches!(self.p.protocol, Protocol::H10 | Protocol::H11)
        {
            st.turn += 1;
        }
        Some(Chunk {
            obj: o,
            offset,
            len: len as u32,
            seq,
            of: usize::MAX,
        })
    }

    // S2. [Send.] While the congestion window has room, the server sends a
    // packet: a retransmission first, then new data. Packets from every
    // connection leave through one bottleneck in the order they are sent.
    fn pump(&mut self, c: usize, t: u64) {
        loop {
            let st = &self.cs[c];
            if f64::from(st.inflight) + 1.0 > st.cwnd.floor().max(1.0) {
                break;
            }
            let (chunk, retx) = if let Some(ch) = self.cs[c].retx.pop_front() {
                (ch, true)
            } else if let Some(ch) = self.next_chunk(c) {
                (ch, false)
            } else {
                break;
            };
            let idx = self.packets.len();
            let draw = self.rng.unit();
            let lost = self.p.drops.contains(&(idx as u32)) || draw < self.p.loss;
            let start = t.max(self.link_free);
            let depart = start + tx_ns(u64::from(chunk.len), self.p.rate_bps);
            self.link_free = depart;
            let arrive = depart + self.half;
            let st = &mut self.cs[c];
            let num = st.next_num;
            st.next_num += 1;
            st.inflight += 1;
            st.outstanding.push((idx, 0));
            self.packets.push(Packet {
                conn: c,
                num,
                seq: chunk.seq,
                obj: chunk.obj,
                offset: chunk.offset,
                len: chunk.len,
                start_ns: start,
                depart_ns: depart,
                arrive_ns: (!lost).then_some(arrive),
                lost,
                retx_of: retx.then_some(chunk.of),
                detected_ns: None,
                detected_by: None,
                delivered_ns: None,
            });
            if lost {
                self.q.push(depart + 2 * self.rtt, Ev::Timer(idx));
            } else {
                self.q.push(arrive, Ev::Arrive(idx));
                self.q.push(arrive + self.half, Ev::Ack(idx));
            }
            let name = self.name(chunk.obj);
            let (a, b) = (chunk.offset, chunk.offset + u64::from(chunk.len));
            let n = c + 1;
            self.record(t, "S2", Some(c), Some(chunk.obj), Some(idx), || {
                format!(
                    "The server sends packet {num} on connection {n}{}: {name}, bytes {a} to {b}{}.",
                    if retx { ", a retransmission" } else { "" },
                    if lost { ". It will be lost on the way" } else { "" }
                )
            });
        }
    }

    // R1. [Receive.] A packet arrives. TCP hands bytes to the application
    // only in order across the whole connection, so a packet behind a gap
    // waits, whatever stream it carries; QUIC orders bytes only within each
    // stream. Whatever the arrival makes contiguous is delivered now.
    fn on_arrive(&mut self, k: usize, t: u64) {
        let (c, o) = (self.packets[k].conn, self.packets[k].obj);
        let mut released: Vec<usize> = Vec::new();
        if self.quic() {
            let st = &mut self.os[o];
            st.rcv_buf.insert(self.packets[k].offset, k);
            while let Some(j) = st.rcv_buf.remove(&st.rcv_next) {
                st.rcv_next += u64::from(self.packets[j].len);
                released.push(j);
            }
        } else {
            let st = &mut self.cs[c];
            st.rcv_buf.insert(self.packets[k].seq, k);
            while let Some(j) = st.rcv_buf.remove(&st.rcv_next) {
                st.rcv_next += 1;
                released.push(j);
            }
        }
        let name = self.name(o);
        let num = self.packets[k].num;
        if released.is_empty() {
            let gap = if self.quic() {
                format!("byte {} of {name}", self.os[o].rcv_next)
            } else {
                let next = self.cs[c].rcv_next;
                let missing = self
                    .packets
                    .iter()
                    .find(|q| q.conn == c && q.seq == next)
                    .map(|q| self.p.objects[q.obj].name.clone());
                format!(
                    "packet {next} in TCP's order{}",
                    missing.map(|m| format!(" ({m})")).unwrap_or_default()
                )
            };
            self.record(t, "R1", Some(c), Some(o), Some(k), || {
                format!(
                    "Packet {num} ({name}) arrives but is held: the client is still missing {gap}."
                )
            });
            return;
        }
        let others = released.len() - 1;
        self.record(t, "R1", Some(c), Some(o), Some(k), || {
            if others == 0 {
                format!("Packet {num} ({name}) arrives and goes straight to the application.")
            } else {
                format!("Packet {num} ({name}) arrives and fills the gap: it and {others} packet{} held behind it go to the application.", if others == 1 { "" } else { "s" })
            }
        });
        for j in released {
            self.deliver(j, t);
        }
    }

    fn deliver(&mut self, j: usize, t: u64) {
        let o = self.packets[j].obj;
        self.packets[j].delivered_ns = Some(t);
        let arrived = self.packets[j].arrive_ns.unwrap();
        if t > arrived {
            self.objs[o].held_ns += t - arrived;
            self.objs[o].held_packets += 1;
        }
        if self.packets[j].offset == 0 {
            self.objs[o].first_byte_ns = t;
        }
        self.os[o].delivered += u64::from(self.packets[j].len);
        if self.os[o].delivered == self.p.objects[o].bytes {
            self.done(o, t);
        }
    }

    // O1. [Object complete.] The base page names the other objects, so its
    // arrival sets off their requests; on HTTP/1.x a finished response frees
    // its connection for the next request, or, on HTTP/1.0, closes it.
    fn done(&mut self, o: usize, t: u64) {
        self.objs[o].done_ns = t;
        self.complete += 1;
        let c = self.objs[o].conn;
        self.conns[c].closed_ns = t;
        let name = self.name(o);
        self.record(t, "O1", Some(c), Some(o), None, || {
            format!("{name} is complete.")
        });
        let n = self.p.objects.len();
        let par = self.p.parallel.max(1) as usize;
        if o == 0 {
            let emb: Vec<usize> = (1..n).collect();
            match self.p.protocol {
                Protocol::H10 => {
                    self.pending = emb.into();
                    for _ in 0..par.min(n - 1) {
                        let next = self.pending.pop_front().unwrap();
                        self.open(t, vec![next]);
                    }
                }
                Protocol::H11 if !self.p.pipelining => {
                    self.pending = emb.into();
                    if let Some(next) = self.pending.pop_front() {
                        self.request(c, vec![next], t);
                    }
                    for _ in 0..(par - 1).min(self.pending.len()) {
                        self.open(t, Vec::new());
                    }
                }
                Protocol::H11 => {
                    let k = par.min(emb.len());
                    let mut lists: Vec<Vec<usize>> = vec![Vec::new(); k];
                    for (i, &x) in emb.iter().enumerate() {
                        lists[i % k].push(x);
                    }
                    let mut it = lists.into_iter();
                    if let Some(first) = it.next() {
                        self.request(c, first, t);
                    }
                    for rest in it {
                        self.open(t, rest);
                    }
                }
                Protocol::H2 | Protocol::H3 => self.request(c, emb, t),
            }
        } else {
            match self.p.protocol {
                Protocol::H10 => {
                    if let Some(next) = self.pending.pop_front() {
                        self.open(t, vec![next]);
                    }
                }
                Protocol::H11 if !self.p.pipelining => {
                    if let Some(next) = self.pending.pop_front() {
                        self.request(c, vec![next], t);
                    }
                }
                _ => {}
            }
        }
        if self.complete == n {
            self.plt = t;
            self.record(t, "P1", None, None, None, || {
                "The page is complete: every object has reached the browser.".to_string()
            });
        }
    }

    // A1. [Acknowledged.] The server learns a packet arrived. The window
    // grows by one packet per acknowledgement in slow start, by one per
    // window after; three packets acknowledged after one still outstanding
    // mark that one lost.
    fn on_ack(&mut self, k: usize, t: u64) {
        let c = self.packets[k].conn;
        let num = self.packets[k].num;
        let st = &mut self.cs[c];
        if let Some(i) = st.outstanding.iter().position(|&(j, _)| j == k) {
            st.outstanding.remove(i);
            st.inflight -= 1;
        }
        if st.cwnd < st.ssthresh {
            st.cwnd += 1.0;
        } else {
            st.cwnd += 1.0 / st.cwnd;
        }
        let mut lost = Vec::new();
        for (j, later) in st.outstanding.iter_mut() {
            if self.packets[*j].num < num {
                *later += 1;
                if *later == 3 {
                    lost.push(*j);
                }
            }
        }
        for j in lost {
            self.declare_lost(j, t, "threshold");
        }
        self.pump(c, t);
    }

    fn on_timer(&mut self, k: usize, t: u64) {
        let c = self.packets[k].conn;
        if self.cs[c].outstanding.iter().any(|&(j, _)| j == k) {
            self.declare_lost(k, t, "timer");
            self.pump(c, t);
        }
    }

    // L1. [Declare lost.] The server queues the lost data again, ahead of
    // new data, under a new packet number but at the same place in the byte
    // stream. The first loss in a recovery period halves the window.
    fn declare_lost(&mut self, k: usize, t: u64, how: &'static str) {
        let c = self.packets[k].conn;
        let pk = self.packets[k].clone();
        let st = &mut self.cs[c];
        st.outstanding.retain(|&(j, _)| j != k);
        st.inflight -= 1;
        let new_period = st.recovery.is_none_or(|r| pk.start_ns > r);
        if new_period {
            st.ssthresh = (st.cwnd / 2.0).max(2.0);
            st.cwnd = st.ssthresh;
            st.recovery = Some(t);
        }
        let cwnd = st.cwnd;
        st.retx.push_back(Chunk {
            obj: pk.obj,
            offset: pk.offset,
            len: pk.len,
            seq: pk.seq,
            of: k,
        });
        self.packets[k].detected_ns = Some(t);
        self.packets[k].detected_by = Some(how.to_string());
        let name = self.name(pk.obj);
        let n = c + 1;
        self.record(t, "L1", Some(c), Some(pk.obj), Some(k), || {
            format!(
                "The server declares packet {} on connection {n} ({name}) lost, {}, and queues it again.{}",
                pk.num,
                if how == "threshold" {
                    "because three packets sent after it have been acknowledged"
                } else {
                    "because its timer ran out with too few packets after it"
                },
                if new_period {
                    format!(" The window halves to {cwnd:.1} packets.")
                } else {
                    " The window was already cut for this episode.".to_string()
                }
            )
        });
    }
}

/// Loads the page once.
pub fn http_run(p: &HttpParams) -> Result<HttpRun, String> {
    if p.objects.is_empty() || p.objects.iter().any(|o| o.bytes == 0) {
        return Err("a page needs at least one object, each of at least one byte".into());
    }
    let mut s = Sim::new(p);
    s.open(0, vec![0]);
    let mut steps = 0u64;
    while let Some((t, ev)) = s.q.pop() {
        steps += 1;
        if steps > 5_000_000 {
            return Err("the run did not finish".into());
        }
        match ev {
            Ev::Ready(c) => s.on_ready(c, t),
            Ev::Requests(c, objs) => s.on_requests(c, objs, t),
            Ev::Arrive(k) => s.on_arrive(k, t),
            Ev::Ack(k) => s.on_ack(k, t),
            Ev::Timer(k) => s.on_timer(k, t),
        }
    }
    if s.complete != p.objects.len() {
        return Err("the page did not complete".into());
    }
    let stats = HttpStats {
        plt_ns: s.plt,
        ttfb_ns: s.objs[0].first_byte_ns,
        setup_rtts: setup_rtts(p),
        connections: s.conns.len(),
        packets: s.packets.len(),
        lost: s.packets.iter().filter(|k| k.lost).count(),
        bytes: p.objects.iter().map(|o| o.bytes).sum(),
        held_objects: s.objs.iter().filter(|o| o.held_packets > 0).count(),
        held_ns: s.objs.iter().map(|o| o.held_ns).sum(),
    };
    Ok(HttpRun {
        conns: s.conns,
        msgs: s.msgs,
        packets: s.packets,
        objects: s.objs,
        events: s.events,
        stats,
    })
}

/// One way of loading the page, for the comparison sweep.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Variant {
    pub protocol: Protocol,
    #[serde(default = "one")]
    pub parallel: u32,
    #[serde(default)]
    pub pipelining: bool,
    #[serde(default)]
    pub tls: bool,
    #[serde(default)]
    pub zero_rtt: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Loss,
    Rtt,
}

/// Mean page load time in milliseconds over seeds 1 to `seeds`, for each
/// variant at each value of the axis (a loss probability, or an RTT in µs).
pub fn http_sweep(
    base: &HttpParams,
    variants: &[Variant],
    axis: Axis,
    values: &[f64],
    seeds: u64,
) -> Result<Vec<Vec<f64>>, String> {
    variants
        .iter()
        .map(|v| {
            values
                .iter()
                .map(|&x| {
                    let mut total = 0.0;
                    for seed in 1..=seeds {
                        let mut p = base.clone();
                        p.protocol = v.protocol;
                        p.parallel = v.parallel;
                        p.pipelining = v.pipelining;
                        p.tls = v.tls;
                        p.zero_rtt = v.zero_rtt;
                        p.trace = false;
                        p.seed = seed;
                        p.drops.clear();
                        match axis {
                            Axis::Loss => p.loss = x,
                            Axis::Rtt => p.rtt_us = x.round() as u64,
                        }
                        total += http_run(&p)?.stats.plt_ns as f64 / 1e6;
                    }
                    Ok(total / seeds as f64)
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn page(sizes: &[u64]) -> Vec<Object> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, &b)| Object {
                name: if i == 0 {
                    "index.html".into()
                } else {
                    format!("o{i}")
                },
                bytes: b,
            })
            .collect()
    }

    /// 8 Mb/s puts one byte on the wire in exactly 1 µs.
    fn params(protocol: Protocol, sizes: &[u64]) -> HttpParams {
        HttpParams {
            protocol,
            parallel: 1,
            pipelining: false,
            tls: false,
            zero_rtt: false,
            schedule: Schedule::Interleave,
            objects: page(sizes),
            rtt_us: 50_000,
            rate_bps: 8_000_000,
            mss_bytes: 1460,
            iw: 10,
            loss: 0.0,
            drops: Vec::new(),
            seed: 1,
            trace: true,
        }
    }

    const BYTE: u64 = 1000; // ns per byte at 8 Mb/s

    #[test]
    fn time_to_first_byte_counts_the_handshake_round_trips() {
        // TTFB = (setup + 1) RTT + the first packet's transmission time:
        // TCP 1, TCP + TLS 1.3 2, TLS 0-RTT 1, QUIC 1, QUIC 0-RTT 0.
        let rtt = 50 * MS;
        for (proto, tls, zero, setup) in [
            (Protocol::H11, false, false, 1),
            (Protocol::H11, true, false, 2),
            (Protocol::H11, true, true, 1),
            (Protocol::H2, true, false, 2),
            (Protocol::H3, false, false, 1),
            (Protocol::H3, false, true, 0),
        ] {
            let mut p = params(proto, &[1000]);
            p.tls = tls;
            p.zero_rtt = zero;
            let r = http_run(&p).unwrap();
            assert_eq!(r.stats.setup_rtts, setup);
            assert_eq!(
                r.stats.ttfb_ns,
                (setup + 1) * rtt + 1000 * BYTE,
                "{proto:?} tls {tls} 0-RTT {zero}"
            );
            assert_eq!(r.stats.plt_ns, r.stats.ttfb_ns);
        }
    }

    #[test]
    fn http10_and_persistent_http11_match_the_textbook_formulas() {
        // Objects that fit in the initial window (10 × 1460 bytes).
        let sizes = [10_000, 4_000, 14_600, 1, 7_300, 2_920];
        let rtt = 50 * MS;
        let sum: u64 = sizes.iter().map(|b| b * BYTE).sum();
        let n = sizes.len() as u64;
        // Non-persistent, one at a time: 2 RTT + L/R per object.
        let r = http_run(&params(Protocol::H10, &sizes)).unwrap();
        assert_eq!(r.stats.plt_ns, n * 2 * rtt + sum);
        assert_eq!(r.stats.connections, sizes.len());
        // Persistent without pipelining: one handshake, then RTT + L/R each.
        let r = http_run(&params(Protocol::H11, &sizes)).unwrap();
        assert_eq!(r.stats.plt_ns, rtt + n * rtt + sum);
        assert_eq!(r.stats.connections, 1);
        // Non-persistent with enough parallel connections: the base, then
        // one more handshake and request, and every embedded object back to
        // back through the bottleneck.
        let mut p = params(Protocol::H10, &sizes);
        p.parallel = 8;
        let r = http_run(&p).unwrap();
        assert_eq!(
            r.stats.plt_ns,
            2 * rtt + sizes[0] * BYTE + 2 * rtt + (sum - sizes[0] * BYTE)
        );
    }

    #[test]
    fn pipelined_responses_wait_for_the_one_ahead_of_them() {
        let sizes = [2_000, 200_000, 1_000];
        let mut p = params(Protocol::H11, &sizes);
        p.pipelining = true;
        let r = http_run(&p).unwrap();
        // Both requests leave together, but the small response comes second.
        assert_eq!(r.objects[1].requested_ns, r.objects[2].requested_ns);
        assert!(r.objects[2].done_ns > r.objects[1].done_ns);
        // HTTP/2 interleaves them: the small one is done long before.
        let r2 = http_run(&params(Protocol::H2, &sizes)).unwrap();
        assert!(r2.objects[2].done_ns < r2.objects[1].done_ns);
        assert!(r2.objects[2].done_ns + 100 * MS < r.objects[2].done_ns);
    }

    /// The first loss in each run, its first retransmission and when that arrived.
    fn lost_and_repair(r: &HttpRun) -> (usize, u64) {
        let k = r.packets.iter().position(|q| q.lost).unwrap();
        let fix = r.packets.iter().find(|q| q.retx_of == Some(k)).unwrap();
        (k, fix.arrive_ns.unwrap())
    }

    #[test]
    fn one_loss_stalls_every_http2_stream_but_one_http3_stream() {
        let sizes = [5_000, 40_000, 40_000, 40_000, 40_000];
        let mut h2 = params(Protocol::H2, &sizes);
        h2.tls = true;
        h2.drops = vec![12];
        let mut h3 = params(Protocol::H3, &sizes);
        h3.drops = vec![12];
        let r2 = http_run(&h2).unwrap();
        let r3 = http_run(&h3).unwrap();
        // The same data is in the lost packet either way.
        assert_eq!(
            (r2.packets[12].obj, r2.packets[12].offset),
            (r3.packets[12].obj, r3.packets[12].offset)
        );
        let (k2, fix2) = lost_and_repair(&r2);
        let (k3, fix3) = lost_and_repair(&r3);
        assert_eq!((k2, k3), (12, 12));
        let victim = r2.packets[12].obj;
        // HTTP/2: every packet after the hole that arrived before the repair
        // waits for it, whichever stream it carries.
        let mut streams = std::collections::BTreeSet::new();
        for q in &r2.packets {
            if q.seq > r2.packets[k2].seq && q.arrive_ns.is_some_and(|a| a < fix2) {
                assert_eq!(q.delivered_ns, Some(fix2));
                streams.insert(q.obj);
            }
        }
        assert_eq!(streams.len(), 4, "all four streams stall");
        assert_eq!(r2.stats.held_objects, 4);
        // HTTP/3: only the victim's later bytes wait; the others go straight up.
        for q in &r3.packets {
            let Some(a) = q.arrive_ns else { continue };
            if q.obj != victim {
                assert_eq!(q.delivered_ns, Some(a));
            } else if q.offset > r3.packets[k3].offset && a < fix3 {
                assert_eq!(q.delivered_ns, Some(fix3));
            }
        }
        assert_eq!(r3.stats.held_objects, 1);
        // Found by the packet threshold, not the timer, in both.
        assert_eq!(r2.packets[12].detected_by.as_deref(), Some("threshold"));
        assert_eq!(r3.packets[12].detected_by.as_deref(), Some("threshold"));
    }

    #[test]
    fn a_tail_loss_waits_for_the_timer() {
        // The last packet of a one-object page has nothing after it.
        let mut p = params(Protocol::H11, &[5_000]);
        p.drops = vec![3];
        let r = http_run(&p).unwrap();
        let k = &r.packets[3];
        assert_eq!(k.detected_by.as_deref(), Some("timer"));
        assert_eq!(k.detected_ns, Some(k.depart_ns + 2 * 50 * MS));
    }

    #[test]
    fn every_byte_is_delivered_once_and_in_order_per_object() {
        let sizes = [12_000, 60_000, 3_000, 90_000, 500, 25_000];
        for proto in [Protocol::H10, Protocol::H11, Protocol::H2, Protocol::H3] {
            for (par, pipe) in [(1, false), (3, false), (2, true)] {
                if proto != Protocol::H11 && pipe {
                    continue;
                }
                for seed in 1..=5 {
                    let mut p = params(proto, &sizes);
                    p.parallel = par;
                    p.pipelining = pipe;
                    p.loss = 0.05;
                    p.seed = seed;
                    let r = http_run(&p).unwrap();
                    for (o, &bytes) in sizes.iter().enumerate() {
                        let mut got: Vec<&Packet> = r
                            .packets
                            .iter()
                            .filter(|q| q.obj == o && q.delivered_ns.is_some())
                            .collect();
                        got.sort_by_key(|q| q.offset);
                        let mut at = 0;
                        let mut last = 0;
                        for q in got {
                            assert_eq!(
                                q.offset, at,
                                "{proto:?} seed {seed}: object {o} has a gap or a duplicate"
                            );
                            at += u64::from(q.len);
                            let d = q.delivered_ns.unwrap();
                            assert!(d >= last && d >= q.arrive_ns.unwrap());
                            last = d;
                        }
                        assert_eq!(at, bytes);
                        assert_eq!(r.objects[o].done_ns, last);
                    }
                    // Every loss was repaired by exactly one packet that arrived, in the end.
                    for (k, q) in r.packets.iter().enumerate() {
                        if q.lost {
                            assert!(q.detected_ns.is_some());
                            assert_eq!(
                                r.packets.iter().filter(|x| x.retx_of == Some(k)).count(),
                                1
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_seed_fixes_the_run() {
        let mut p = params(Protocol::H3, &[10_000, 50_000, 50_000]);
        p.loss = 0.03;
        let a = format!("{:?}", http_run(&p).unwrap());
        let b = format!("{:?}", http_run(&p).unwrap());
        assert_eq!(a, b);
        p.seed = 2;
        let c = format!("{:?}", http_run(&p).unwrap());
        assert_ne!(a, c);
    }

    #[test]
    fn the_sweep_agrees_with_single_runs() {
        let p = params(Protocol::H2, &[10_000, 30_000, 30_000]);
        let v = [Variant {
            protocol: Protocol::H3,
            parallel: 1,
            pipelining: false,
            tls: false,
            zero_rtt: false,
        }];
        let s = http_sweep(&p, &v, Axis::Rtt, &[20_000.0, 80_000.0], 2).unwrap();
        let mut q = p.clone();
        q.protocol = Protocol::H3;
        q.rtt_us = 80_000;
        assert_eq!(s[0][1], http_run(&q).unwrap().stats.plt_ns as f64 / 1e6);
        assert!(s[0][0] < s[0][1]);
    }
}
