//! The four methods raspd answers itself: `aspc.hello`, `health`, `version`
//! and `surface`. Each reproduces Bun aspd's reply byte for byte, from the
//! same release, except `version`, which adds `frontDoor` so a plain proxy
//! cannot pass for raspd.
//!
//! Bun sources: harness/aspc/src/service.ts (`hello`),
//! harness/aspc-facade/src/aspd.ts (release binding, discovery, surface),
//! contracts/aspc-protocol/src/schemas.ts and validation-primitives.ts
//! (`validateHello`).
use crate::json::J;
use crate::protocol::{error_line, result_line};
use crate::release::Release;

pub const NATIVE_METHODS: [&str; 4] = ["aspc.hello", "health", "version", "surface"];

pub fn is_native(method: &str) -> bool {
    NATIVE_METHODS.contains(&method)
}

/// Every method raspd serves natively, the R2 reads and the R3a compile
/// included (`version`).
fn served_natively() -> impl Iterator<Item = &'static str> {
    NATIVE_METHODS
        .into_iter()
        .chain(crate::reads::METHODS)
        .chain([crate::compile::METHOD])
}

pub const ASPC_PROTOCOL_VERSION: &str = "aspc/0.1";
/// `harness/aspc/package.json` version, compiled in from the same tree.
pub const ASPC_FACADE_VERSION: &str = env!("RASPD_ASPC_FACADE_VERSION");
pub const RASPD_SOURCE_COMMIT: &str = env!("RASPD_SOURCE_COMMIT");

/// `ASPD_OP_SUMMARIES`, in `registerAspcCompileMethods` order, then discovery.
const SURFACE: [(&str, &str); 14] = [
    (
        "aspc.hello",
        "Negotiate the compile interface and report the serving release.",
    ),
    (
        "aspc.catalogAgents",
        "List agents visible in an evaluation context.",
    ),
    (
        "aspc.inspectAgent",
        "Inspect an agent with an explicit evaluation context.",
    ),
    (
        "aspc.catalogAgentInspection",
        "List agent inspection selections.",
    ),
    (
        "aspc.inspectAgentSelection",
        "Inspect a selected agent declaration.",
    ),
    (
        "aspc.compileHarnessInvocation",
        "Compile and materialize a harness invocation without starting it.",
    ),
    (
        "aspc.resolveRuntimeDeclaration",
        "Resolve a runtime declaration from its context.",
    ),
    (
        "aspc.inspectRuntimePlacement",
        "Inspect declared runtime placement intent.",
    ),
    (
        "aspc.observeRuntimeCapability",
        "Observe a runtime harness capability.",
    ),
    (
        "aspc.observeContinuationArtifact",
        "Inspect a continuation artifact.",
    ),
    (
        "aspc.prepareProcessInvocation",
        "Prepare process launch inputs without starting a process.",
    ),
    (
        "health",
        "Report process health without checking dependencies.",
    ),
    (
        "version",
        "Report the build, interface version and capabilities.",
    ),
    (
        "surface",
        "List the registered operations and their summaries.",
    ),
];

/// `ASPC_COMPILE_METHODS` object order (version's capabilities).
const COMPILE_METHODS: [&str; 11] = [
    "aspc.hello",
    "aspc.catalogAgents",
    "aspc.inspectAgent",
    "aspc.catalogAgentInspection",
    "aspc.inspectAgentSelection",
    "aspc.compileHarnessInvocation",
    "aspc.resolveRuntimeDeclaration",
    "aspc.inspectRuntimePlacement",
    "aspc.observeRuntimeCapability",
    "aspc.observeContinuationArtifact",
    "aspc.prepareProcessInvocation",
];

/// The service's hello capabilities, every method true (forwarded ones too),
/// with aspd's release binding applied: `cohostedBroker: false` and the unix
/// transport in place of stdio.
const HELLO_CAPABILITIES: [&str; 13] = [
    "catalogAgents",
    "inspectAgent",
    "catalogAgentInspection",
    "inspectAgentSelection",
    "compileHarnessInvocation",
    "resolveRuntimeDeclaration",
    "inspectRuntimePlacement",
    "inspectRuntimePlacementPreparationCorrelation",
    "inspectRuntimePlacementPreparationTaskContext",
    "observeRuntimeCapability",
    "observeContinuationArtifact",
    "prepareProcessInvocation",
    "prepareProcessInvocationTaskContext",
];

pub struct FrontDoor<'a> {
    pub release: &'a Release,
    pub upstream_socket: &'a str,
    /// `unknown`, `healthy` or `unavailable`, as last observed.
    pub upstream_state: &'a str,
}

/// Answer one native request: the reply line (no LF).
pub fn answer(door: &FrontDoor, id: &J, method: &str, params: Option<&J>) -> String {
    match method {
        "aspc.hello" => match validate_hello(params) {
            Ok(()) => result_line(id, &hello(door.release)),
            Err(issues) => error_line(
                id,
                -32602,
                "Invalid params",
                vec![("issues".into(), J::Arr(issues))],
                "invalid_params",
                method,
            ),
        },
        _ => {
            if let Err(message) = require_empty_discovery_params(params) {
                return error_line(id, -32602, &message, vec![], "invalid_params", method);
            }
            let result = match method {
                "health" => health(door),
                "version" => version(door),
                _ => surface(),
            };
            result_line(id, &result)
        }
    }
}

fn identity(release: &Release) -> J {
    J::obj([
        ("releaseId", J::str(&release.release_id)),
        ("sourceCommit", J::str(&release.source_commit)),
        ("builtAt", J::str(&release.built_at)),
    ])
}

fn hello(release: &Release) -> J {
    let mut capabilities: Vec<(String, J)> = HELLO_CAPABILITIES
        .iter()
        .map(|c| ((*c).to_owned(), J::Bool(true)))
        .collect();
    capabilities.push(("cohostedBroker".into(), J::Bool(false)));
    capabilities.push((
        "transports".into(),
        J::Arr(vec![J::str("unix-jsonrpc-ndjson")]),
    ));
    J::obj([
        (
            "facadeInfo",
            J::obj([
                ("name", J::str("aspc-facade")),
                ("version", J::str(ASPC_FACADE_VERSION)),
            ]),
        ),
        ("protocolVersion", J::str(ASPC_PROTOCOL_VERSION)),
        ("capabilities", J::Obj(capabilities)),
        ("release", identity(release)),
    ])
}

/// Bun reports `{ok: true, degraded: []}` without checking dependencies.
/// raspd names the one dependency it has when it last failed to reach it.
fn health(door: &FrontDoor) -> J {
    let degraded = if door.upstream_state == "unavailable" {
        vec![J::str("upstream_unavailable")]
    } else {
        vec![]
    };
    J::obj([("ok", J::Bool(true)), ("degraded", J::Arr(degraded))])
}

fn version(door: &FrontDoor) -> J {
    let mut capabilities: Vec<(String, J)> = ["health", "version", "surface"]
        .iter()
        .map(|c| ((*c).to_owned(), J::Bool(true)))
        .collect();
    capabilities.extend(
        COMPILE_METHODS
            .iter()
            .map(|m| ((*m).to_owned(), J::Bool(true))),
    );
    J::obj([
        ("buildVersion", J::str(&door.release.release_id)),
        ("interfaceVersion", J::str(ASPC_PROTOCOL_VERSION)),
        ("capabilities", J::Obj(capabilities)),
        ("release", identity(door.release)),
        (
            "frontDoor",
            J::obj([
                ("name", J::str("raspd")),
                ("sourceCommit", J::str(RASPD_SOURCE_COMMIT)),
                ("role", J::str("front")),
                ("native", J::Arr(served_natively().map(J::str).collect())),
                ("upstream", J::str(door.upstream_socket)),
                ("upstreamState", J::str(door.upstream_state)),
            ]),
        ),
    ])
}

fn surface() -> J {
    let ops = SURFACE
        .iter()
        .map(|(op, summary)| {
            J::obj([
                ("op", J::str(*op)),
                ("summary", J::str(*summary)),
                ("stream", J::Bool(false)),
            ])
        })
        .collect();
    J::obj([
        ("schemaVersion", J::str("aspd-surface/v1")),
        ("ops", J::Arr(ops)),
    ])
}

/// `requireEmptyDiscoveryParams`.
fn require_empty_discovery_params(params: Option<&J>) -> Result<(), String> {
    let keys: Vec<&str> = match params {
        None => return Ok(()),
        Some(p @ J::Obj(_)) => p.js_entries().into_iter().map(|(k, _)| k).collect(),
        Some(_) => return Err("Params must be an empty object. Call with params: {}.".into()),
    };
    if keys.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unknown params: {}. Call with params: {{}}.",
            keys.join(", ")
        ))
    }
}

fn issue(path: &str, code: &str, message: String) -> J {
    J::obj([
        ("path", J::str(path)),
        ("code", J::str(code)),
        ("message", J::Str(message)),
    ])
}

/// `validateHello(params, 'params', issues)`. Absent and `null` differ: only
/// an absent value is `required`.
fn validate_hello(params: Option<&J>) -> Result<(), Vec<J>> {
    let mut issues = vec![];
    let require_record = |value: Option<&J>, path: &str, issues: &mut Vec<J>| -> bool {
        match value {
            Some(J::Obj(_)) => true,
            _ => {
                let code = if value.is_none() {
                    "required"
                } else {
                    "invalid_type"
                };
                issues.push(issue(path, code, format!("{path} must be an object")));
                false
            }
        }
    };
    if !require_record(params, "params", &mut issues) {
        return Err(issues);
    }
    let request = params.unwrap();
    let client_info = request.get("clientInfo");
    if require_record(client_info, "params.clientInfo", &mut issues) {
        let info = client_info.unwrap();
        let path = "params.clientInfo.name";
        match info.get("name") {
            None => issues.push(issue(path, "required", format!("{path} is required"))),
            Some(J::Str(_)) => {}
            Some(_) => issues.push(issue(
                path,
                "invalid_type",
                format!("{path} must be a string"),
            )),
        }
        let path = "params.clientInfo.version";
        if let Some(v) = info.get("version")
            && !matches!(v, J::Str(_))
        {
            issues.push(issue(
                path,
                "invalid_type",
                format!("{path} must be a string"),
            ));
        }
    }
    let path = "params.protocolVersions";
    let before = issues.len();
    match request.get("protocolVersions") {
        Some(J::Arr(items)) => {
            for (index, item) in items.iter().enumerate() {
                if !matches!(item, J::Str(_)) {
                    let item_path = format!("{path}.{index}");
                    issues.push(issue(
                        &item_path,
                        "invalid_type",
                        format!("{item_path} must be a string"),
                    ));
                }
            }
            if issues.len() == before && !items.contains(&J::str(ASPC_PROTOCOL_VERSION)) {
                issues.push(issue(
                    path,
                    "unsupported_protocol",
                    format!("protocolVersions must include {ASPC_PROTOCOL_VERSION}"),
                ));
            }
        }
        other => {
            let code = if other.is_none() {
                "required"
            } else {
                "invalid_type"
            };
            issues.push(issue(path, code, format!("{path} must be an array")));
        }
    }
    let path = "params.capabilities";
    if let Some(capabilities) = request.get("capabilities")
        && require_record(Some(capabilities), path, &mut issues)
    {
        for (key, value) in capabilities.js_entries() {
            if !matches!(value, J::Bool(_)) {
                let item_path = format!("{path}.{key}");
                issues.push(issue(
                    &item_path,
                    "invalid_type",
                    format!("{item_path} must be a boolean"),
                ));
            }
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}
