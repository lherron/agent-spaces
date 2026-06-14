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

# Run linter
lint:
    bun run lint

# Attach-before-start live debugger for the real codex-cli-tmux broker path.
debug-codex-tmux-live *args:
    bun scripts/debug-codex-tmux-live.ts --broker-transport stdio {{args}}

# Attach-before-start live debugger over the long-lived broker IPC socket path.
debug-codex-tmux-live-ipc *args:
    bun scripts/debug-codex-tmux-live.ts --broker-transport ipc {{args}}

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

# Run all verification (check + lint + typecheck + test)
verify: check lint typecheck test

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

# Install dependencies
# Pass no-sync=1 to skip syncing downstream consumer repos (hrc-runtime, agent-control-plane).
# After `bun install`, the dependency graph forks:
#   build ─┬─→ publish-dev ─→ (hrc sync ∥ acp sync)
#          └─→ bun link
# bun link runs alongside publish+sync; the two downstream syncs run in parallel.
install no-sync="":
    #!/usr/bin/env bash
    set -euo pipefail
    bun run clean
    bun install
    bun run build

    # Fire bun link in the background — only depends on build, not publish.
    ( cd packages/cli && bun link 2>&1 | sed 's/^/[bun-link] /' ) &
    link_pid=$!

    # Publish must complete before downstream sync.
    just publish-dev

    if [ -z "{{ no-sync }}" ]; then
      ( cd ../hrc-runtime && bun run sync:asp && bun run build && just publish-dev ) 2>&1 | sed 's/^/[hrc-sync] /'
      ( cd ../agent-control-plane && bun run sync:asp ) 2>&1 | sed 's/^/[acp-sync] /'
    else
      echo "[install] skipping downstream sync (no-sync=1)"
    fi

    wait $link_pid

# Sync downstream consumer repos in parallel (hrc-runtime ∥ agent-control-plane).
# This is the only place ASP knows where its consumers live; it never appears in source.
sync-downstream:
    #!/usr/bin/env bash
    set -euo pipefail
    ( cd ../hrc-runtime && bun run sync:asp && bun run build && just publish-dev ) 2>&1 | sed 's/^/[hrc-sync] /'
    ( cd ../agent-control-plane && bun run sync:asp ) 2>&1 | sed 's/^/[acp-sync] /'

# Publish timestamped dev package set to local Verdaccio
publish-dev:
    bun scripts/publish-local-verdaccio.ts

# Validate timestamped dev package set without publishing
publish-dev-dry-run:
    bun scripts/publish-local-verdaccio.ts --dry-run

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
