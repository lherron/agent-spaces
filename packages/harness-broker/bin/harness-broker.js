#!/usr/bin/env bun
// WHY: `src` is not published (see `files` in package.json), so a bare
// `import '../src/cli.ts'` yields an installed binary that cannot start.
// Probe for src first so worktree edits stay live, and fall back to dist in
// the published tarball where src is absent. Mirrors packages/cli/bin/asp.js.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const distPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const preferDist = process.env.HARNESS_BROKER_USE_DIST === '1'
const entryPath =
  !preferDist && existsSync(srcPath) ? srcPath : existsSync(distPath) ? distPath : srcPath

await import(pathToFileURL(entryPath).href)
