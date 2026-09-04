// Quackoscope host (Rust) -- transport layer.
//
// JSON envelope encode/decode and binary data-frame framing for the M1 wire
// contract. This module, and everything else under transport/, must never
// mention the openDAQ crate.

use serde_json::{json, Map, Value as Json};

/// The binary frame header of contract section 9: 17 bytes, little-endian.
pub const DATA_FRAME_HEADER_BYTES: usize = 17;

/// A decoded `{"id": n, "method": "...", "params": {...}}` request envelope.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: i64,
    pub method: String,
    pub params: Json,
}

/// What a request handler gives back. The transport turns this into either
/// `{"id": n, "result": ...}` or `{"id": n, "error": {"code":..., "detail":...}}`.
#[derive(Debug, Clone)]
pub enum Outcome {
    /// contract section 8, envelopes.result
    Result(Json),
    /// contract section 8, envelopes.error; `code` is a member of the closed set
    Failure { code: String, detail: String },
}

/// Decode a text frame into a [`Request`]. A decoding failure comes back as a
/// complete error envelope, ready to send straight back to the client.
pub fn decode_request(text: &str) -> Result<Request, Json> {
    let parsed: Json = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            let opening: String = text.chars().take(120).collect();
            return Err(encode_error(
                0,
                "invalid_value",
                &format!(
                    "malformed JSON frame: {e}; the {} received bytes began {opening:?}",
                    text.len()
                ),
            ));
        }
    };

    let object = match parsed.as_object() {
        Some(object) => object,
        None => {
            return Err(encode_error(
                0,
                "invalid_value",
                &format!("request must be a JSON object; got {parsed}"),
            ))
        }
    };

    let id = match object.get("id").and_then(Json::as_i64) {
        Some(id) => id,
        None => {
            return Err(encode_error(
                0,
                "invalid_value",
                "request must be an object with an integer \"id\"",
            ))
        }
    };

    let method = match object.get("method").and_then(Json::as_str) {
        Some(method) => method.to_string(),
        None => {
            return Err(encode_error(
                id,
                "invalid_value",
                "request must carry a string \"method\"",
            ))
        }
    };

    let params = match object.get("params") {
        Some(params) if params.is_object() => params.clone(),
        _ => Json::Object(Map::new()),
    };

    Ok(Request { id, method, params })
}

pub fn encode_result(id: i64, result: Json) -> Json {
    json!({ "id": id, "result": result })
}

pub fn encode_error(id: i64, code: &str, detail: &str) -> Json {
    json!({ "id": id, "error": { "code": code, "detail": detail } })
}

/// 17-byte little-endian header, then the payload doubles:
///   uint32 subscription_id
///   uint64 domain_start
///   uint32 sample_count
///   uint8  encoding      (0 = raw, 1 = min_max_envelope)
pub fn encode_data_frame(
    subscription_id: u32,
    domain_start: u64,
    sample_count: u32,
    encoding: u8,
    payload: &[f64],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(DATA_FRAME_HEADER_BYTES + payload.len() * 8);
    frame.extend_from_slice(&subscription_id.to_le_bytes());
    frame.extend_from_slice(&domain_start.to_le_bytes());
    frame.extend_from_slice(&sample_count.to_le_bytes());
    frame.push(encoding);
    for value in payload {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    debug_assert_eq!(frame.len(), DATA_FRAME_HEADER_BYTES + payload.len() * 8);
    frame
}
