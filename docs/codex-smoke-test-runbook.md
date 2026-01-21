# Codex Integration Smoke Test Runbook

Manual smoke test for Codex harness integration with agent-spaces, using the real agent-spaces project setup.

## Prerequisites

### 1. Verify Codex CLI is installed

```bash
codex --version
```

**Expected:** Version string (e.g., `codex 0.1.x`).

### 2. Verify app-server subcommand exists

```bash
codex app-server --help
```

**Expected:** Help text for the app-server subcommand. If this fails, Codex may be outdated.

### 3. Verify OpenAI API key is set

```bash
[ -n "$OPENAI_API_KEY" ] && echo "OPENAI_API_KEY is set" || echo "OPENAI_API_KEY NOT SET"
```

**Expected:** `OPENAI_API_KEY is set`

### 4. Verify Control Plane is running

```bash
curl -s 'http://127.0.0.1:18420/admin/status' -H 'x-cp-token: dev' | jq .
```

**Expected:** Status response with `{ "status": "ok", ... }`

### 5. Set test variables

```bash
BASE="http://127.0.0.1:18420"
TOKEN="x-cp-token: dev"
ASP_ROOT="$HOME/praesidium/agent-spaces"
ASP_CLI="bun run $ASP_ROOT/packages/cli/bin/asp.js"
```

### 6. Navigate to agent-spaces project

```bash
cd "$ASP_ROOT"
```

---

## Part 1: Harness Detection and Target Setup

### Test 1: Verify Codex Harness is Registered

```bash
$ASP_CLI harnesses 2>&1
```

**Expected:** Output includes `codex` in the list of available harnesses (may be marked experimental).

---

### Test 2: Add Codex Test Target

Add a codex target to `asp-targets.toml` that uses real spaces:

```bash
# Check current targets
cat asp-targets.toml

# Add codex-test target (if not already present)
cat >> asp-targets.toml << 'EOF'

[targets.codex-test]
description = "Codex smoke test target"
harness = "codex"
compose = ["space:smokey@dev", "space:defaults@stable"]

[targets.codex-test.codex]
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
EOF

echo "Target added. Current targets:"
grep '^\[targets\.' asp-targets.toml
```

**Expected:** `codex-test` target added with smokey and defaults spaces.

**Note:** The `smokey` space includes skills for smoke testing, making it a good candidate.

---

### Test 3: Run asp install for Codex Target

```bash
$ASP_CLI install --target codex-test 2>&1
```

**Expected:**
- No errors
- Output indicates successful materialization
- Creates `codex.home/` directory in `asp_modules/codex-test/`

---

## Part 2: Materialization Verification

### Test 4: Verify Codex Home Template Structure

```bash
ls -la asp_modules/codex-test/codex.home/
```

**Expected structure:**
```
codex.home/
  AGENTS.md
  config.toml
  skills/
  prompts/
  manifest.json (optional)
```

---

### Test 5: Verify Skills Materialization

The `smokey` space includes the `smoke-testing` skill. Verify it's copied:

```bash
ls -la asp_modules/codex-test/codex.home/skills/
```

**Expected:** Contains `smoke-testing/` directory (from smokey space).

```bash
cat asp_modules/codex-test/codex.home/skills/smoke-testing/SKILL.md | head -20
```

**Expected:** Content from the smokey smoke-testing skill.

---

### Test 6: Verify Playbooks Are Included

The smoke-testing skill includes playbook files:

```bash
ls -la asp_modules/codex-test/codex.home/skills/smoke-testing/playbooks/
```

**Expected:** Playbook files like `quick-sanity.md`, `full-sweep.md`, etc.

---

### Test 7: Verify Commands → Prompts Mapping

Check if any commands from the spaces were converted to Codex prompts:

```bash
ls -la asp_modules/codex-test/codex.home/prompts/ 2>/dev/null || echo "No prompts directory (expected if no commands in composed spaces)"
```

**Expected:** Either prompts directory with `.md` files, or no directory if source spaces don't have commands.

---

### Test 8: Verify AGENTS.md Generation

```bash
cat asp_modules/codex-test/codex.home/AGENTS.md
```

**Expected:**
- Contains a generated header
- Contains content from space instructions wrapped in markers:
  ```
  <!-- BEGIN space: smokey@<version> -->
  ...
  <!-- END space: smokey@<version> -->
  ```

---

### Test 9: Verify config.toml Generation

```bash
cat asp_modules/codex-test/codex.home/config.toml
```

**Expected:**
- `sandbox_mode = "workspace-write"`
- `approval_policy = "on-request"`
- `project_doc_fallback_filenames = ["AGENTS.md", "AGENT.md"]`
- MCP server definitions if the spaces include MCP configurations

---

### Test 10: Compare with Claude Plugin Output

Verify both Claude and Codex outputs are generated for the same target:

```bash
# Claude plugin structure (existing)
ls -la asp_modules/codex-test/claude/plugins/ 2>/dev/null || echo "No claude output (expected for codex-only target)"

# Codex home structure (new)
ls -la asp_modules/codex-test/codex.home/
```

**Note:** A codex-harness target should produce `codex.home/` but not `claude/plugins/`.

---

## Part 3: App-Server Protocol Tests (Manual)

### Test 11: Start Codex App-Server Directly

In a **separate terminal**, start the app-server with the materialized home:

```bash
cd ~/praesidium/agent-spaces
CODEX_HOME="$PWD/asp_modules/codex-test/codex.home" codex app-server
```

**Expected:** Server starts and waits for JSON-RPC input on stdin.

### Test 12: Initialize Handshake

In the **original terminal**, send initialize request via a named pipe or by pasting into the app-server terminal:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"agent-spaces-test","version":"1.0.0"}}}
```

**Expected:** Server responds with capabilities JSON.

Then send initialized notification:
```json
{"jsonrpc":"2.0","method":"initialized","params":{}}
```

---

## Part 4: Control Plane Integration Tests

These tests require a control-plane project configured with `harness: "codex"`.

### Test 13: Create or Verify Codex-Enabled Project

Check existing projects:

```bash
curl -s "$BASE/admin/projects" -H "$TOKEN" | jq '.[].projectId'
```

For this test, we'll use `agent-spaces-v2` or create a dedicated test project. First, check its current backend:

```bash
curl -s "$BASE/admin/projects/agent-spaces-v2" -H "$TOKEN" | jq '.sessionBackend'
```

**Note:** If the project uses `agent-sdk`, you'll need to either:
1. Create a new project with `harness: "codex"`, or
2. Temporarily update the project's backend (requires CP restart)

For this runbook, we'll assume a project `codex-smoke-test` exists with codex backend:

```bash
PROJECT="codex-smoke-test"
curl -s "$BASE/admin/projects/$PROJECT" -H "$TOKEN" | jq '{projectId, sessionBackend}'
```

**Expected:** `{ "sessionBackend": { "kind": "codex", "model": "gpt-5.2-codex" } }`

---

### Test 14: Start a Codex Session via Control Plane

```bash
RESULT=$(curl -s -X POST "$BASE/admin/runs" \
  -H "$TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"projectId\": \"$PROJECT\",
    \"prompt\": \"What is 2+2? Answer with just the number.\",
    \"session\": {
      \"policy\": \"new\",
      \"name\": \"Codex Smoke Test $(date +%s)\"
    }
  }")
echo "$RESULT" | jq .
```

**Expected:**
```json
{ "runId": "...", "sessionId": "...", "status": "queued" }
```

**Capture values:**
```bash
RUN_ID=$(echo "$RESULT" | jq -r '.runId')
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')
echo "Run ID: $RUN_ID"
echo "Session ID: $SESSION_ID"
```

---

### Test 15: Connect SSE Stream

In a **separate terminal**, connect to the event stream:

```bash
curl -N "$BASE/admin/sessions/$SESSION_ID/events/stream" \
  -H "$TOKEN" \
  -H 'Accept: text/event-stream'
```

**Expected:** Events stream including:
- `turn_start`
- `message_start` / `message_update` / `message_end`
- `turn_end`

---

### Test 16: Wait for Run Completion

```bash
curl -s "$BASE/admin/runs/$RUN_ID/wait?timeoutMs=120000" -H "$TOKEN" | jq .
```

**Expected:**
```json
{
  "status": "completed",
  "completedAt": ...,
  "finalOutput": "4"
}
```

---

### Test 17: Verify Session Has Harness Session ID (Thread ID)

```bash
curl -s "$BASE/admin/sessions/$SESSION_ID" -H "$TOKEN" | jq '{sessionId, harnessSessionId, backendKind}'
```

**Expected:**
- `backendKind: "codex"`
- `harnessSessionId` is a non-null string (the Codex thread ID)

```bash
THREAD_ID=$(curl -s "$BASE/admin/sessions/$SESSION_ID" -H "$TOKEN" | jq -r '.harnessSessionId')
echo "Thread ID: $THREAD_ID"
```

---

### Test 18: Resume Session (Test Thread Continuity)

```bash
RESULT2=$(curl -s -X POST "$BASE/admin/runs" \
  -H "$TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"projectId\": \"$PROJECT\",
    \"prompt\": \"What was my previous question?\",
    \"session\": {
      \"policy\": \"resume\",
      \"sessionId\": \"$SESSION_ID\"
    }
  }")
echo "$RESULT2" | jq .
RUN_ID_2=$(echo "$RESULT2" | jq -r '.runId')
```

**Expected:** Same `sessionId`, new `runId`.

---

### Test 19: Wait for Resume Run and Verify Context

```bash
curl -s "$BASE/admin/runs/$RUN_ID_2/wait?timeoutMs=120000" -H "$TOKEN" | jq '{status, finalOutput}'
```

**Expected:** Response references "2+2" or the previous question, proving context was maintained via thread_id.

---

### Test 20: Verify Event Types in Session

```bash
curl -s "$BASE/admin/sessions/$SESSION_ID/events" -H "$TOKEN" | jq '[.events[].kind] | unique'
```

**Expected:** Array includes Codex-mapped event types:
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`

---

### Test 21: Verify Session Events Log File

Check that raw events are being logged:

```bash
STATE_DIR="$HOME/praesidium/var/state"
cat "$STATE_DIR/sessions/$SESSION_ID/events.jsonl" 2>/dev/null | head -10 | jq -c '{seq, kind}'
```

**Expected:** JSONL file with sequential events.

---

## Part 5: Using wrkq Project (Alternative)

If testing against the `wrkq` project instead:

### Test 22: Check wrkq asp-targets.toml

```bash
cat ~/praesidium/wrkq/asp-targets.toml
```

Verify or add a codex target:

```bash
cd ~/praesidium/wrkq

# Add codex target if not present
cat >> asp-targets.toml << 'EOF'

[targets.codex-smokey]
description = "Codex with smokey space"
harness = "codex"
compose = ["space:smokey@dev", "space:defaults@stable"]

[targets.codex-smokey.codex]
model = "gpt-5.2-codex"
EOF
```

### Test 23: Install wrkq Codex Target

```bash
cd ~/praesidium/wrkq
bun run ~/praesidium/agent-spaces/packages/cli/bin/asp.js install --target codex-smokey
```

**Expected:** Materializes `asp_modules/codex-smokey/codex.home/` with skills from smokey space.

---

## Success Criteria

| Test | Criteria |
|------|----------|
| Codex detection | `asp harnesses` shows codex |
| Target creation | `codex-test` target added to asp-targets.toml |
| Space resolution | Resolves `space:smokey@dev` and `space:defaults@stable` |
| Materialization | `asp install` completes without errors |
| Skills | `smoke-testing` skill copied to `codex.home/skills/` |
| Playbooks | Skill subdirectories (playbooks/) preserved |
| AGENTS.md | Instructions merged with space markers |
| config.toml | Contains safe defaults and project_doc_fallback |
| App-server | Starts with CODEX_HOME pointing to materialized home |
| Session creation | New session created via control-plane |
| Run completion | Run completes with expected output |
| Thread persistence | `harnessSessionId` populated with thread_id |
| Session resume | Context maintained across runs via thread resume |
| Event mapping | Codex events mapped to unified types |

---

## Cleanup

```bash
# Remove test target from asp-targets.toml (optional)
# Edit asp-targets.toml and remove [targets.codex-test] section

# Clean materialized output
rm -rf asp_modules/codex-test

# Sessions persist in control-plane until manually cleaned
```

---

## Troubleshooting

### "codex: command not found"

Install Codex CLI:
```bash
# Follow installation instructions from OpenAI Codex documentation
# https://developers.openai.com/codex/cli/
```

### "app-server: unknown subcommand"

The `app-server` subcommand is experimental. Ensure you have a recent version of Codex:
```bash
codex --version
# Update if needed
```

### "OPENAI_API_KEY not set"

Export your OpenAI API key:
```bash
export OPENAI_API_KEY="sk-..."
```

### "Space not found: smokey@dev"

Ensure the smokey space is registered:
```bash
$ASP_CLI spaces list 2>&1 | grep smokey
```

If not found, the space may need to be published to the registry.

### "Target not found in lock: codex-test"

Run install to update the lock file:
```bash
$ASP_CLI install
```

### Session stuck in "queued" or "injecting"

Check control-plane logs:
```bash
tail -50 ~/.control-plane/logs/cp.log | grep -i error
```

Verify the project's sessionBackend is configured for codex:
```bash
curl -s "$BASE/admin/projects/$PROJECT" -H "$TOKEN" | jq '.sessionBackend'
```

### "Thread not found" on resume

The Codex thread may have expired or been cleaned up. Start a new session:
```bash
# Use policy: "new" instead of "resume"
```

### Events not streaming

Verify SSE connection:
```bash
curl -v -N "$BASE/admin/sessions/$SESSION_ID/events/stream" \
  -H "$TOKEN" \
  -H 'Accept: text/event-stream'
```

### Skills/prompts not appearing in codex.home

Verify materialization completed:
```bash
ls -laR asp_modules/codex-test/codex.home/
```

Check for errors in asp install output:
```bash
$ASP_CLI install --target codex-test --verbose 2>&1
```

### MCP servers not configured

Check if composed spaces include MCP definitions:
```bash
# MCP would be in space's mcp/ directory or mcp.json
```

Check generated config.toml for `[mcp_servers.*]` sections.

---

## Notes

- **Experimental Status:** The Codex harness uses the experimental `codex app-server` subcommand. Behavior may change in future Codex releases.
- **Feature Flag:** If Codex support is gated, enable with `ASP_EXPERIMENTAL_CODEX=1`.
- **Model Availability:** Ensure your OpenAI account has access to Codex models (e.g., `gpt-5.2-codex`).
- **Real Spaces:** This runbook uses `space:smokey@dev` which provides the smoke-testing skill with playbooks for testing.
