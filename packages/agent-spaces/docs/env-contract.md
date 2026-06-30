# Environment Contract

This package-local copy mirrors the repository-level `docs/env-contract.md` so
filtered package tests can validate the same contract from the package cwd.

Agent sessions use canonical `AGENT_*` variables: `AGENT_SCOPE_REF`,
`AGENT_ID`, `AGENT_PROJECT`, `AGENT_TASK`, `AGENT_LANE`,
`AGENT_SESSION_REF`, `AGENT_RUN_ID`, `AGENT_HOST_SESSION_ID`,
`AGENT_PROJECT_ROOT`, and `AGENT_ACTOR`. `AGENT_SCOPE_REF` is durable
identity; `AGENT_SESSION_REF` is that scope plus lane. wrkq caller attribution
is principal-only (T-05381): sessions emit `WRKQ_PRINCIPAL_REF=agent:<id>` as
the canonical wrkq principal; the legacy bare-slug `WRKQ_ACTOR` alias is no
longer read by wrkq. Phase 1 compatibility
aliases include `WRKQ_PRINCIPAL_REF`, `AGENT_LANE_REF`, `ASP_PROJECT_ROOT`,
`ASP_PROJECT`, `AGENTCHAT_ID`, `HRC_SESSION_REF`, `HRC_RUN_ID`, and
`HRC_HOST_SESSION_ID`.

Cross-service producer-owned names include `ACP_BASE_URL`, `ACP_GATEWAY_ID`,
`WRKQ_DB_PATH`, `WRKQD_TOKEN`, `WRKQD_URL`, `WRKQD_ADDR`,
`TASKBOARD_API_HOST`, `TASKBOARD_API_PORT`, `TASKBOARD_WEB_HOST`,
`TASKBOARD_WEB_PORT`, `ASP_PI_PATH`, `ASP_HOME`, `ASP_AGENTS_ROOT`,
`HRC_RUNTIME_DIR`, and `HRC_STATE_DIR`.

Legacy names are migration-only and not final contract names: `CP_URL`,
`ACP_URL`, `CP_GATEWAY_ID`, `ACP_WRKQ_DB_PATH`, `EXPRESS_HOST`,
`EXPRESS_PORT`, `API_HOST`, `API_PORT`, `WEBWRKQ_WEB_HOST`,
`WEBWRKQ_WEB_PORT`, `ASP_ROOT_DIR`, `PI_PATH`, `ACP_STATE_DB`, `CP_HOST`,
`CP_PORT`, `CP_STATE_DIR`, `CP_LOG_DIR`, and `CP_TOKEN`.
