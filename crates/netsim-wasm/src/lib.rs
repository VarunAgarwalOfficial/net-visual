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

use netsim::rdt;

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
