//! Native runtime inspection, the three ops of compiler/agent-spaces/src
//! agent-inspection.ts, reproduced byte for byte:
//! - `aspc.inspectRuntimePlacement` (`inspectRuntimePlacement`): a placement
//!   resolved to its declaration, prepared, then inspected (placement.rs);
//! - `aspc.inspectAgent` (`inspectAgentForContext`): a caller-supplied
//!   evaluation context inspected as given (caller_context.rs);
//! - `aspc.catalogAgents`: the agents root's profiles (caller_input.rs).
//!
//! Bun's inspection is not read-only: for a claude or codex effective harness
//! it runs the canonical compile, which materializes the bundle under ASP_HOME
//! (codex runtime home excepted). raspd does the same through its native
//! compile (evaluate.rs), so it writes exactly what Bun writes, under the same
//! lock protocol. Unsupported inputs follow the same disposition rows as
//! placement inspection.
mod caller_context;
mod caller_input;
mod evaluate;
mod parts;
mod placement;
mod preparation;

use super::prompt::zones;
use super::{Compiled, Phases, invalid_params};
use crate::json::J;
use crate::reads::{Answer, INSPECT_REQUEST_VERSION};
use crate::release::Release;

pub const METHOD: &str = "aspc.inspectRuntimePlacement";
pub const AGENT_METHOD: &str = "aspc.inspectAgent";
pub const CATALOG_METHOD: &str = "aspc.catalogAgents";

const RESPONSE_VERSION: &str = "aspc-inspect-runtime-placement-response/v1";
const DECLARATION_RESPONSE_VERSION: &str = "aspc-resolve-runtime-declaration-response/v1";

/// One system prompt report: the resolved zones, their inspection and
/// whether the template appends. `None` when the agent declares no prompt.
type PromptReport = Option<(zones::Resolved, zones::Inspected, bool)>;

/// `aspc.inspectRuntimePlacement`: the request shape, then its schema
/// version, then the inspection.
pub fn handle(params: Option<&J>, release: &Release) -> Compiled {
    let mut phases = Phases::start();
    let valid = crate::reads::valid_inspect(params);
    let Some(params) =
        params.filter(|_| crate::reads::handled(valid, params, INSPECT_REQUEST_VERSION))
    else {
        return Compiled::unstaged(Answer::Forward(invalid_params().reason));
    };
    if params.get("schemaVersion") != Some(&J::str(INSPECT_REQUEST_VERSION)) {
        return Compiled::unstaged(Answer::Result(failure_reply(
            "incompatible",
            "unsupported_schema",
            "Unsupported runtime placement inspection schema",
        )));
    }
    let result = placement::inspect(params, release, &mut phases);
    Compiled::from_result(result, phases)
}

/// `aspc.inspectAgent` and `aspc.catalogAgents`: the caller-supplied input
/// is validated whole before either reads anything.
pub fn handle_agent(method: &str, params: Option<&J>, release: &Release) -> Compiled {
    let mut phases = Phases::start();
    let inspect = method == AGENT_METHOD;
    let result = (|| {
        if !caller_input::valid(params, inspect) {
            return Err(invalid_params());
        }
        let p = params.ok_or_else(invalid_params)?;
        let context = p.get("evaluationContext").ok_or_else(invalid_params)?;
        if inspect {
            let request = p.get("request").ok_or_else(invalid_params)?;
            caller_context::inspect_agent(request, context, release, &mut phases)
        } else {
            caller_input::catalog(context)
        }
    })();
    Compiled::from_result(result, phases)
}

/// `{ ok: false, declaration: { ok: false, failure } }`: a placement
/// inspection refused with a declaration-shaped failure.
fn failure_reply(kind: &str, code: &str, message: &str) -> J {
    J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(false)),
        (
            "declaration",
            J::obj([
                ("schemaVersion", J::str(DECLARATION_RESPONSE_VERSION)),
                ("ok", J::Bool(false)),
                (
                    "failure",
                    J::obj([
                        ("kind", J::str(kind)),
                        ("code", J::str(code)),
                        ("message", J::str(message)),
                    ]),
                ),
            ]),
        ),
    ])
}
