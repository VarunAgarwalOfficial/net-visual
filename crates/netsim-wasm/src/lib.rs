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

use netsim::{rdt, tcp};

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
}
