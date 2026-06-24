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

Owner/producer: agent-spaces placement/materialization.
Writer: the canonical agent-session env builder in `packages/agent-spaces`.
Readers: agent processes, HRC launch paths, hrcchat, hooks, wrkq/wrkf tooling.
Format: strings; IDs are bare slugs unless noted.
Phase: Phase 1 writes canonical names plus compatibility aliases.

| Variable | Format | Legacy fallback |
| --- | --- | --- |
| `AGENT_SCOPE_REF` | Canonical durable scope identity, for example `agent:cody:project:agent-spaces:task:T-04218` | `ASP_SCOPE_REF` / handle-derived identity during migration |
| `AGENT_ID` | Bare agent id, for example `cody` | `AGENTCHAT_ID` during migration |
| `AGENT_PROJECT` | Project id, for example `agent-spaces` | `ASP_PROJECT` during migration |
| `AGENT_TASK` | Task id when task scoped, for example `T-04218` | none |
| `AGENT_LANE` | Bare lane id, default `main` | `AGENT_LANE_REF` during migration |
| `AGENT_SESSION_REF` | Lane-aware session identity, `<scopeRef>/lane:<lane>` | `HRC_SESSION_REF` during migration |
| `AGENT_RUN_ID` | Per-launch run id | `HRC_RUN_ID` during migration |
| `AGENT_HOST_SESSION_ID` | Host session id | `HRC_HOST_SESSION_ID` during migration |
| `AGENT_PROJECT_ROOT` | Absolute project root path | `ASP_PROJECT_ROOT` during migration |
| `AGENT_ACTOR` | Bare actor slug for task writes | `WRKQ_ACTOR` during migration |

`AGENT_SCOPE_REF` and `AGENT_SESSION_REF` are both canonical and name different
concepts. Use `AGENT_SCOPE_REF` for durable identity and ownership logic. Use
`AGENT_SESSION_REF` only when lane-aware session routing or correlation matters.

Compatibility aliases written in Phase 1 are `WRKQ_ACTOR`, `AGENT_LANE_REF`,
`ASP_PROJECT_ROOT`, `ASP_PROJECT`, `AGENTCHAT_ID`, `HRC_SESSION_REF`,
`HRC_RUN_ID`, and `HRC_HOST_SESSION_ID`. They are not final contract names.

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
| `ASP_PROJECT` | agent-spaces | materializer | legacy tools | project id | migration only | replaced by `AGENT_PROJECT` for agent sessions |
| `HRC_RUNTIME_DIR` | HRC | hrc config | ASP/ACP integrations | absolute path | current | canonical |
| `HRC_STATE_DIR` | HRC | hrc config | ASP/ACP integrations | absolute path | current | canonical |
| `ACP_STATE_DB_PATH` | ACP | ACP scripts/config | ACP tooling | absolute path | Phase 1 | replaces `ACP_STATE_DB` |

Legacy kill-list names are not allowed final contract names: `CP_URL`,
`ACP_URL`, `CP_GATEWAY_ID`, `ACP_WRKQ_DB_PATH`, `EXPRESS_HOST`,
`EXPRESS_PORT`, `API_HOST`, `API_PORT`, `WEBWRKQ_WEB_HOST`,
`WEBWRKQ_WEB_PORT`, `PI_PATH`, `ASP_ROOT_DIR`, `ACP_STATE_DB`, `CP_HOST`,
`CP_PORT`, `CP_STATE_DIR`, `CP_LOG_DIR`, and `CP_TOKEN`.
