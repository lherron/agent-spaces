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
