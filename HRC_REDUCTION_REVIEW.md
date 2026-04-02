# HRC Reduction Review

## Summary
9 reductions identified, estimated ~820 lines removable.

## Reductions (ranked by impact)

### R-1: Collapse repeated SQL column lists in the store layer
- **Packages:** `hrc-store-sqlite`
- **Current:** `packages/hrc-store-sqlite/src/repositories.ts:597-609`, `680-692`, `706-718`, `768-782`, `790-804`, `813-827`, `1010-1031`, `1045-1066`, `1085-1106`, `1300-1313`, `1328-1341`, `1513-1533`, `1701-1720`, `1735-1754`, `1770-1789` repeat the same `SELECT` column lists for `SessionRow`, `AppSessionRow`, `RuntimeRow`, `RunRow`, and `LaunchRow`.
- **Proposed:** Extract one constant per row shape, for example `RUNTIME_COLUMNS`, `LAUNCH_COLUMNS`, `RUN_COLUMNS`, `SESSION_COLUMNS`, `APP_SESSION_COLUMNS`, and interpolate them into each query site.
- **Lines saved:** 180
- **Risk:** low. Private SQL string deduplication only.
- **Dependencies:** none.

### R-2: Delete `hrc-bridge-agentchat` as a standalone package
- **Packages:** `hrc-bridge-agentchat`, `hrc-sdk`, `hrc-cli`
- **Current:** `packages/hrc-bridge-agentchat/src/index.ts:35-133` is a second bridge client with its own HTTP transport and typed-error handling. The same bridge endpoints already exist on `packages/hrc-sdk/src/client.ts:178-192`, and in-repo bridge consumers already use the SDK path in `packages/hrc-cli/src/cli.ts:544-594`. No production import of `hrc-bridge-agentchat` exists in the repo.
- **Proposed:** Remove the package and route any remaining bridge interactions through `HrcClient`. If the object wrapper is still useful, keep a tiny helper local to tests instead of a published package.
- **Lines saved:** 130
- **Risk:** medium. The package itself is a public API today even though the repo does not consume it.
- **Dependencies:** yes. External consumers would need to switch import paths or use `HrcClient`.

### R-3: Deduplicate the server and SDK wire DTOs
- **Packages:** `hrc-server`, `hrc-sdk`, `hrc-core`
- **Current:** `packages/hrc-server/src/index.ts:50-205` redefines the same request/response shapes already declared in `packages/hrc-sdk/src/types.ts:12-227` for session resolution, runtime ensure, turn dispatch, clear-context, attach, bridges, and runtime actions.
- **Proposed:** Move the HTTP DTOs to one shared module, most naturally alongside the core contracts, and import them from both `hrc-server` and `hrc-sdk`.
- **Lines saved:** 80
- **Risk:** medium. Pure type movement, but it changes where public types are imported from unless the old re-exports are preserved.
- **Dependencies:** yes. Consumer type imports may need re-exports or path updates.

### R-4: Collapse `hrc-adapter-agent-spaces` into the server runtime layer
- **Packages:** `hrc-adapter-agent-spaces`, `hrc-server`
- **Current:** `packages/hrc-server/src/index.ts:7-12` is the only production consumer of the package. The package surface is broader than that one caller: `packages/hrc-adapter-agent-spaces/src/index.ts:4-22` re-exports test-oriented option/result types from `packages/hrc-adapter-agent-spaces/src/cli-adapter/index.ts:41-224` and `packages/hrc-adapter-agent-spaces/src/sdk-adapter/index.ts:20-330`.
- **Proposed:** Move the CLI and SDK adapter modules under `hrc-server` as internal files and drop the separate package boundary and public export-only types that exist only because this code is currently published.
- **Lines saved:** 60
- **Risk:** medium. The repo-level call graph supports the collapse, but it removes a published package.
- **Dependencies:** yes. Any external import of `hrc-adapter-agent-spaces` would break.

### R-5: Extract the duplicated HRC test harness fixture once
- **Packages:** `hrc-server`, `hrc-bridge-agentchat`
- **Current:** `packages/hrc-server/src/__tests__/server-bridges.test.ts:51-139`, `packages/hrc-server/src/__tests__/server-inflight.test.ts:42-66`, `136-171`, `packages/hrc-server/src/__tests__/server-reconciliation.test.ts:26-47`, `114-139`, and `packages/hrc-bridge-agentchat/src/__tests__/bridge.test.ts:48-130` each rebuild the same temp-dir bootstrap, socket fetch, POST helper, server options, and runtime setup scaffolding.
- **Proposed:** Create one shared test fixture/helper module and import it across these suites.
- **Lines saved:** 300
- **Risk:** low. Test-only consolidation.
- **Dependencies:** none for production APIs.

### R-6: Collapse `hrc-launch` into an internal launch/runtime module
- **Packages:** `hrc-launch`, `hrc-server`
- **Current:** The only production package import is `packages/hrc-server/src/index.ts:38`. The package root still exports eight symbols in `packages/hrc-launch/src/index.ts:3-8`, while the executable scripts already use local relative imports in `packages/hrc-launch/src/exec.ts:4-6` and `packages/hrc-launch/src/hook-cli.ts:1-3`. There is also a single-use helper in `packages/hrc-launch/src/hook.ts:16-24`, called only from `packages/hrc-launch/src/hook-cli.ts:41-46`.
- **Proposed:** Move launch-artifact/spool/hook helpers under the server package or otherwise make them internal to the launch scripts. Inline `buildHookEnvelope`, and share the callback-or-spool path between `exec.ts` and `hook-cli.ts`.
- **Lines saved:** 45
- **Risk:** medium-low. The repo only has one production consumer, but import paths and script wiring change.
- **Dependencies:** yes if external code imports `hrc-launch`.

### R-7: Narrow `hrc-store-sqlite` to the database handle actually consumed
- **Packages:** `hrc-store-sqlite`
- **Current:** `packages/hrc-store-sqlite/src/index.ts:4-34` exports migrations, all repository classes, and ten repository support types. Cross-package imports in the repo use only `openHrcDatabase` and `HrcDatabase`; `createHrcDatabase` and `phase1Migrations` only show up in package self-tests.
- **Proposed:** Keep the public root export to `openHrcDatabase` and `HrcDatabase` only. Let package-local tests import internal modules directly.
- **Lines saved:** 25
- **Risk:** medium. Strong in-repo evidence says the extra surface is vestigial, but this narrows a published API.
- **Dependencies:** yes. External consumers importing repositories or migration helpers would need updates.

### R-8: Remove repository alias methods and keep one canonical verb
- **Packages:** `hrc-store-sqlite`
- **Current:** `packages/hrc-store-sqlite/src/repositories.ts:589`, `1002`, `1292`, `1505` expose `create()` as a one-line alias to `insert()`. More aliases exist for read paths, for example `findByHostSession()` to `listByHostSessionId()`, `findByRuntime()` to `listByRuntimeId()`, `queryByRuntime()` to `listByRuntimeId()`, and `query()` to `listFromSeq()`.
- **Proposed:** Pick one name per action and update callers to that name instead of carrying both.
- **Lines saved:** 32
- **Risk:** medium. Mechanical caller updates are required.
- **Dependencies:** yes. Repository method names change.

### R-9: Prune dead and rename-only exports
- **Packages:** `hrc-core`, `hrc-sdk`, `hrc-cli`
- **Current:** `packages/hrc-core/src/index.ts:13`, `29-30` export `HrcErrorCodeValue`, `HrcFenceErrorCode`, and `createInvalidFenceError`; only `HrcErrorCodeValue` has in-repo consumers, and the other two appear unused. `packages/hrc-sdk/src/types.ts:162-175`, `226-227` defines rename-only aliases over core records. `packages/hrc-cli/src/index.ts:1-3` exports `{}` while the real entrypoint is `packages/hrc-cli/src/cli.ts`.
- **Proposed:** Remove `HrcFenceErrorCode` and `createInvalidFenceError`, rename the two internal `HrcErrorCodeValue` imports to `HrcErrorCode`, re-export core record types directly from the SDK instead of aliasing them in `types.ts`, and make `hrc-cli` bin-only.
- **Lines saved:** 20
- **Risk:** low-medium. Mostly type/export pruning, but public type import paths may change.
- **Dependencies:** yes. Public surface gets smaller.
