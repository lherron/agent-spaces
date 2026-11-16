//! Service-probe sections (service-probe*.ts): endpoint parsing, the connect
//! probe, an inspection's replayed responses, and the rendered status lines.
use super::sections::{Failure, Res, as_res, bounded};
use super::vars::interpolate;
use super::{Ctx, Pinned};
use crate::compile::util::utf16_len;
use crate::compile::{Fwd, fwd};
use crate::json::J;
use std::time::Duration;

enum Endpoint {
    Unix(String),
    Tcp(String, u16),
}

/// `parseServiceEndpoint` (service-probe.ts): `unix://` or an absolute path,
/// else a WHATWG URL (the url crate) of scheme tcp, http(s) or ws(s), to
/// `url.hostname` (an IPv6 host keeps its brackets, as in JS) and `url.port`
/// or the scheme's default. `None`: the section fails.
fn parse_endpoint(endpoint: &str) -> Option<Endpoint> {
    if let Some(p) = endpoint.strip_prefix("unix://") {
        return Some(Endpoint::Unix(p.to_owned()));
    }
    if endpoint.starts_with('/') {
        return Some(Endpoint::Unix(endpoint.to_owned()));
    }
    let url = url::Url::parse(endpoint).ok()?;
    if !["tcp", "http", "https", "ws", "wss"].contains(&url.scheme()) {
        return None;
    }
    let secure = matches!(url.scheme(), "https" | "wss");
    let port = url.port().unwrap_or(if secure { 443 } else { 80 });
    Some(Endpoint::Tcp(
        url.host_str().unwrap_or_default().to_owned(),
        port,
    ))
}

/// `probeServiceEndpoint(endpoint, timeoutMs)`: up when a connection is made
/// before the timer fires. Node's connect never blocks the caller and its timer
/// covers DNS too, so the attempt runs on its own thread and the timer decides.
fn probe(endpoint: &Endpoint, timeout_ms: f64) -> bool {
    let timeout = Duration::from_millis(timeout_ms.max(0.0) as u64);
    let (tx, rx) = std::sync::mpsc::channel();
    let target = match endpoint {
        Endpoint::Unix(path) => Endpoint::Unix(path.clone()),
        Endpoint::Tcp(host, port) => Endpoint::Tcp(host.clone(), *port),
    };
    std::thread::spawn(move || {
        let up = match &target {
            Endpoint::Unix(path) => std::os::unix::net::UnixStream::connect(path).is_ok(),
            Endpoint::Tcp(host, port) => {
                // An IPv6 host keeps its brackets ("[::1]") on purpose: Bun
                // passes url.hostname to net.connect, whose lookup of "[::1]"
                // fails ENOTFOUND, so Bun reports a bracketed IPv6 endpoint
                // down even with a listener. raspd matches it (mable ruling,
                // T-13048 EN-49455); stripping them would be a product change.
                use std::net::ToSocketAddrs;
                (host.as_str(), *port)
                    .to_socket_addrs()
                    .map(|mut addrs| addrs.any(|a| std::net::TcpStream::connect(a).is_ok()))
                    .unwrap_or(false)
            }
        };
        let _ = tx.send(up);
    });
    rx.recv_timeout(timeout).unwrap_or(false)
}

/// An inspection's recorded answer for each service, each response consumed
/// once; a service without an unconsumed matching response refuses.
fn replayed(pinned: &Pinned, specs: &[(String, String)]) -> Result<Vec<bool>, Fwd> {
    let responses = pinned.probe_responses()?;
    let mut used = pinned.used.borrow_mut();
    let mut ups = vec![];
    for (name, endpoint) in specs {
        let record = responses.iter().enumerate().find(|(n, r)| {
            !used.contains(n)
                && r.get("name").and_then(J::as_str) == Some(name)
                && r.get("endpoint").and_then(J::as_str) == Some(endpoint)
        });
        let Some((n, r)) = record else {
            return Err(fwd(crate::reason!("prompt_section_failed")));
        };
        used.push(n);
        ups.push(r.get("up") == Some(&J::Bool(true)));
    }
    Ok(ups)
}

/// A service-probe section: one status line per service under the optional
/// header, from a live probe or an inspection's replay.
pub(super) fn resolve_probe(
    services: &[(String, String)],
    header: Option<&str>,
    timeout: Option<f64>,
    ctx: &Ctx,
) -> Result<Res, Fwd> {
    if services.is_empty() {
        return Ok(Res::Empty);
    }
    let mut specs = vec![];
    for (name, endpoint) in services {
        specs.push((name.clone(), interpolate(endpoint, ctx)?));
    }
    let replay = ctx
        .pinned
        .as_ref()
        .map(|p| replayed(p, &specs))
        .transpose()?;
    let mut parsed = vec![];
    for (name, endpoint) in specs.iter().filter(|_| replay.is_none()) {
        match parse_endpoint(endpoint) {
            Some(e) => parsed.push(e),
            // resolveServiceProbeSection throws; resolveSection words it.
            None => {
                let names = services.iter().map(|(n, _)| J::str(n)).collect();
                return Ok(Res::Failed(Some(Failure {
                    source: J::obj([
                        ("kind", J::str("service-probe")),
                        ("services", J::Arr(names)),
                    ]),
                    reason: bounded(format!(
                        "Service probe execution failed: Unsupported service probe endpoint for {name}: {endpoint}"
                    )),
                })));
            }
        }
    }
    let timeout = timeout.unwrap_or(250.0);
    let ups: Vec<bool> = replay.unwrap_or_else(|| {
        std::thread::scope(|s| {
            let handles: Vec<_> = parsed
                .iter()
                .map(|e| s.spawn(move || probe(e, timeout)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or(false))
                .collect()
        })
    });
    let width = specs.iter().map(|(n, _)| utf16_len(n)).max().unwrap_or(0);
    let mut lines = vec![];
    if let Some(h) = header.filter(|h| !h.is_empty()) {
        lines.push(interpolate(h, ctx)?);
    }
    for ((name, endpoint), up) in specs.iter().zip(ups) {
        let pad = " ".repeat(width - utf16_len(name));
        let display = endpoint.strip_prefix("unix://").unwrap_or(endpoint);
        lines.push(format!(
            "  {} {name}{pad}  {display}",
            if up { "✅" } else { "❌" }
        ));
    }
    Ok(as_res(Some(lines.join("\n"))))
}
