//! What a forward becomes (T-13018 r2 section 1): the one place that decides.
//!
//! Every site that cannot answer an input natively returns a `Fwd` naming a
//! [`Reason`]. A reason exists only as a row of `crates/raspd/dispositions.json`
//! (generated once from the T-13008 forward inventory and the r2 overrides):
//! `reason!("x")` checks the row at compile time, so a forward reason with no
//! row fails the build. With an upstream (fronted mode) a forward is relayed to
//! Bun, as before. Without one (sole mode) [`answer`] replies from the row:
//!
//! - `refuse`: Bun's envelope and code for that input (message text is not
//!   Bun's);
//! - `impossible`: JSON-RPC -32603, logged as a raspd defect;
//! - `native` with `slice: 3`: a reason a later slice answers natively;
//!   until then it refuses with the row's placeholder reply.
//!
//! Rows marked `bothModes` (a panic, an invalid global lock) are answered from
//! the row in fronted mode too.
//!
//! Making a row native means answering at the forward site instead of
//! returning its `Fwd`, then deleting the row (the build then refuses any
//! leftover `reason!` of it). Slice 2 (T-13048) did that for its rows; a row
//! that kept a refusing part stays, as `refuse`, for that part.
use crate::json::J;
use crate::protocol::error_line;
use std::collections::HashMap;
use std::sync::OnceLock;

include!(concat!(env!("OUT_DIR"), "/reasons.rs"));

const TABLE: &str = include_str!("../dispositions.json");

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Whether `name` has a row (for `reason!`'s compile-time check).
pub const fn known(name: &str) -> bool {
    let mut i = 0;
    while i < REASONS.len() {
        if same(REASONS[i], name) {
            return true;
        }
        i += 1;
    }
    false
}

/// Where a reader's refusal was raised, when Bun's code depends on it (the
/// row's `contexts`): a TOML reader's file, the targets read, a lock wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Context {
    /// agent-profile.toml.
    Profile,
    /// bundle.projectRoot's asp-targets.toml (resolve and its readers).
    Targets,
    /// placement.projectRoot's asp-targets.toml, read for the codex options.
    PlacementTargets,
    /// The project-targets read of the agent-root search path.
    SearchTargets,
    /// A source read (profile or targets) of the declaration.
    ReadSource,
    /// The profile's priming file.
    Priming,
    /// A lock still held by another process after the one wait.
    Held,
    /// A placement path that is not absolute.
    RelativePath,
}

impl Context {
    pub fn as_str(self) -> &'static str {
        match self {
            Context::Profile => "profile",
            Context::Targets => "targets",
            Context::PlacementTargets => "placement_targets",
            Context::SearchTargets => "search_targets",
            Context::ReadSource => "read_source",
            Context::Priming => "priming",
            Context::Held => "held",
            Context::RelativePath => "relative_path",
        }
    }
    #[cfg(test)]
    const ALL: [Context; 8] = [
        Context::Profile,
        Context::Targets,
        Context::PlacementTargets,
        Context::SearchTargets,
        Context::ReadSource,
        Context::Priming,
        Context::Held,
        Context::RelativePath,
    ];
}

/// A forward reason: a row of the table, and where it was raised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reason {
    name: &'static str,
    context: Option<Context>,
}

impl Reason {
    /// Only through `reason!`, which checks the row at compile time.
    #[doc(hidden)]
    pub const fn checked(name: &'static str) -> Reason {
        Reason {
            name,
            context: None,
        }
    }
    pub fn as_str(self) -> &'static str {
        self.name
    }
    pub fn context(self) -> Option<Context> {
        self.context
    }
    /// Name where it was raised; an outer caller that knows better (the
    /// placement-root targets read) names it again.
    pub fn within(self, context: Context) -> Reason {
        Reason {
            context: Some(context),
            ..self
        }
    }
}

/// Why a request was not answered natively, and, when one decides it, the
/// key or value that did (logged as `fallbackDetail`, never sent to Bun).
#[derive(Debug)]
pub struct Fwd {
    pub reason: Reason,
    pub detail: Option<String>,
}

// -- the table -----------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// A JSON-RPC error: code and `data.reason`.
    Rpc(i64, String),
    /// A compile result with `diagnostics[0].code`.
    Diagnostic(String),
    /// `failure {kind, code}` (an inspection carries it in its declaration).
    Failure(String, String),
    /// `resolution {state, code}` (likewise).
    Resolution(String, String),
}

#[derive(Debug)]
pub struct Row {
    pub disposition: String,
    /// The slice that makes a `native` row native (the table test reads it).
    #[cfg_attr(not(test), allow(dead_code))]
    pub slice: Option<u64>,
    pub both_modes: bool,
    /// The ops its forward sites serve (the table test reads it).
    #[cfg_attr(not(test), allow(dead_code))]
    pub ops: Vec<String>,
    pub condition: String,
    replies: HashMap<String, Reply>,
    contexts: HashMap<String, HashMap<String, Reply>>,
}

impl Row {
    /// The reply for `op` raised in `context`: the context's, else the row's,
    /// else the row's `*`.
    pub fn reply(&self, op: &str, context: Option<Context>) -> Option<&Reply> {
        context
            .and_then(|c| self.contexts.get(c.as_str()))
            .and_then(|r| r.get(op).or_else(|| r.get("*")))
            .or_else(|| self.replies.get(op))
            .or_else(|| self.replies.get("*"))
    }
}

fn parse_reply(v: &serde_json::Value) -> Result<Reply, String> {
    let pair = |v: &serde_json::Value| -> Option<(String, String)> {
        Some((v[0].as_str()?.to_owned(), v[1].as_str()?.to_owned()))
    };
    if let Some(r) = v.get("rpc") {
        return Ok(Reply::Rpc(
            r[0].as_i64().ok_or("rpc code")?,
            r[1].as_str().ok_or("rpc reason")?.to_owned(),
        ));
    }
    if let Some(code) = v.get("diagnostic").and_then(|d| d.as_str()) {
        return Ok(Reply::Diagnostic(code.to_owned()));
    }
    if let Some((kind, code)) = v.get("failure").and_then(pair) {
        return Ok(Reply::Failure(kind, code));
    }
    if let Some((state, code)) = v.get("resolution").and_then(pair) {
        return Ok(Reply::Resolution(state, code));
    }
    Err(format!("unknown reply {v}"))
}

fn parse_replies(v: &serde_json::Value) -> Result<HashMap<String, Reply>, String> {
    let mut out = HashMap::new();
    for (op, reply) in v.as_object().ok_or("replies must be an object")? {
        out.insert(op.clone(), parse_reply(reply)?);
    }
    Ok(out)
}

fn parse_table(text: &str) -> Result<HashMap<String, Row>, String> {
    let table: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut rows = HashMap::new();
    for row in table["rows"].as_array().ok_or("rows")? {
        let reason = row["reason"].as_str().ok_or("reason")?.to_owned();
        let mut contexts = HashMap::new();
        if let Some(c) = row.get("contexts").and_then(|c| c.as_object()) {
            for (name, replies) in c {
                contexts.insert(name.clone(), parse_replies(replies)?);
            }
        }
        let parsed = Row {
            disposition: row["disposition"].as_str().ok_or("disposition")?.to_owned(),
            slice: row.get("slice").and_then(|s| s.as_u64()),
            both_modes: row.get("bothModes").and_then(|b| b.as_bool()) == Some(true),
            ops: row["ops"]
                .as_array()
                .map(|o| {
                    o.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            condition: row["condition"].as_str().unwrap_or_default().to_owned(),
            replies: parse_replies(&row["replies"]).map_err(|e| format!("{reason}: {e}"))?,
            contexts,
        };
        rows.insert(reason, parsed);
    }
    Ok(rows)
}

pub fn table() -> &'static HashMap<String, Row> {
    static ROWS: OnceLock<HashMap<String, Row>> = OnceLock::new();
    // A malformed table fails `cargo test` (tests::the_table_parses); at
    // runtime an unparsable one leaves every lookup to the -32603 fallback.
    ROWS.get_or_init(|| parse_table(TABLE).unwrap_or_default())
}

// -- answering -----------------------------------------------------------------------

const COMPILE_RESPONSE: &str = "aspc-compile-harness-invocation-response/v2";
const INSPECT_RESPONSE: &str = "aspc-inspect-runtime-placement-response/v1";
const DECLARATION_RESPONSE: &str = "aspc-resolve-runtime-declaration-response/v1";

/// What raspd does with a forward.
pub enum Decision {
    /// Relay the request to Bun unchanged (fronted mode).
    Relay,
    /// Answer with this reply line (no LF); `defect` when it is a raspd bug.
    Answer { line: String, defect: bool },
}

/// Decide a forward of `method` for `reason`, in sole mode (`sole`) or
/// fronted mode.
pub fn decide(sole: bool, id: &J, method: &str, reason: Reason, detail: Option<&str>) -> Decision {
    let Some(row) = table().get(reason.as_str()) else {
        // `reason!` makes this unreachable; never relay on it either way.
        return Decision::Answer {
            line: internal(id, method, reason.as_str()),
            defect: true,
        };
    };
    if !sole && !row.both_modes {
        return Decision::Relay;
    }
    let defect = row.disposition == "impossible";
    let message = match detail {
        Some(d) if !d.is_empty() => format!("{} ({d})", row.condition),
        _ => row.condition.clone(),
    };
    let message = format!("raspd refused: {message} [{}]", reason.as_str());
    let line = match row.reply(method, reason.context()) {
        Some(reply) => render(id, method, reply, &message),
        None => internal(id, method, reason.as_str()),
    };
    Decision::Answer { line, defect }
}

fn internal(id: &J, method: &str, reason: &str) -> String {
    error_line(
        id,
        -32603,
        &format!("raspd internal error: no disposition for {reason} on {method}"),
        vec![],
        "internal_error",
        method,
    )
}

fn result(id: &J, result: J) -> String {
    crate::protocol::result_line(id, &result)
}

/// The reply line for `reply` to `method`, or -32603 where the row names a
/// shape that op does not answer with.
pub fn render(id: &J, method: &str, reply: &Reply, message: &str) -> String {
    let failure = |kind: &str, code: &str| {
        J::obj([
            ("kind", J::str(kind)),
            ("code", J::str(code)),
            ("message", J::str(message)),
        ])
    };
    let resolution = |state: &str, code: &str| {
        J::obj([
            ("state", J::str(state)),
            ("code", J::str(code)),
            ("message", J::str(message)),
        ])
    };
    let declaration = |key: &str, body: J| {
        J::obj([
            ("schemaVersion", J::str(DECLARATION_RESPONSE)),
            ("ok", J::Bool(false)),
            (key, body),
        ])
    };
    match (reply, method) {
        (Reply::Rpc(code, reason), _) => {
            let text = match *code {
                -32601 => format!("Method not found: {method}"),
                -32602 => format!("Invalid params: {message}"),
                -32700 => "Parse error".to_owned(),
                _ => message.to_owned(),
            };
            error_line(id, *code, &text, vec![], reason, method)
        }
        (Reply::Diagnostic(code), "aspc.compileHarnessInvocation") => result(
            id,
            J::obj([
                ("schemaVersion", J::str(COMPILE_RESPONSE)),
                ("ok", J::Bool(false)),
                (
                    "diagnostics",
                    J::Arr(vec![J::obj([
                        ("level", J::str("error")),
                        ("code", J::str(code)),
                        ("message", J::str(message)),
                        ("plane", J::str("asp-compiler")),
                    ])]),
                ),
            ]),
        ),
        (Reply::Failure(kind, code), "aspc.resolveRuntimeDeclaration") => {
            result(id, declaration("failure", failure(kind, code)))
        }
        (Reply::Resolution(state, code), "aspc.resolveRuntimeDeclaration") => {
            result(id, declaration("resolution", resolution(state, code)))
        }
        (Reply::Failure(kind, code), "aspc.inspectRuntimePlacement") => result(
            id,
            J::obj([
                ("schemaVersion", J::str(INSPECT_RESPONSE)),
                ("ok", J::Bool(false)),
                ("declaration", declaration("failure", failure(kind, code))),
            ]),
        ),
        (Reply::Resolution(state, code), "aspc.inspectRuntimePlacement") => result(
            id,
            J::obj([
                ("schemaVersion", J::str(INSPECT_RESPONSE)),
                ("ok", J::Bool(false)),
                (
                    "declaration",
                    declaration("resolution", resolution(state, code)),
                ),
            ]),
        ),
        _ => internal(id, method, "a reply shape this op does not use"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_and_every_reason_has_a_row() {
        let rows = parse_table(TABLE).expect("dispositions.json parses");
        for name in REASONS {
            assert!(rows.contains_key(*name), "{name}");
        }
        assert_eq!(rows.len(), REASONS.len());
    }

    #[test]
    fn every_row_answers_each_of_its_ops_with_a_shape_that_op_uses() {
        let rows = parse_table(TABLE).unwrap();
        let contexts: Vec<Option<Context>> = std::iter::once(None)
            .chain(Context::ALL.into_iter().map(Some))
            .collect();
        for (reason, row) in &rows {
            assert!(
                ["refuse", "impossible", "native"].contains(&row.disposition.as_str()),
                "{reason}: {}",
                row.disposition
            );
            assert_eq!(
                row.disposition == "native",
                row.slice.is_some(),
                "{reason}: a native row names the slice that makes it native"
            );
            for name in row.contexts.keys() {
                assert!(
                    Context::ALL.iter().any(|c| c.as_str() == name),
                    "{reason}: unknown context {name}"
                );
            }
            for op in &row.ops {
                for context in &contexts {
                    let reply = row.reply(op, *context).unwrap_or_else(|| {
                        panic!("{reason}: no reply for {op}");
                    });
                    let line = render(&J::Num(1.0), op, reply, "m");
                    assert!(
                        !line.contains("a reply shape this op does not use"),
                        "{reason} {op} {context:?}: {reply:?}"
                    );
                }
            }
        }
    }
}
