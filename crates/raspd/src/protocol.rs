//! Bun aspd's frame rules and refusal envelopes (T-11728), byte for byte.
//!
//! Sources: harness/harness-broker/src/protocol-server.ts (framing, refusal
//! order), contracts/harness-broker-protocol/src/jsonrpc.ts (message
//! classification) and harness/aspc-facade/src/aspd.ts (`adviseAspdError`).
use crate::json::J;

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
    /// serde_json could not judge it; Bun decides.
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
    let Some(value) = crate::json::parse(line) else {
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

/// The three frame refusals Bun answers before parsing (`refuseFrame`).
pub fn frame_refusal(reason: &str) -> String {
    let message = match reason {
        "empty_frame" => "Empty NDJSON frame".to_owned(),
        "frame_too_large" => format!("NDJSON frame exceeds {MAX_FRAME_BYTES} bytes"),
        _ => "Parse error".to_owned(),
    };
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
    if record.and_then(|r| r.get("ok")) != Some(&serde_json::Value::Bool(false)) {
        return Completion {
            outcome: "ok".into(),
            error_code: None,
            message: None,
        };
    }
    let record = record.unwrap();
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
}
