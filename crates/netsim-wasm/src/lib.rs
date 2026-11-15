//! A plain C-ABI interface: no wasm-bindgen, no imports.
//!
//! The page writes a JSON request into memory from [`nv_alloc`], calls
//! [`nv_call`], reads the reply and returns both buffers with [`nv_free`].
//! A request is `{"tool": "...", "op": "...", "params": {...}}`; the reply is
//! `{"ok": ...}` or `{"error": "..."}`. Everything the page shows comes from
//! the models in the `netsim` crate.

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use netsim::{link, queue, rdt, routing, tcp};

/// Reserves `len` bytes and returns their address.
#[no_mangle]
pub extern "C" fn nv_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Releases a buffer of `len` bytes obtained from [`nv_alloc`] or [`nv_call`].
///
/// # Safety
/// `pointer` and `len` must describe exactly one such buffer, not yet freed.
#[no_mangle]
pub unsafe extern "C" fn nv_free(pointer: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(pointer, 0, len.max(1)));
}

/// Runs the request held in the `len` bytes at `pointer`.
///
/// Returns a buffer holding the reply length as a little-endian u32 followed
/// by that many bytes of JSON. Free it with `nv_free(p, 4 + length)`.
///
/// # Safety
/// `pointer` must be valid for reading `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn nv_call(pointer: *const u8, len: usize) -> *mut u8 {
    let request = std::slice::from_raw_parts(pointer, len);
    let reply = handle(request).to_string();
    let out = nv_alloc(4 + reply.len());
    std::ptr::copy_nonoverlapping((reply.len() as u32).to_le_bytes().as_ptr(), out, 4);
    std::ptr::copy_nonoverlapping(reply.as_ptr(), out.add(4), reply.len());
    out
}

#[derive(Deserialize)]
struct Request {
    tool: String,
    op: String,
    #[serde(default)]
    params: Value,
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

/// The model's own source, so the page's literate view always matches the
/// code that produced the trace.
fn source(tool: &str) -> Option<&'static str> {
    match tool {
        "rdt" => Some(include_str!("../../netsim/src/rdt.rs")),
        "tcp" => Some(include_str!("../../netsim/src/tcp.rs")),
        "routing" => Some(include_str!("../../netsim/src/routing.rs")),
        "queue" => Some(include_str!("../../netsim/src/queue.rs")),
        "link" => Some(include_str!("../../netsim/src/link.rs")),
        _ => None,
    }
}

pub fn handle(bytes: &[u8]) -> Value {
    let request: Request = match serde_json::from_slice(bytes) {
        Ok(r) => r,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let result: Result<Value, String> = (|| {
        Ok(match (request.tool.as_str(), request.op.as_str()) {
            (tool, "source") => json!(source(tool).ok_or("no source for this tool")?),
            ("rdt", "run") => {
                let p: rdt::Params = parse(request.params)?;
                check_rdt(&p)?;
                json!(rdt::run(&p))
            }
            ("rdt", "sweep") => {
                #[derive(Deserialize)]
                struct Sweep {
                    base: rdt::Params,
                    losses: Vec<f64>,
                }
                let s: Sweep = parse(request.params)?;
                check_rdt(&s.base)?;
                if s.losses.len() > 40 {
                    return Err("at most 40 loss values".into());
                }
                json!(rdt::sweep(&s.base, &s.losses))
            }
            ("tcp", "run") => {
                let p: tcp::Params = parse(request.params)?;
                check_tcp(&p)?;
                json!(tcp::run(&p))
            }
            ("routing", "run") => {
                let p: routing::Params = parse(request.params)?;
                check_routing(&p)?;
                json!(routing::run(&p))
            }
            ("queue", "run") => {
                let p: queue::Params = parse(request.params)?;
                check_queue(&p, 3000, 6000)?;
                json!(queue::run(&p))
            }
            ("queue", "sweep") => {
                #[derive(Deserialize)]
                struct Sweep {
                    base: queue::Params,
                    rhos: Vec<f64>,
                    packets: usize,
                }
                let s: Sweep = parse(request.params)?;
                check_queue(&s.base, usize::MAX, usize::MAX)?;
                let ok = (1..=12).contains(&s.rhos.len())
                    && s.rhos.iter().all(|r| (0.01..=0.95).contains(r))
                    && (1..=100_000).contains(&s.packets);
                if !ok {
                    return Err("parameters out of range".into());
                }
                json!(queue::sweep(&s.base, &s.rhos, s.packets))
            }
            ("link", "aloha") => {
                let p: link::AlohaParams = parse(request.params)?;
                check_aloha(&p, if p.trace { 20_000.0 } else { 2_000_000.0 })?;
                json!(link::aloha_run(&p))
            }
            ("link", "aloha_sweep") => {
                #[derive(Deserialize)]
                struct Sweep {
                    base: link::AlohaParams,
                    gs: Vec<f64>,
                }
                let s: Sweep = parse(request.params)?;
                if !(1..=40).contains(&s.gs.len()) {
                    return Err("parameters out of range".into());
                }
                for &g in &s.gs {
                    check_aloha(
                        &link::AlohaParams {
                            g,
                            ..s.base.clone()
                        },
                        500_000.0,
                    )?;
                }
                json!(link::aloha_sweep(&s.base, &s.gs))
            }
            ("link", "csmacd") => {
                let p: link::CdParams = parse(request.params)?;
                check_cd(&p, if p.trace { 4e6 } else { 4e8 })?;
                json!(link::cd_run(&p))
            }
            ("link", "csmacd_sweep") => {
                #[derive(Deserialize)]
                struct Sweep {
                    base: link::CdParams,
                    frame_bytes: Vec<u32>,
                }
                let s: Sweep = parse(request.params)?;
                check_cd(&s.base, 2e8)?;
                if !(1..=24).contains(&s.frame_bytes.len())
                    || !s.frame_bytes.iter().all(|b| (1..=9000).contains(b))
                {
                    return Err("parameters out of range".into());
                }
                json!(link::cd_sweep(&s.base, &s.frame_bytes))
            }
            ("link", "csmaca") => {
                let p: link::CaParams = parse(request.params)?;
                check_ca(&p)?;
                json!(link::ca_run(&p))
            }
            (tool, op) => return Err(format!("unknown request {tool}/{op}")),
        })
    })();
    match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    }
}

fn check_rdt(p: &rdt::Params) -> Result<(), String> {
    let ok = (1..=600).contains(&p.messages)
        && (1..=64).contains(&p.window)
        && (1..=16).contains(&p.seq_bits)
        && p.rate_bps >= 1000
        && p.data_bytes >= 1
        && p.timeout_us >= 1
        && (0.0..1.0).contains(&p.loss_data)
        && (0.0..1.0).contains(&p.loss_ack);
    if ok {
        Ok(())
    } else {
        Err("parameters out of range".into())
    }
}

/// Bounds that keep one run to a few million packets, so a shared link
/// cannot hang the page.
fn check_tcp(p: &tcp::Params) -> Result<(), String> {
    let packets =
        p.duration_us as f64 / 1e6 * p.rate_bps as f64 / (8.0 * p.mss_bytes.max(1) as f64);
    let ok = (1..=4).contains(&p.flows.len())
        && p.flows
            .iter()
            .all(|f| (1_000..=2_000_000).contains(&f.rtt_us) && f.start_us < p.duration_us)
        && (64_000..=10_000_000_000).contains(&p.rate_bps)
        && (100..=9000).contains(&p.mss_bytes)
        && p.buffer_pkts <= 100_000
        && (0.0..0.5).contains(&p.loss)
        && (p.drop_every == 0 || p.drop_every >= 2)
        && p.jitter_us <= 1_000_000
        && (1_000..=600_000_000).contains(&p.duration_us)
        && packets <= 3e6
        && (1.0..=100.0).contains(&p.iw)
        && p.init_ssthresh >= 2.0
        && (1.0..=1e6).contains(&p.max_window)
        && p.min_rto_us <= 10_000_000
        && p.drops.len() <= 64
        && p.drops.iter().all(|d| d.flow < p.flows.len());
    if ok {
        Ok(())
    } else {
        Err("parameters out of range".into())
    }
}

/// Bounds that keep a run small: ten routers, positive costs below the
/// infinity, and an infinity low enough that counting to it ends.
fn check_routing(p: &routing::Params) -> Result<(), String> {
    let n = p.nodes.len();
    let pair = |a: usize, b: usize| a < n && b < n && a != b;
    let ok = (2..=10).contains(&n)
        && p.nodes
            .iter()
            .all(|s| (1..=12).contains(&s.chars().count()))
        && p.links.len() <= 45
        && p.links
            .iter()
            .all(|l| pair(l.a, l.b) && (1..p.infinity).contains(&l.cost))
        && p.changes.len() <= 12
        && p.changes.iter().all(|c| {
            pair(c.a, c.b)
                && c.cost.is_none_or(|k| (1..p.infinity).contains(&k))
                && c.at_us <= 10_000_000_000
        })
        && (2..=1000).contains(&p.infinity)
        && (1..=10_000_000).contains(&p.delay_us)
        && p.jitter_us <= 10 * p.delay_us
        // A period of at least a delay and at most ten minutes; a timeout,
        // if any, longer than the period; an end within a day.
        && (p.period_us == 0 || (p.delay_us..=600_000_000).contains(&p.period_us))
        && (p.timeout_us == 0 || (p.period_us < p.timeout_us && p.timeout_us <= 3_600_000_000))
        && p.end_us <= 86_400_000_000;
    if ok {
        Ok(())
    } else {
        Err("parameters out of range".into())
    }
}

/// Bounds for the queueing model: a few thousand traced packets per run, a
/// token bucket that can hold any packet its flow sends (or it would wait
/// forever), and physical values within reason.
fn check_queue(p: &queue::Params, per_flow: usize, total: usize) -> Result<(), String> {
    use queue::{ShaperKind, Sizes};
    let ok = (1..=4).contains(&p.flows.len())
        && p.flows.iter().map(|f| f.packets).sum::<usize>() <= total
        && p.flows.iter().all(|f| {
            (1..=per_flow).contains(&f.packets)
                && (40..=9000).contains(&f.size_bytes)
                && f.rate_pps > 0.0
                && f.rate_pps <= 1e6
                && f.on_us <= 10_000_000
                && f.off_us <= 10_000_000
                && f.start_us <= 10_000_000
                && (1..=100).contains(&f.weight)
                && f.priority <= 7
                && match f.shaper.kind {
                    ShaperKind::None => true,
                    ShaperKind::Token => {
                        f.sizes == Sizes::Fixed
                            && (1_000..=10_000_000_000).contains(&f.shaper.rate_bps)
                            && (f.size_bytes as u64..=10_000_000).contains(&f.shaper.bucket_bytes)
                    }
                    ShaperKind::Leaky => {
                        (1_000..=10_000_000_000).contains(&f.shaper.rate_bps)
                            && f.shaper.bucket_bytes <= 10_000_000
                    }
                }
        })
        && (1_000..=10_000_000_000).contains(&p.rate_bps)
        && p.proc_us <= 1_000_000
        && p.distance_m <= 40_000_000
        && (10_000_000..=300_000_000).contains(&p.speed_mps)
        && p.buffer_pkts <= 10_000;
    if ok {
        Ok(())
    } else {
        Err("parameters out of range".into())
    }
}

fn in_range(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err("parameters out of range".into())
    }
}

/// ALOHA: at most `frames` frames (offered load times length), and a load
/// each station can carry (pure ALOHA needs a silence between frames, so
/// G must stay below the number of stations).
fn check_aloha(p: &link::AlohaParams, frames: f64) -> Result<(), String> {
    let n = p.stations as f64;
    in_range(
        (1..=200).contains(&p.stations)
            && p.g.is_finite()
            && p.g >= 0.0
            && p.g <= 10.0
            && (if p.slotted { p.g <= n } else { p.g < n })
            && (1..=1_000_000).contains(&p.frame_us)
            && (1..=500_000).contains(&p.length)
            && p.g * p.length as f64 <= frames,
    )
}

/// CSMA/CD: a bus of at most 10 km with 32 stations, a run of at most
/// `bits` bit times, and timings of at least a bit.
fn check_cd(p: &link::CdParams, bits: f64) -> Result<(), String> {
    in_range(
        (2..=32).contains(&p.stations.len())
            && p.stations.iter().all(|s| {
                s.pos_m <= 10_000
                    && s.start_ns <= p.duration_ns
                    && s.frames <= 100_000
                    && (1..=12).contains(&s.name.chars().count())
            })
            && (1_000_000..=10_000_000_000).contains(&p.rate_bps)
            && (1..=9000).contains(&p.frame_bytes)
            && (8..=8192).contains(&p.slot_bits)
            && (1..=512).contains(&p.jam_bits)
            && (1..=1000).contains(&p.ifg_bits)
            && (10_000_000..=300_000_000).contains(&p.speed_mps)
            && (1..=32).contains(&p.attempt_limit)
            && p.backoff_cap <= 16
            && p.duration_ns >= 1
            && p.duration_ns as f64 * p.rate_bps as f64 / 1e9 <= bits,
    )
}

/// CSMA/CA: a dozen nodes in a 20 km square, one flow per sender, and a
/// run of at most a few hundred thousand frames.
fn check_ca(p: &link::CaParams) -> Result<(), String> {
    let n = p.nodes.len();
    let mut senders: Vec<usize> = p.flows.iter().map(|f| f.from).collect();
    senders.sort();
    senders.dedup();
    let shortest = link::ca_air_us(p, link::ACK_BYTES.min(link::CTS_BYTES)) + p.sifs_us;
    in_range(
        (2..=12).contains(&n)
            && p.nodes.iter().all(|v| {
                v.x_m.abs() <= 10_000.0
                    && v.y_m.abs() <= 10_000.0
                    && (1..=12).contains(&v.name.chars().count())
            })
            && p.range_m.is_finite()
            && (1.0..=20_000.0).contains(&p.range_m)
            && (1..=n).contains(&p.flows.len())
            && senders.len() == p.flows.len()
            && p.flows.iter().all(|f| {
                f.from < n
                    && f.to < n
                    && f.from != f.to
                    && f.start_us <= p.duration_us
                    && f.frames <= 100_000
            })
            && (1_000_000..=1_000_000_000).contains(&p.rate_bps)
            && p.payload_bytes <= 2304
            && (1..=100).contains(&p.slot_us)
            && (1..=100).contains(&p.sifs_us)
            && (1..=1023).contains(&p.cw_min)
            && (p.cw_min..=65_535).contains(&p.cw_max)
            && (1..=16).contains(&p.attempt_limit)
            && p.preamble_us <= 1000
            && (1..=10_000_000).contains(&p.duration_us)
            && p.duration_us / shortest <= 400_000,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_requests_and_reports_errors() {
        let reply = handle(br#"{"tool":"rdt","op":"source"}"#);
        assert!(reply["ok"]
            .as_str()
            .unwrap()
            .contains("S1. [Fill the window.]"));
        assert!(handle(b"not json")["error"].is_string());
        assert!(handle(br#"{"tool":"rdt","op":"fly"}"#)["error"].is_string());
    }

    #[test]
    fn checks_queue_requests() {
        let flow = r#"{"name":"a","rate_pps":500,"size_bytes":1000,"packets":100}"#;
        let req = |flow: &str, op: &str| {
            let params = format!(
                r#"{{"flows":[{flow}],"rate_bps":8000000,"proc_us":0,"distance_m":0,"speed_mps":200000000,"buffer_pkts":0,"seed":1}}"#
            );
            let body = if op == "run" {
                params
            } else {
                format!(r#"{{"base":{params},"rhos":[0.5],"packets":1000}}"#)
            };
            handle(format!(r#"{{"tool":"queue","op":"{op}","params":{body}}}"#).as_bytes())
        };
        assert_eq!(req(flow, "run")["ok"]["stats"]["served"], 100);
        assert_eq!(req(flow, "sweep")["ok"].as_array().unwrap().len(), 1);
        // A token bucket smaller than the packet would hold it for ever.
        let tight = r#"{"name":"a","rate_pps":500,"size_bytes":1000,"packets":100,"shaper":{"kind":"token","rate_bps":1000000,"bucket_bytes":500}}"#;
        assert!(req(tight, "run")["error"].is_string());
        let many = r#"{"name":"a","rate_pps":500,"size_bytes":1000,"packets":5000}"#;
        assert!(req(many, "run")["error"].is_string());
        assert!(handle(br#"{"tool":"queue","op":"source"}"#)["ok"]
            .as_str()
            .unwrap()
            .contains("W1. [Tag for fair queueing.]"));
    }

    #[test]
    fn checks_link_requests() {
        let ask = |op: &str, body: &str| {
            handle(format!(r#"{{"tool":"link","op":"{op}","params":{body}}}"#).as_bytes())
        };
        let aloha = |g: f64| {
            format!(
                r#"{{"slotted":false,"stations":10,"g":{g},"frame_us":1000,"length":200,"seed":1}}"#
            )
        };
        assert!(ask("aloha", &aloha(0.5))["ok"]["frames"].is_array());
        // Pure ALOHA cannot offer as much load as it has stations.
        assert!(ask("aloha", &aloha(10.0))["error"].is_string());
        let sweep = format!(r#"{{"base":{},"gs":[0.25,0.5]}}"#, aloha(0.5));
        assert_eq!(
            ask("aloha_sweep", &sweep)["ok"].as_array().unwrap().len(),
            2
        );
        let cd = |n: usize| {
            let st: Vec<String> = (0..n)
                .map(|i| format!(r#"{{"name":"S{i}","pos_m":{}}}"#, i * 100))
                .collect();
            format!(
                r#"{{"stations":[{}],"rate_bps":10000000,"frame_bytes":64,"slot_bits":512,"jam_bits":32,"ifg_bits":96,"speed_mps":200000000,"attempt_limit":16,"backoff_cap":10,"duration_ns":1000000,"seed":1}}"#,
                st.join(",")
            )
        };
        assert!(
            ask("csmacd", &cd(3))["ok"]["stats"]["delivered"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(ask("csmacd", &cd(40))["error"].is_string());
        let ca = |flows: &str| {
            format!(
                r#"{{"nodes":[{{"name":"A","x_m":0,"y_m":0}},{{"name":"B","x_m":50,"y_m":0}}],"range_m":100,"flows":{flows},"rts":true,"rate_bps":6000000,"payload_bytes":1000,"slot_us":9,"sifs_us":16,"cw_min":15,"cw_max":1023,"attempt_limit":7,"preamble_us":20,"duration_us":100000,"seed":1}}"#
            )
        };
        assert!(ask("csmaca", &ca(r#"[{"from":0,"to":1}]"#))["ok"]["airs"].is_array());
        // Two flows from one sender are not supported.
        assert!(
            ask("csmaca", &ca(r#"[{"from":0,"to":1},{"from":0,"to":1}]"#))["error"].is_string()
        );
        assert!(handle(br#"{"tool":"link","op":"source"}"#)["ok"]
            .as_str()
            .unwrap()
            .contains("E5. [Back off.]"));
    }
}
