# Pi SDK Smoke Test Runbook

Manual smoke test for Pi SDK harness integration with agent-spaces, using the real agent-spaces project setup.

## Prerequisites

### 1. Verify Pi SDK is available

```bash
bun pm ls | grep pi-coding-agent || echo "Pi SDK may be dynamically resolved"
```

**Expected:** `@mariozechner/pi-coding-agent` package, or check `ASP_PI_SDK_ROOT` environment variable.

### 2. Verify Pi CLI is installed (for comparison)

```bash
pi --version
```

**Expected:** Version string (e.g., `pi 0.x.x`). Minimum supported version: `0.1.0`.

### 3. Verify Pi Authentication

```bash
ls -la ~/.pi/agent/auth.json
```

**Expected:** Auth file exists with valid credentials.

If not present, run:
```bash
pi auth login
```

**Note:** Pi SDK uses OAuth authentication stored in `~/.pi/agent/auth.json`. The adapter creates a symlink to this file automatically.

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

### Test 1: Verify Pi SDK Harness is Registered

```bash
$ASP_CLI harnesses 2>&1
```

**Expected:** Output includes `pi-sdk` in the list of available harnesses.

---

### Test 2: Add Pi SDK Test Target

Add a pi-sdk target to `asp-targets.toml` that uses real spaces.

```bash
# Check current targets
cat asp-targets.toml

# Add pi-sdk-test target (if not already present)
cat >> asp-targets.toml << 'EOF'

[targets.pi-sdk-test]
description = "Pi SDK smoke test target"
harness = "pi-sdk"
compose = ["space:smokey@dev", "space:defaults@stable"]

[targets.pi-sdk-test.pi]
model = "gpt-4o"
EOF

echo "Target added. Current targets:"
grep '^\[targets\.' asp-targets.toml
```

**Expected:** `pi-sdk-test` target added with smokey and defaults spaces.

**Note:** Pi SDK uses `harness = "pi-sdk"` at the target level.

---

### Test 3: Run asp install for Pi SDK Target

```bash
$ASP_CLI install --targets pi-sdk-test --harness pi-sdk 2>&1
```

**Expected:**
- No errors
- Output indicates successful materialization
- Creates bundle directory structure in `asp_modules/pi-sdk-test/pi-sdk/`
- Shows bundle manifest path

---

## Part 2: Materialization Verification

### Test 4: Verify Bundle Directory Structure

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/
```

**Expected structure:**
```
pi-sdk/
  bundle.json           # Bundle manifest
  extensions/           # Bundled extension .js files
  skills/               # Agent skills directory
  hooks/                # Hook scripts
  context/              # Space context/instructions
  settings.json         # SDK settings
  auth.json             # Symlink to ~/.pi/agent/auth.json
```

---

### Test 5: Verify Bundle Manifest

```bash
cat asp_modules/pi-sdk-test/pi-sdk/bundle.json | jq .
```

**Expected:**
```json
{
  "schemaVersion": 1,
  "harnessId": "pi-sdk",
  "targetName": "pi-sdk-test",
  "rootDir": "...",
  "extensions": [...],
  "skills": [...],
  "hooks": [...]
}
```

---

### Test 6: Verify Extensions Bundling

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/extensions/
```

**Expected:** Contains bundled `.js` files named `<spaceId>__<extensionName>.js`.

If spaces have TypeScript extensions, they should be compiled to single JS bundles.

---

### Test 7: Verify Skills Materialization

The `smokey` space includes the `smoke-testing` skill:

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/skills/
```

**Expected:** Contains `smoke-testing/` directory (from smokey space).

```bash
head -20 asp_modules/pi-sdk-test/pi-sdk/skills/smoke-testing/SKILL.md 2>/dev/null || ls asp_modules/pi-sdk-test/pi-sdk/skills/smoke-testing/
```

**Expected:** Content from the smokey smoke-testing skill.

---

### Test 8: Verify Context Files

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/context/
```

**Expected:** Space instruction files (CLAUDE.md, AGENT.md, or similar) placed in context directory.

---

### Test 9: Verify auth.json Symlink

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/auth.json
```

**Expected:** Symlink pointing to `~/.pi/agent/auth.json`.

If not present, OAuth won't work when running with the bundled configuration.

---

### Test 10: Verify Settings Configuration

```bash
cat asp_modules/pi-sdk-test/pi-sdk/settings.json
```

**Expected:** Contains SDK settings including skill discovery paths.

---

## Part 3: SDK Runner Tests

### Test 11: Dry Run - Verify Runner Command

```bash
$ASP_CLI run pi-sdk-test --harness pi-sdk --dry-run
```

**Expected command format:**
```
bun packages/execution/src/harness/pi-sdk/runner.ts --bundle .../asp_modules/pi-sdk-test/pi-sdk/bundle.json --project ... --cwd ... --mode exec --prompt "..."
```

---

### Test 12: Run with Simple Prompt

```bash
$ASP_CLI run pi-sdk-test "What is 2+2? Answer with just the number." --harness pi-sdk
```

**Expected:**
- Pi SDK runner starts with bundle configuration
- Returns answer: `4`
- Shows completion information

---

### Test 13: Verify Skills Discovery

```bash
$ASP_CLI run pi-sdk-test "What skills do you have access to? Just list the skill names." --harness pi-sdk
```

**Expected:** Response includes `smoke-testing` skill from the composed spaces.

---

## Part 4: Programmatic Tests

### Test 14: Direct Runner Invocation

```bash
bun packages/execution/src/harness/pi-sdk/runner.ts \
  --bundle "$PWD/asp_modules/pi-sdk-test/pi-sdk/bundle.json" \
  --project "$PWD" \
  --cwd "$PWD" \
  --mode exec \
  --prompt "What is 2+2?"
```

**Expected:** Runner executes and returns result.

---

### Test 15: Test Extension Loading

If the bundle includes extensions, verify they load:

```bash
cat > /tmp/pi-sdk-extension-test.ts << 'EOF'
import { readFileSync } from 'fs';

const bundlePath = process.argv[2];
const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));

console.log("Bundle:", bundle.targetName);
console.log("Extensions:", bundle.extensions?.length || 0);
console.log("Skills:", bundle.skills?.length || 0);
console.log("Hooks:", bundle.hooks?.length || 0);

for (const ext of bundle.extensions || []) {
  console.log(`  Extension: ${ext.path}`);
  try {
    const mod = await import(`${bundle.rootDir}/${ext.path}`);
    console.log(`    Loaded: ${Object.keys(mod).join(', ')}`);
  } catch (e) {
    console.log(`    Load error: ${e.message}`);
  }
}
EOF

bun /tmp/pi-sdk-extension-test.ts "$PWD/asp_modules/pi-sdk-test/pi-sdk/bundle.json"
```

**Expected:** Extensions load successfully if present.

---

### Test 16: Test Hooks Registration

```bash
cat asp_modules/pi-sdk-test/pi-sdk/bundle.json | jq '.hooks'
```

**Expected:** Array of hook definitions with `event` and `script` properties.

```bash
ls -la asp_modules/pi-sdk-test/pi-sdk/hooks/ 2>/dev/null || echo "No hooks directory (expected if spaces have no hooks)"
```

**Expected:** Hook scripts if spaces define hooks.

---

## Part 5: Build Configuration Tests

### Test 17: Verify Build Settings (if applicable)

If spaces have TypeScript extensions with build configuration:

```bash
# Check if any space has pi.build configuration
$ASP_CLI spaces show smokey 2>&1 | grep -A5 "pi.build" || echo "No pi.build config"
```

**Expected:** Build configuration if space has TypeScript extensions.

---

### Test 18: Verify Bundle Compilation

```bash
# Check extension file contents (should be compiled JS)
head -5 asp_modules/pi-sdk-test/pi-sdk/extensions/*.js 2>/dev/null || echo "No extensions to check"
```

**Expected:** Compiled JavaScript (not TypeScript source).

---

## Part 6: Control Plane Integration Tests (Optional)

These tests require a control-plane project configured with `sessionBackend.kind: "pi-sdk"`.

### Test 19: Check for Pi SDK-Enabled Project

```bash
curl -s "$BASE/admin/projects" -H "$TOKEN" | jq -r '.[] | "\(.projectId): \(.sessionBackend.kind // "none")"'
```

**Expected:** If no project shows `pi-sdk`, Part 6 tests should be skipped.

---

## Success Criteria

| Test | Criteria |
|------|----------|
| SDK detection | `asp harnesses` shows `pi-sdk` |
| Target creation | `pi-sdk-test` target added with `harness = "pi-sdk"` |
| Space resolution | Resolves `space:smokey@dev` and `space:defaults@stable` |
| Materialization | `asp install --targets pi-sdk-test --harness pi-sdk` completes |
| Bundle manifest | `bundle.json` generated with correct schema |
| auth.json | Symlink created to `~/.pi/agent/auth.json` |
| Extensions | TypeScript bundled to `.js` files in `extensions/` |
| Skills | Skills copied to `pi-sdk/skills/` directory |
| Context | Instruction files placed in `context/` |
| Settings | `settings.json` generated with skill discovery paths |
| Runner execution | SDK runner executes prompts successfully |
| Skills query | Model sees `smoke-testing` skill |

---

## Cleanup

```bash
# Remove test target from asp-targets.toml (optional)
# Edit asp-targets.toml and remove [targets.pi-sdk-test] section

# Clean materialized output
rm -rf asp_modules/pi-sdk-test

# Remove temporary test scripts
rm -f /tmp/pi-sdk-*.ts
```

---

## Troubleshooting

### "auth.json not found" / "Authentication failed"

**Cause:** OAuth credentials not found in bundle directory.

**Fix:**
```bash
# Verify Pi auth
ls -la ~/.pi/agent/auth.json

# If missing, login
pi auth login

# If using custom bundle, ensure auth.json is symlinked
ln -sf ~/.pi/agent/auth.json asp_modules/pi-sdk-test/pi-sdk/auth.json
```

### "pi: command not found"

Install Pi CLI:
```bash
# Follow installation instructions from OpenAI Pi documentation
```

### "Module not found: @mariozechner/pi-coding-agent"

**Cause:** Pi SDK not installed or `ASP_PI_SDK_ROOT` not set.

**Fix:**
```bash
# Option 1: Install the package
bun add @mariozechner/pi-coding-agent

# Option 2: Set SDK root
export ASP_PI_SDK_ROOT="/path/to/pi-coding-agent"
```

### "Extension load error"

**Cause:** Bundled extension has unresolved dependencies.

**Fix:**
- Ensure extensions are self-contained or only depend on packages in the runner environment
- Check `external` configuration in space's `pi.build` settings
- Verify bundle compilation completed without errors

### "Space not found: smokey@dev"

Ensure the smokey space is registered:
```bash
$ASP_CLI spaces list 2>&1 | grep smokey
```

### Skills not appearing

Verify materialization completed with `--harness pi-sdk`:
```bash
$ASP_CLI install --targets pi-sdk-test --harness pi-sdk
ls -laR asp_modules/pi-sdk-test/pi-sdk/skills/
```

### Bundle manifest missing fields

```bash
cat asp_modules/pi-sdk-test/pi-sdk/bundle.json | jq .
```

Verify all required fields are present. Re-run install if needed.

---

## Notes

- **OAuth Authentication:** Pi SDK uses OAuth stored in `~/.pi/agent/auth.json`. The adapter automatically symlinks this file.
- **Bundle Format:** Pi SDK uses a custom bundle format (different from Pi CLI's extension/skills directories) with a `bundle.json` manifest.
- **Extension Bundling:** TypeScript extensions are compiled to single `.js` files using Bun's bundler. Extensions must be dependency-free or use only packages available in the runner.
- **Runner Architecture:** The Pi SDK runner (`pi-sdk/runner.ts`) is a Bun-based entry point that loads bundles and invokes the Pi SDK.
- **Build Configuration:** Spaces can specify `[pi.build]` settings in `space.toml` for extension compilation options.
- **Real Spaces:** This runbook uses `space:smokey@dev` which provides the smoke-testing skill.
