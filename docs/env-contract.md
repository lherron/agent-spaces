# Environment Contract

This document defines the variables that may cross a process or repository
boundary. Service-internal configuration remains owned by each service and may
keep service-specific prefixes.

## Service-Internal Variables

Ports, database paths, timeouts, queue tuning, and feature flags read only by one
service are out of scope for this contract. Examples include `ACP_JOB_FLOW_EXEC_*`,
`ACP_INPUT_QUEUE_*`, `HRC_STALE_GENERATION_*`, `WRKQ_SEARCH_*`, and
`TASKBOARD_*` variables that are written and read by the same service.

## Agent-Session Contract

The [agent-session environment reference](identity-scope-and-env-contract.md#agent-session-environment-contract)
lists the current writer for each managed and unmanaged launch variable. HRC
derives managed identity and adds runtime plumbing. Unmanaged `asp agent` uses
`buildAgentSessionEnv`. ASP compilation supplies the locked project and
materialization environment on both paths.

Use `AGENT_SCOPE_REF` for durable identity and `AGENT_SESSION_REF` for
lane-aware routing or correlation. Managed wrkq sessions derive the principal
from `AGENT_SCOPE_REF`. The unmanaged builder supplies `WRKQ_PRINCIPAL_REF`
when an actor is available. `ASP_PROJECT` remains a project-discovery input
and can be present without `AGENT_PROJECT`.

## Cross-Service Contract

Consumer code uses the producer-owned name rather than re-prefixing it.

| Variable | Owner/producer | Writer | Readers | Format | Phase | Legacy fallback or status |
| --- | --- | --- | --- | --- | --- | --- |
| `ACP_BASE_URL` | ACP | ACP service config | CLIs, gateways, tools | URL | Phase 1 | replaces `CP_URL`, `ACP_URL` |
| `ACP_GATEWAY_ID` | ACP | ACP service config | gateways | slug | Phase 1 | replaces `CP_GATEWAY_ID` |
| `WRKQ_DB_PATH` | wrkq | wrkq config | ACP, tools | absolute path | Phase 1 | replaces `ACP_WRKQ_DB_PATH` |
| `WRKQD_TOKEN` | wrkq daemon | wrkqd config | taskboard, tools | token | current | canonical |
| `WRKQD_URL` | wrkq/taskboard client contract | service config | taskboard | URL | owner decision | keep distinct from `WRKQD_ADDR` |
| `WRKQD_ADDR` | wrkq daemon | wrkqd config | daemon/status tooling | bind/listen address | owner decision | do not overload as client URL |
| `TASKBOARD_API_HOST` | taskboard | taskboard config | taskboard API | host | Phase 1 | replaces `EXPRESS_HOST`, `API_HOST` |
| `TASKBOARD_API_PORT` | taskboard | taskboard config | taskboard API | port | Phase 1 | replaces `EXPRESS_PORT`, `API_PORT` |
| `TASKBOARD_WEB_HOST` | taskboard | taskboard config | taskboard web | host | Phase 1 | replaces `WEBWRKQ_WEB_HOST` |
| `TASKBOARD_WEB_PORT` | taskboard | taskboard config | taskboard web | port | Phase 1 | replaces `WEBWRKQ_WEB_PORT` |
| `ASP_PI_PATH` | agent-spaces | local config | Pi harness | absolute path | Phase 1 | replaces `PI_PATH` |
| `ASP_HOME` | agent-spaces | local config | ASP/HRC tools | absolute path | current | replaces `ASP_ROOT_DIR` |
| `ASP_AGENTS_ROOT` | agent-spaces | local config | ASP/HRC tools | absolute path | current | canonical |
| `ASP_PROJECT` | ASP / HRC | ASP locked env with a project root, HRC dispatch otherwise when scope has a project | wrkq, HRC CLI | project discovery id | current | see the agent-session environment reference above |
| `HRC_RUNTIME_DIR` | HRC | hrc config | ASP/ACP integrations | absolute path | current | canonical |
| `HRC_STATE_DIR` | HRC | hrc config | ASP/ACP integrations | absolute path | current | canonical |
| `ACP_STATE_DB_PATH` | ACP | ACP scripts/config | ACP tooling | absolute path | Phase 1 | replaces `ACP_STATE_DB` |

Legacy kill-list names are not allowed final contract names: `CP_URL`,
`ACP_URL`, `CP_GATEWAY_ID`, `ACP_WRKQ_DB_PATH`, `EXPRESS_HOST`,
`EXPRESS_PORT`, `API_HOST`, `API_PORT`, `WEBWRKQ_WEB_HOST`,
`WEBWRKQ_WEB_PORT`, `PI_PATH`, `ASP_ROOT_DIR`, `ACP_STATE_DB`, `CP_HOST`,
`CP_PORT`, `CP_STATE_DIR`, `CP_LOG_DIR`, and `CP_TOKEN`.
