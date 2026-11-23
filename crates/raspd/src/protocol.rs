//! Bun aspd's frame rules and refusal envelopes (T-11728), byte for byte.
//!
//! Sources: harness/harness-broker/src/protocol-server.ts (framing, refusal
//! order), contracts/harness-broker-protocol/src/jsonrpc.ts (message
//! classification) and harness/aspc-facade/src/aspd.ts (`adviseAspdError`).
use crate::json::{J, js_number, quoted};

/// 16 MiB, excluding the LF delimiter (`ASPD_MAX_FRAME_BYTES`).
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// What one decoded frame is, as Bun's protocol server would treat it.
pub enum Frame {
    /// `isJsonRpcRequest`: answered natively or forwarded.
    Request(Request),
    /// A notification or a client-sent response: Bun answers nothing.
    Silent,
    /// Valid JSON but not a JSON-RPC message: `Parse error`.
    Malformed,
    /// Text `JSON.parse` throws on (or that raspd does not chase): `Parse error`.
    Unjudged,
}

pub struct Request {
    pub id: J,
    pub method: String,
    pub params: Option<J>,
    /// The envelope's `client`, or `unknown`.
    pub client: String,
}

fn is_id(v: &J) -> bool {
    matches!(v, J::Null | J::Str(_) | J::Num(_))
}

pub fn classify(line: &[u8]) -> Frame {
    let Some(value) = crate::json::parse_frame(line) else {
        return Frame::Unjudged;
    };
    if !value.is_record() || value.get("jsonrpc") != Some(&J::str("2.0")) {
        return Frame::Malformed;
    }
    let method = value.get("method");
    let id = value.get("id");
    let has_result = value.has("result");
    let has_error = value.has("error");
    if let Some(J::Str(method)) = method
        && let Some(id) = id
        && is_id(id)
        && !has_result
        && !has_error
    {
        let client = match value.get("client") {
            Some(J::Str(c)) if !c.is_empty() => c.clone(),
            _ => "unknown".into(),
        };
        return Frame::Request(Request {
            id: id.clone(),
            method: method.clone(),
            params: value.get("params").cloned(),
            client,
        });
    }
    if matches!(method, Some(J::Str(_))) && id.is_none() && !has_result && !has_error {
        return Frame::Silent;
    }
    if let Some(id) = id
        && is_id(id)
        && method.is_none()
        && has_result != has_error
    {
        let error_ok = !has_error
            || value.get("error").is_some_and(|e| {
                matches!(e.get("code"), Some(J::Num(n)) if n.fract() == 0.0)
                    && matches!(e.get("message"), Some(J::Str(_)))
            });
        if error_ok {
            return Frame::Silent;
        }
    }
    Frame::Malformed
}

pub const PARSE_ADVICE: &str = r#"Send a JSON-RPC object followed by LF, for example {"jsonrpc":"2.0","id":1,"method":"health","params":{}}."#;

/// `adviseAspdError`'s reason and advice for `method`.
pub fn advice(reason: &str, method: &str) -> String {
    match reason {
        "op_unknown" => "Call surface with params: {} to list valid operations.".into(),
        "frame_too_large" => format!(
            "Send one JSON-RPC request of at most {MAX_FRAME_BYTES} UTF-8 bytes followed by LF; call health with params: {{}} to check recovery."
        ),
        "empty_frame" | "parse_error" => PARSE_ADVICE.into(),
        "invalid_params" => format!(
            "Correct the named params issues and call {method} again; call surface with params: {{}} to list operations."
        ),
        _ => format!(
            "Retry {method} with the same params (compile service calls are idempotent); call health with params: {{}} if the failure persists."
        ),
    }
}

/// One error reply line (without LF). `data` fields precede reason and advice,
/// as `{ ...data, reason, advice }` writes them.
pub fn error_line(
    id: &J,
    code: i64,
    message: &str,
    mut data: Vec<(String, J)>,
    reason: &str,
    method: &str,
) -> String {
    data.retain(|(k, _)| k != "reason" && k != "advice");
    data.push(("reason".into(), J::str(reason)));
    data.push(("advice".into(), J::str(advice(reason, method))));
    J::Obj(vec![
        ("jsonrpc".into(), J::str("2.0")),
        ("id".into(), id.clone()),
        (
            "error".into(),
            J::Obj(vec![
                ("code".into(), J::Num(code as f64)),
                ("message".into(), J::str(message)),
                ("data".into(), J::Obj(data)),
            ]),
        ),
    ])
    .to_json()
}

pub fn result_line(id: &J, result: &J) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{},"result":{}}}"#,
        id.to_json(),
        result.to_json()
    )
}

/// The message of a frame refusal: `empty_frame`, `frame_too_large` or a
/// parse error.
pub fn frame_refusal_message(reason: &str) -> String {
    match reason {
        "empty_frame" => "Empty NDJSON frame".to_owned(),
        "frame_too_large" => format!("NDJSON frame exceeds {MAX_FRAME_BYTES} bytes"),
        _ => "Parse error".to_owned(),
    }
}

/// The three frame refusals Bun answers before parsing (`refuseFrame`).
pub fn frame_refusal(reason: &str) -> String {
    let message = frame_refusal_message(reason);
    error_line(&J::Null, -32700, &message, vec![], reason, "unmatched")
}

/// raspd's own refusal when Bun was never reached or did not answer.
pub fn upstream_refusal(id: &J, method: &str, detail: &str) -> String {
    error_line(
        id,
        -32603,
        &format!("aspd upstream unavailable: {detail}"),
        vec![],
        "upstream_unavailable",
        method,
    )
}

/// Every reply line, Bun's and raspd's, starts with this prefix, so a reply's
/// id and body are found without parsing the (possibly large) body.
const REPLY_PREFIX: &[u8] = br#"{"jsonrpc":"2.0","id":"#;

/// Where the id token ends in `rest` (what follows `"id":`).
fn id_token_end(rest: &[u8]) -> Option<usize> {
    if rest.first() == Some(&b'"') {
        let mut i = 1;
        while i < rest.len() {
            match rest[i] {
                b'\\' => i += 2,
                b'"' => return Some(i + 1),
                _ => i += 1,
            }
        }
        None
    } else {
        rest.iter().position(|b| *b == b',' || *b == b'}')
    }
}

/// The id token of a reply line, keyed as `quoted`/`js_number` write an id.
pub fn reply_id_key(line: &[u8]) -> Option<String> {
    let rest = line.strip_prefix(REPLY_PREFIX)?;
    let end = id_token_end(rest)?;
    let token = rest.get(..end)?;
    match serde_json::from_slice::<serde_json::Value>(token).ok()? {
        serde_json::Value::String(s) => Some(quoted(&s)),
        serde_json::Value::Number(n) => Some(js_number(n.as_f64()?)),
        serde_json::Value::Null => Some("null".into()),
        _ => None,
    }
}

/// The byte length of a reply line's `result` or `error` value: Bun's
/// `replyBytes`, without re-serializing a (possibly large) compile result.
pub fn reply_body_bytes(line: &[u8]) -> Option<usize> {
    let rest = line.strip_prefix(REPLY_PREFIX)?;
    let id_end = id_token_end(rest)?;
    let after = rest.get(id_end..)?;
    let body = after
        .strip_prefix(br#","result":"#)
        .or_else(|| after.strip_prefix(br#","error":"#))?;
    body.len().checked_sub(1)
}

/// What a reply means for the access log and metrics, as Bun's
/// `onRequestComplete` computes it: the outcome, and a message for non-ok.
pub struct Completion {
    pub outcome: String,
    pub error_code: Option<i64>,
    pub message: Option<String>,
}

const MAX_LOGGED_ERROR_CHARS: usize = 2000;

pub fn clip(message: &str) -> String {
    let mut chars = message.chars();
    let clipped: String = chars.by_ref().take(MAX_LOGGED_ERROR_CHARS).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

/// Read a reply line's outcome. `serde_json::Value` is fine here: nothing is
/// written back from it.
pub fn completion(reply: &serde_json::Value) -> Completion {
    if let Some(error) = reply.get("error") {
        let code = error.get("code").and_then(|c| c.as_f64()).map(|c| c as i64);
        return Completion {
            outcome: code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "undefined".into()),
            error_code: code,
            message: error.get("message").and_then(|m| m.as_str()).map(clip),
        };
    }
    let result = reply.get("result");
    let record = result.filter(|r| r.is_object());
    let Some(record) = record.filter(|r| r.get("ok") == Some(&serde_json::Value::Bool(false)))
    else {
        return Completion {
            outcome: "ok".into(),
            error_code: None,
            message: None,
        };
    };
    let first = record
        .get("diagnostics")
        .and_then(|d| d.as_array())
        .and_then(|d| d.first())
        .filter(|d| d.is_object());
    let resolution = record.get("resolution").filter(|r| r.is_object());
    let failure = record.get("failure").filter(|f| f.is_object());
    // `a ?? b ?? c ?? d`, as Bun's `resultOutcome`: null and absent both fall
    // through.
    fn present(v: Option<&serde_json::Value>) -> Option<&serde_json::Value> {
        v.filter(|v| !v.is_null())
    }
    let pick = |field: &str| {
        present(first.and_then(|f| f.get(field)))
            .or_else(|| present(resolution.and_then(|r| r.get(field))))
            .or_else(|| present(failure.and_then(|f| f.get(field))))
            .or_else(|| present(record.get(field)))
    };
    let code = pick("code")
        .and_then(|c| c.as_str())
        .unwrap_or("unknown")
        .to_owned();
    Completion {
        outcome: code,
        error_code: None,
        message: pick("message").and_then(|m| m.as_str()).map(clip),
    }
}

pub fn unmatched_completion(reason_message: &str) -> Completion {
    Completion {
        outcome: "-32700".into(),
        error_code: Some(-32700),
        message: Some(reason_message.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(result: serde_json::Value) -> Completion {
        completion(&json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
    }

    #[test]
    fn failure_code_labels_a_failure_result() {
        let c = reply(json!({
            "ok": false,
            "failure": { "kind": "unavailable", "code": "configured_source_unavailable", "message": "no root" }
        }));
        assert_eq!(c.outcome, "configured_source_unavailable");
        assert_eq!(c.message.as_deref(), Some("no root"));
    }

    #[test]
    fn diagnostics_then_resolution_then_failure_then_body() {
        let all = json!({
            "ok": false,
            "diagnostics": [{ "code": "d", "message": "dm" }],
            "resolution": { "code": "r", "message": "rm" },
            "failure": { "code": "f", "message": "fm" },
            "code": "b",
            "message": "bm"
        });
        let mut v = all.clone();
        assert_eq!(reply(v.clone()).outcome, "d");
        v.as_object_mut().unwrap().remove("diagnostics");
        assert_eq!(reply(v.clone()).outcome, "r");
        v.as_object_mut().unwrap().remove("resolution");
        assert_eq!(reply(v.clone()).outcome, "f");
        assert_eq!(reply(v.clone()).message.as_deref(), Some("fm"));
        v.as_object_mut().unwrap().remove("failure");
        assert_eq!(reply(v).outcome, "b");
        let none = json!({ "ok": false });
        assert_eq!(reply(none).outcome, "unknown");
    }

    #[test]
    fn reads_the_id_from_bun_reply_prefix() {
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":"a\"b","result":1}"#).as_deref(),
            Some(r#""a\"b""#)
        );
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":12,"result":1}"#).as_deref(),
            Some("12")
        );
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":null,"error":{}}"#).as_deref(),
            Some("null")
        );
    }
}
