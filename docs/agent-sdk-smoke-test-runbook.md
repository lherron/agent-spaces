# Claude Agent SDK Smoke Test Runbook

Manual smoke test for Claude Agent SDK harness integration with agent-spaces, using the real agent-spaces project setup.

## Prerequisites

### 1. Verify Claude Agent SDK is installed

```bash
bun pm ls | grep claude-agent-sdk
```

**Expected:** `@anthropic-ai/claude-agent-sdk` version `0.1.72` or higher.

### 2. Verify Claude CLI is installed (for comparison)

```bash
claude --version
```

**Expected:** Version string (e.g., `claude 1.x.x`). The Agent SDK reuses Claude's plugin directory format.

### 3. Verify Anthropic API Key

```bash
echo $ANTHROPIC_API_KEY | head -c 10
```

**Expected:** `sk-ant-api` prefix (first 10 chars shown for verification).

**Note:** Unlike the CLI which can use OAuth, the Agent SDK requires an API key.

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

### Test 1: Verify Agent SDK Harness is Registered

```bash
$ASP_CLI harnesses 2>&1
```

**Expected:** Output includes `claude-agent-sdk` in the list of available harnesses.

---

### Test 2: Add Agent SDK Test Target

Add an agent-sdk target to `asp-targets.toml` that uses real spaces.

```bash
# Check current targets
cat asp-targets.toml

# Add agent-sdk-test target (if not already present)
cat >> asp-targets.toml << 'EOF'

[targets.agent-sdk-test]
description = "Claude Agent SDK smoke test target"
harness = "claude-agent-sdk"
compose = ["space:smokey@dev", "space:defaults@stable"]

[targets.agent-sdk-test.claude]
model = "claude-sonnet-4-20250514"
permission_mode = "bypassPermissions"
EOF

echo "Target added. Current targets:"
grep '^\[targets\.' asp-targets.toml
```

**Expected:** `agent-sdk-test` target added with smokey and defaults spaces.

**Note:** The Agent SDK uses `harness = "claude-agent-sdk"` at the target level, unlike Codex which uses subtables.

---

### Test 3: Run asp install for Agent SDK Target

```bash
$ASP_CLI install --targets agent-sdk-test --harness claude-agent-sdk 2>&1
```

**Expected:**
- No errors
- Output indicates successful materialization
- Creates plugin directory structure in `asp_modules/agent-sdk-test/claude-agent-sdk/`
- Shows materialization summary

---

## Part 2: Materialization Verification

### Test 4: Verify Plugin Directory Structure

```bash
ls -la asp_modules/agent-sdk-test/claude-agent-sdk/
```

**Expected structure:**
```
claude-agent-sdk/
  plugins/
    smokey/
    defaults/
  manifest.json
```

The Agent SDK reuses the same plugin directory format as the Claude CLI harness.

---

### Test 5: Verify Skills Materialization

The `smokey` space includes the `smoke-testing` skill. Verify it's available:

```bash
ls -la asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey/skills/ 2>/dev/null || echo "Skills in plugin root"
ls -la asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey/
```

**Expected:** Contains skill directories from smokey space.

---

### Test 6: Verify Commands Are Present

```bash
ls -la asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey/commands/ 2>/dev/null || echo "No commands directory (may be expected)"
```

**Expected:** Commands directory with space commands, or no directory if space has no commands.

---

### Test 7: Verify MCP Server Configuration

```bash
cat asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey/.mcp.json 2>/dev/null || echo "No MCP config (expected if space has no MCP servers)"
```

**Expected:** MCP configuration if the space defines MCP servers.

---

### Test 8: Verify Manifest Generation

```bash
cat asp_modules/agent-sdk-test/claude-agent-sdk/manifest.json
```

**Expected:**
- Contains `harnessId: "claude-agent-sdk"`
- Contains `targetName: "agent-sdk-test"`
- Lists composed spaces with their plugin directories

---

## Part 3: SDK Execution Tests

### Test 9: Run Interface Test Script

```bash
bun scripts/claude-agent-sdk-interface-test.ts --target agent-sdk-test --target-dir "$PWD" "What is 2+2? Answer with just the number."
```

**Expected:**
- Agent SDK session starts
- Returns answer: `4`
- Shows token usage

**Note:** If this script doesn't exist, use the programmatic test below.

---

### Test 10: Programmatic SDK Test

Create a test script to verify SDK execution:

```bash
cat > /tmp/agent-sdk-test.ts << 'EOF'
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = await query({
  prompt: "What is 2+2? Answer with just the number.",
  options: {
    model: "claude-sonnet-4-20250514",
    permissionMode: "bypassPermissions",
  }
});

console.log("Result:", result.result);
console.log("Cost:", result.costUsd);
EOF

bun /tmp/agent-sdk-test.ts
```

**Expected:** Returns `4` with cost information.

---

### Test 11: Verify Skills Discovery via SDK

```bash
cat > /tmp/agent-sdk-skills-test.ts << 'EOF'
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = await query({
  prompt: "What skills do you have access to? Just list the skill names.",
  options: {
    model: "claude-sonnet-4-20250514",
    permissionMode: "bypassPermissions",
    cwd: process.env.PWD,
  }
});

console.log("Skills:", result.result);
EOF

CLAUDE_LOCAL_PLUGINS="$PWD/asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey" bun /tmp/agent-sdk-skills-test.ts
```

**Expected:** Response includes `smoke-testing` skill from the composed spaces.

---

### Test 12: Test Session Resumption

```bash
cat > /tmp/agent-sdk-resume-test.ts << 'EOF'
import { query } from '@anthropic-ai/claude-agent-sdk';

// First query
const first = await query({
  prompt: "Remember the number 42.",
  options: {
    model: "claude-sonnet-4-20250514",
    permissionMode: "bypassPermissions",
  }
});

console.log("First response:", first.result);
console.log("Session ID:", first.sessionId);

// Resume and ask about the number
const second = await query({
  prompt: "What number did I ask you to remember?",
  options: {
    model: "claude-sonnet-4-20250514",
    permissionMode: "bypassPermissions",
    resume: first.sessionId,
  }
});

console.log("Second response:", second.result);
EOF

bun /tmp/agent-sdk-resume-test.ts
```

**Expected:** Second response mentions `42`, proving session state is maintained.

---

## Part 4: Hooks Integration Tests

### Test 13: Verify Hooks Bridge

The Agent SDK harness includes hooks bridge integration. Test hook execution:

```bash
cat > /tmp/agent-sdk-hooks-test.ts << 'EOF'
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = await query({
  prompt: "List the files in the current directory",
  options: {
    model: "claude-sonnet-4-20250514",
    permissionMode: "bypassPermissions",
    cwd: process.env.PWD,
  },
  hooks: {
    onToolStart: (tool) => console.log(`Tool starting: ${tool.name}`),
    onToolEnd: (tool) => console.log(`Tool ended: ${tool.name}`),
  }
});

console.log("Result:", result.result);
EOF

bun /tmp/agent-sdk-hooks-test.ts
```

**Expected:** Shows tool start/end events for any tools used.

---

## Part 5: Agent Session Tests

### Test 14: Test AgentSession Interface

```bash
# If the agent-spaces execution package exposes AgentSession for SDK:
bun -e "
import { createAgentSession } from '@agent-spaces/execution';

const session = await createAgentSession({
  harness: 'claude-agent-sdk',
  target: 'agent-sdk-test',
  targetDir: process.cwd(),
});

const result = await session.runTurn('What is 2+2?');
console.log('Result:', result);
await session.close();
"
```

**Expected:** AgentSession wraps SDK calls and returns result.

---

## Part 6: Control Plane Integration Tests (Optional)

These tests require a control-plane project configured with `sessionBackend.kind: "claude-agent-sdk"`.

### Test 15: Check for Agent SDK-Enabled Project

```bash
curl -s "$BASE/admin/projects" -H "$TOKEN" | jq -r '.[] | "\(.projectId): \(.sessionBackend.kind // "none")"'
```

**Expected:** If no project shows `claude-agent-sdk`, Part 6 tests should be skipped.

---

## Success Criteria

| Test | Criteria |
|------|----------|
| SDK detection | `asp harnesses` shows `claude-agent-sdk` |
| Target creation | `agent-sdk-test` target added with `harness = "claude-agent-sdk"` |
| Space resolution | Resolves `space:smokey@dev` and `space:defaults@stable` |
| Materialization | `asp install --targets agent-sdk-test --harness claude-agent-sdk` completes |
| Plugin directories | Created in `asp_modules/agent-sdk-test/claude-agent-sdk/plugins/` |
| Skills | Skills from composed spaces available in plugin directories |
| Manifest | `manifest.json` generated with correct harness ID |
| SDK query | `query()` function returns correct answers |
| Skills discovery | Model sees skills from composed spaces |
| Session resume | Context maintained via `resume` option |
| Hooks bridge | Tool events fire correctly |

---

## Cleanup

```bash
# Remove test target from asp-targets.toml (optional)
# Edit asp-targets.toml and remove [targets.agent-sdk-test] section

# Clean materialized output
rm -rf asp_modules/agent-sdk-test

# Remove temporary test scripts
rm -f /tmp/agent-sdk-*.ts
```

---

## Troubleshooting

### "ANTHROPIC_API_KEY not set"

**Cause:** The Agent SDK requires an API key (unlike CLI which supports OAuth).

**Fix:**
```bash
export ANTHROPIC_API_KEY="sk-ant-api..."
```

### "Module not found: @anthropic-ai/claude-agent-sdk"

**Cause:** SDK not installed in the execution package.

**Fix:**
```bash
cd packages/execution
bun add @anthropic-ai/claude-agent-sdk
```

### "Permission denied" errors

**Cause:** Using default permission mode which requires approval.

**Fix:** Use `permissionMode: "bypassPermissions"` for testing, or implement permission callbacks.

### Skills not appearing

**Cause:** Plugin directory not set or not found.

**Fix:**
```bash
# Verify plugin directory exists
ls asp_modules/agent-sdk-test/claude-agent-sdk/plugins/

# Set CLAUDE_LOCAL_PLUGINS if running manually
export CLAUDE_LOCAL_PLUGINS="$PWD/asp_modules/agent-sdk-test/claude-agent-sdk/plugins/smokey"
```

### "Space not found: smokey@dev"

Ensure the smokey space is registered:
```bash
$ASP_CLI spaces list 2>&1 | grep smokey
```

---

## Notes

- **API Key Required:** Unlike Claude CLI which supports OAuth, the Agent SDK requires `ANTHROPIC_API_KEY`.
- **Plugin Format:** The Agent SDK uses the same plugin directory format as Claude CLI, enabling shared materialization logic.
- **Programmatic Use:** The SDK is designed for programmatic/headless execution, not interactive terminal sessions.
- **Hooks Bridge:** Agent Spaces provides a hooks bridge to integrate SDK tool events with the unified hooks system.
- **Session Management:** The SDK supports session resumption via session IDs, enabling multi-turn conversations.
- **Real Spaces:** This runbook uses `space:smokey@dev` which provides the smoke-testing skill.
