# Agent Spaces v2 justfile

# Default recipe
default:
    @just info
    @just --list

# Project information
info:
    @echo "Current Project: spaces"
    @echo "Description: Composable expertise modules, ASP registry"
    @echo "Stack:       TypeScript (Bun workspace)"
    @echo ""
    @echo "Key commands:"
    @echo "  just build     - Build all packages"
    @echo "  just test      - Run tests"
    @echo "  just lint      - Run biome linter"
    @echo "  just verify    - Run lint + typecheck + test"

# Build all packages
build:
    bun run build

# Run tests
test:
    bun run test

# Run integration tests
test-integration:
    bun run test:integration

# --- Room-readiness env lifecycle (T-06887 convention; host-agnostic names) ---
# The e2e suite (integration-tests/tests) is hermetic: it drives the asp CLI
# against in-repo fixtures using the claude/codex SHIMS, never real agent binaries
# or the verdaccio registry, so env-up needs no host services — only the image
# substrate (bun/node/git) plus a built workspace. The deeper real-binary broker
# matrix (`bun run smoke:matrix`) is a separate, credential-gated e2e and is NOT
# wired here on purpose: it needs live codex/claude auth, which is not substrate.

# Provision the e2e environment (idempotent, self-healing, no host services)
env-up:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> env-up: agent-spaces"
    # Substrate preflight — name the one missing tool instead of failing deep in
    # a test with a bare 127. These are image substrate, not project env.
    missing=()
    for tool in bun node git; do
      command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    if (( ${#missing[@]} > 0 )); then
      echo "env-up: missing substrate: ${missing[*]}" >&2
      echo "        bun/node: build+test runner · git: the integration suite inits a fixture repo" >&2
      exit 1
    fi
    echo "  ok    substrate present: bun node git"
    # Deps + build are what the hermetic e2e cannot do for itself: consumer
    # packages import built workspace dist. Frozen install keeps the lock honest.
    LEFTHOOK=0 bun install --frozen-lockfile >/dev/null
    echo "  ok    dependencies installed (frozen lockfile)"
    bun run build >/dev/null
    echo "  ok    workspace built ({contracts,core,drivers,compiler,harness,apps}/*/dist)"
    echo "==> env-up: ready — run 'just e2e'"

# Tear down the e2e environment (safe to run when nothing is up, and twice)
env-down:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> env-down: agent-spaces"
    # The suite git-inits fixture registries and writes a shim output file; nothing
    # long-lived is started. Teardown is those ephemeral artifacts alone, kept
    # unconditional so a crashed env-up never blocks cleanup.
    for g in integration-tests/fixtures/*/.git; do
      [[ -e "$g" ]] && rm -rf "$g" && echo "  ok    removed ${g}"
    done
    rm -f /tmp/claude-shim-output.json && echo "  ok    removed shim output"
    echo "==> env-down: clean"

# Run the hermetic e2e suite (provisions its own environment first)
e2e: env-up
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> e2e: agent-spaces integration suite"
    bun test integration-tests/tests
    echo "==> e2e: green"

# Run linter
lint:
    bun run lint

# Attach-before-start live debugger for the real codex-cli-tmux broker path.
debug-codex-tmux-live *args:
    bun scripts/debug-codex-tmux-live.ts --broker-transport stdio {{args}}

# Attach-before-start live debugger over the long-lived broker IPC socket path.
debug-codex-tmux-live-ipc *args:
    bun scripts/debug-codex-tmux-live.ts --broker-transport ipc {{args}}

debug-pi-tui-tmux-live *args:
    bun scripts/debug-pi-tui-tmux-live.ts {{args}}

# Render normal broker events from an experimental broker observer socket.
debug-broker-events socket *args:
    bun scripts/debug-broker-events.ts --socket {{socket}} {{args}}

# Find likely code entry points for a topic.
discover topic:
    bun scripts/find-entry-points.ts {{topic}}

# Explain a repo area using the shared import graph.
explain area:
    bun scripts/explain-area.ts {{area}}

# Fix lint issues
lint-fix:
    bun run lint:fix

# Run type checker
typecheck:
    bun run typecheck

# Run repo-split boundary + manifest edge checks
check:
    bun scripts/check-boundaries.ts
    bun scripts/check-runtime-contract-harness-boundaries.ts
    bun scripts/check-manifest-edges.ts
    bun scripts/check-suppressions.ts
    bun scripts/check-public-surface.ts
    bun scripts/check-doc-reachability.ts
    bun scripts/check-rule-authoring.ts

# Overlay Cody into the default Codex home and install managed Praesidium CLI hooks
overlay-codex *args:
    bun scripts/sync-agent-to-codex-default.ts --install-hooks --apply {{args}}

# Validate durable architecture records and generated projections
architecture-records *args:
    bun scripts/check-architecture-records.ts {{args}}

# Run all verification (build + architecture + check + lint + typecheck + test)
# `build` runs FIRST so the gate is self-provisioning from a virgin clone: consumer
# packages typecheck/test against the workspace's built dist/*.d.ts (imports like
# `spaces-execution` / `agent-scope` resolve from dist, and source-only inference
# widens some keyof types to `string | symbol`). Without a prior build a fresh clone
# fails typecheck where a warm host tree passes — room-readiness gate (T-06887).
verify: build architecture-records check lint typecheck test

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

# Install dependencies
# Pass no-sync=1 to skip syncing downstream consumer repos (hrc-runtime, agent-control-plane).
# Linked Git worktrees auto-disable downstream sync and wrapper linking unless force-sync=1
# and/or force-link=1 is passed explicitly.
# After `bun install`, the dependency graph forks:
#   build ─┬─→ publish-canonical ─→ (hrc sync ∥ acp sync)
#          └─→ bun link (asp + harness-broker)
# Executable package links run alongside publish+sync; the two downstream syncs run in parallel.
install no-sync="" force-sync="" force-link="":
    #!/usr/bin/env bash
    set -euo pipefail
    repo_root="$(git rev-parse --show-toplevel)"
    eval "$(bun scripts/install-policy.ts shell --no-sync="{{ no-sync }}" --force-sync="{{ force-sync }}" --force-link="{{ force-link }}")"
    resolve_consumer() {
      local name="$1"
      local candidate
      for candidate in "$repo_root/../$name" "$repo_root/../../$name" "$HOME/praesidium/$name"; do
        if [ -d "$candidate" ]; then
          (cd "$candidate" && pwd)
          return 0
        fi
      done
      echo "unable to locate downstream consumer repo: $name" >&2
      return 1
    }

    echo "[install] context=${PRAESIDIUM_INSTALL_CONTEXT} sync=${PRAESIDIUM_INSTALL_SYNC_MODE} link=${PRAESIDIUM_INSTALL_LINK_MODE} publish=${PRAESIDIUM_INSTALL_PUBLISH_CHANNEL} tag=${PRAESIDIUM_INSTALL_PUBLISH_TAG}"
    bun run clean
    bun install
    bun run build

    link_pids=()
    if [ "$PRAESIDIUM_INSTALL_LINK_MODE" != "off" ]; then
      if [ "$PRAESIDIUM_INSTALL_LINK_MODE" = "forced" ]; then
        echo "[install] WARNING: force-link enabled from ${PRAESIDIUM_INSTALL_CONTEXT}; updating local asp and harness-broker executables"
      fi
      # Fire executable package links in the background — they only depend on build, not publish.
      ( cd apps/cli && bun link 2>&1 | sed 's/^/[bun-link:asp] /' ) &
      link_pids+=("$!")
      ( cd harness/harness-broker && bun link 2>&1 | sed 's/^/[bun-link:harness-broker] /' ) &
      link_pids+=("$!")
      ( cd harness/harness-broker-pi-sdk && bun link 2>&1 | sed 's/^/[bun-link:harness-broker-pi] /' ) &
      link_pids+=("$!")
      # spaces-aspc ships the compile-only `aspc` CLI; the cohosted facade bin
      # `aspc-facade` now ships from spaces-aspc-facade. Out-of-repo consumers
      # (taskboard's agent viewer, hrc-server) spawn `aspc-facade run --transport
      # stdio` as a bare executable, so the facade package has to be a linked
      # binary like asp, not only a workspace bin.
      ( cd compiler/aspc && bun link 2>&1 | sed 's/^/[bun-link:aspc] /' ) &
      link_pids+=("$!")
      ( cd harness/aspc-facade && bun link 2>&1 | sed 's/^/[bun-link:aspc-facade] /' ) &
      link_pids+=("$!")
    else
      echo "[install] skipping executable links; linked worktree installs must not update local asp or harness-broker executables"
    fi

    # Publish must complete before downstream sync.
    if [ "$PRAESIDIUM_INSTALL_PUBLISH_CHANNEL" = "worktree" ]; then
      just publish-worktree
    else
      just publish-canonical
    fi

    if [ "$PRAESIDIUM_INSTALL_SYNC_MODE" != "off" ]; then
      if [ "$PRAESIDIUM_INSTALL_SYNC_MODE" = "forced" ]; then
        echo "[install] WARNING: force-sync enabled from ${PRAESIDIUM_INSTALL_CONTEXT}; syncing downstream repos"
      fi
      # Resolve + sync each consumer INDEPENDENTLY (T-06819): a repo absent on this
      # node degrades to a warning and never aborts the other consumer's sync. An
      # unguarded `var="$(resolve_consumer …)"` inherits the failing substitution's
      # status under `set -e`, so a missing agent-control-plane used to kill the
      # hrc-runtime sync before it ran. In an `if` condition, `set -e` is suppressed
      # for the substitution, so a missing repo takes the else branch cleanly.
      if hrc_runtime="$(resolve_consumer hrc-runtime 2>/dev/null)"; then
        ( cd "$hrc_runtime" && bun run sync:asp && bun run build && just publish-dev ) 2>&1 | sed 's/^/[hrc-sync] /'
      else
        echo "[install] downstream consumer hrc-runtime not present on this node; skipping hrc sync" >&2
      fi
      if agent_control_plane="$(resolve_consumer agent-control-plane 2>/dev/null)"; then
        ( cd "$agent_control_plane" && bun run sync:asp ) 2>&1 | sed 's/^/[acp-sync] /'
      else
        echo "[install] downstream consumer agent-control-plane not present on this node; skipping acp sync" >&2
      fi
    else
      echo "[install] skipping downstream sync (${PRAESIDIUM_INSTALL_CONTEXT}, sync=${PRAESIDIUM_INSTALL_SYNC_MODE})"
    fi

    for link_pid in "${link_pids[@]}"; do
      wait $link_pid
    done

# Sync downstream consumer repos in parallel (hrc-runtime ∥ agent-control-plane).
# This is the only place ASP knows where its consumers live; it never appears in source.
sync-downstream:
    #!/usr/bin/env bash
    set -euo pipefail
    repo_root="$(git rev-parse --show-toplevel)"
    resolve_consumer() {
      local name="$1"
      local candidate
      for candidate in "$repo_root/../$name" "$repo_root/../../$name" "$HOME/praesidium/$name"; do
        if [ -d "$candidate" ]; then
          (cd "$candidate" && pwd)
          return 0
        fi
      done
      echo "unable to locate downstream consumer repo: $name" >&2
      return 1
    }

    # Resolve + sync each consumer INDEPENDENTLY (T-06819): a repo absent on this
    # node degrades to a warning instead of aborting the other consumer's sync
    # (an unguarded assignment from a failing substitution trips `set -e`).
    if hrc_runtime="$(resolve_consumer hrc-runtime 2>/dev/null)"; then
      ( cd "$hrc_runtime" && bun run sync:asp && bun run build && just publish-dev ) 2>&1 | sed 's/^/[hrc-sync] /'
    else
      echo "[sync-downstream] hrc-runtime not present on this node; skipping hrc sync" >&2
    fi
    if agent_control_plane="$(resolve_consumer agent-control-plane 2>/dev/null)"; then
      ( cd "$agent_control_plane" && bun run sync:asp ) 2>&1 | sed 's/^/[acp-sync] /'
    else
      echo "[sync-downstream] agent-control-plane not present on this node; skipping acp sync" >&2
    fi

# Publish timestamped dev package set to local Verdaccio
publish-dev:
    bun scripts/publish-local-verdaccio.ts

# Publish canonical timestamped package set with landed-source/ref proof
publish-canonical:
    bun scripts/publish-local-verdaccio.ts --channel canonical

# Validate canonical timestamped package set without publishing
publish-canonical-dry-run:
    bun scripts/publish-local-verdaccio.ts --channel canonical --dry-run

# Validate timestamped dev package set without publishing
publish-dev-dry-run:
    bun scripts/publish-local-verdaccio.ts --dry-run

# Publish isolated worktree package set to local Verdaccio
publish-worktree:
    bun scripts/publish-local-verdaccio.ts --channel worktree

# Validate isolated worktree package set without publishing
publish-worktree-dry-run:
    bun scripts/publish-local-verdaccio.ts --channel worktree --dry-run

# Publish exact semver package set to local Verdaccio
publish-semver version tag="latest" force="":
    bun scripts/publish-local-verdaccio.ts --version "{{version}}" --tag "{{tag}}" {{force}}

# Validate exact semver package set without publishing
publish-semver-dry-run version tag="latest":
    bun scripts/publish-local-verdaccio.ts --version "{{version}}" --tag "{{tag}}" --dry-run

# Serve the ACP Session Dashboard (acp-ops-web) against the local dev stack
serve-dashboard:
    cd packages/acp-ops-web && bun run dev

# Run control-plane interface test with rex-home target
cp-test prompt="List skills available. Use only what is in your context, no tools.":
    ASP_HOME=/Users/lherron/praesidium/var/spaces-repo bun scripts/cp-interface-test.ts \
        --target default \
        --target-dir /Users/lherron/praesidium/rex-home \
        --model claude/sonnet \
        "{{prompt}}"
