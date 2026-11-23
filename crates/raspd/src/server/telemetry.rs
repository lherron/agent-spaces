//! The per-request report: the L3 `rpc.request` line and the metrics row for
//! every reply a connection writes, labelled with the route that produced it,
//! and the connection's own usage tally.
use super::Connection;
use crate::disposition::Reason;
use crate::json::J;
use crate::metrics::client_label;
use crate::protocol::{self, Completion};
use std::time::Duration;

/// Why a request was not answered natively: the reason (a metrics label)
/// and, when the reason has one, the key or value that decided it.
pub(super) struct Fallback {
    pub(super) reason: &'static str,
    pub(super) detail: Option<String>,
}

impl Fallback {
    pub(super) fn of(reason: Reason, detail: Option<String>) -> Fallback {
        Fallback {
            reason: reason.as_str(),
            detail,
        }
    }
}

/// The route that produced a reply. Refusal and relay provenance have
/// distinct states, so completion cannot label a native reply as relayed.
pub(super) enum ReplyRoute<'a> {
    Native,
    Refused(&'a Fallback),
    Relayed(Option<&'a Fallback>),
    UpstreamFailed(Option<&'a Fallback>),
}

/// Telemetry derived from one reply, including optional compile phases.
pub(super) struct ReplyTelemetry<'a> {
    pub(super) completion: &'a Completion,
    pub(super) bytes: Option<usize>,
    pub(super) phases: Option<J>,
}

impl Connection {
    /// The L3 `rpc.request` line and the metrics row, as Bun's
    /// `onRequestComplete` writes them, plus `servedBy` (and `relay` for Bun,
    /// and `fallback` for a native read relayed instead).
    pub(super) fn complete(
        &self,
        op: &str,
        client: &str,
        elapsed: Duration,
        reply: ReplyTelemetry<'_>,
        route: ReplyRoute<'_>,
    ) {
        let ReplyTelemetry {
            completion: c,
            bytes: reply_bytes,
            phases,
        } = reply;
        let (served_by, relay, fallback) = match route {
            ReplyRoute::Native => ("native", None, None),
            ReplyRoute::Refused(fallback) => ("native", Some("refused"), Some(fallback)),
            ReplyRoute::Relayed(fallback) => ("bun", Some("relayed"), fallback),
            ReplyRoute::UpstreamFailed(fallback) => ("bun", Some("upstream_failed"), fallback),
        };
        let ms = elapsed.as_secs_f64() * 1000.0;
        let level = if c.outcome == "ok" {
            "info"
        } else if c.error_code == Some(-32603) {
            "error"
        } else {
            "warn"
        };
        let mut data = vec![
            ("listener".to_owned(), J::str("raspd")),
            ("op".to_owned(), J::str(op)),
            ("client".to_owned(), J::str(client)),
            ("durationMs".to_owned(), J::Num((ms * 10.0).round() / 10.0)),
            ("outcome".to_owned(), J::str(&c.outcome)),
            ("servedBy".to_owned(), J::str(served_by)),
        ];
        if let Some(relay) = relay {
            data.push(("relay".into(), J::str(relay)));
        }
        if let Some(fallback) = fallback {
            data.push(("fallback".into(), J::str(fallback.reason)));
            if let Some(detail) = &fallback.detail {
                data.push(("fallbackDetail".into(), J::str(detail)));
            }
        }
        if let Some(message) = &c.message {
            data.push(("code".into(), J::str(&c.outcome)));
            data.push(("message".into(), J::str(protocol::clip(message))));
        }
        if let Some(phases) = phases {
            data.push(("phases".into(), phases));
        }
        self.shared.log.event(level, "rpc", "rpc.request", data);
        if let Some(metrics) = &self.shared.metrics {
            let label = client_label(client);
            {
                let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
                usage.0 += 1;
                if usage.1 == "unknown" {
                    usage.1 = label.clone();
                }
            }
            let mut key = vec![
                ("op", op),
                ("client", label.as_str()),
                ("outcome", c.outcome.as_str()),
                ("servedBy", served_by),
            ];
            if let Some(relay) = relay {
                key.push(("relay", relay));
            }
            if let Some(fallback) = fallback {
                key.push(("fallback", fallback.reason));
            }
            match reply_bytes {
                Some(bytes) => {
                    metrics.count("request", &key, &[("ms", ms), ("replyBytes", bytes as f64)])
                }
                None => metrics.count("request", &key, &[("ms", ms)]),
            }
        }
    }
}
