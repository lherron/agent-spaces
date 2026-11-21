# Agent-Authored Runtime Resources Fixtures

These fixtures define the Phase A wire contract for `asp resources plan`.

The canonical plan envelope is:

- `schema`: `agent-authored-runtime-resources.plan/v1`
- `sourceOwnerScopeRef`: the owning agent scope
- `managedBy`: `agent-directory`
- `compiler`: the ASP resources compiler identity
- `resources`: `ManagedResourceProjection` records from the proposal's provenance contract

Each resource projection includes the canonical ACP desired projection in `desiredJson`.
`sourceHash` is computed from parsed TOML, not raw bytes. `desiredProjectionHash` is
computed from `desiredJson`. Both use `createCanonicalHasher()` with
`timestampMode: "omit-ephemeral"`.

The fixture root is `agents/smokey`, representing source owner
`agent:smokey:project:agent-spaces`.

The plan carries channels (`interface-binding`) and event hooks (`event-hook`).
Schedules are not runtime resources: praesidium-kernel's schedule module reads and
validates each agent's `schedules/*.toml` itself. The directory walk skips
`schedules/`, and an `--include` of a file under `schedules/`, or of any file
whose `[trigger]` or `[schedule]` table classifies it as a schedule, is refused
with `SCHEDULE_MODULE_OWNED`.

`variants/` and `invalid/` hold single-file inputs compiled with `--include`;
`variants/discord-smoke-comments.toml` reorders and comments
`agents/smokey/channels/discord-smoke.toml` and must hash to the same `sourceHash`.
