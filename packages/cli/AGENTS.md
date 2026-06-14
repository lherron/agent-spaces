## Pack Smoke for `@lherron/agent-spaces`

The published CLI bundles its workspace deps. After packaging changes, verify
both shapes:

```bash
cd packages/cli
bun scripts/smoke-test-pack.ts
```

The smoke runs prepack explicitly (because `~/.npmrc` may have
`ignore-scripts=true`), packs with `npm pack --ignore-scripts`, installs the
tarball into a throwaway Bun project, and asserts every published subpath
entrypoint resolves and exports at least one symbol.
