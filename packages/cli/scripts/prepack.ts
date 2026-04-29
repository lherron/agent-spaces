// WHY: Bun's resolver refuses to walk up into nested node_modules for bare
// imports, so published workspace-bundled artifacts must carry fully relative
// specifiers. This script copies workspace dist output into ./node_modules/
// and rewrites every bare workspace import under bundled dirs, packages/cli/dist,
// and the root shim entrypoints to point at the bundled payload by relative path.

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = dirname(HERE)
const BUNDLED = join(CLI_ROOT, 'node_modules')

const WORKSPACES: Array<{ src: string; dest: string }> = [
  { src: '../config', dest: 'spaces-config' },
  { src: '../runtime', dest: 'spaces-runtime' },
  { src: '../harness-claude', dest: 'spaces-harness-claude' },
  { src: '../harness-pi', dest: 'spaces-harness-pi' },
  { src: '../harness-pi-sdk', dest: 'spaces-harness-pi-sdk' },
  { src: '../harness-codex', dest: 'spaces-harness-codex' },
  { src: '../execution', dest: 'spaces-execution' },
  { src: '../agent-spaces', dest: 'agent-spaces' },
  { src: '../agent-scope', dest: 'agent-scope' },
  { src: '../cli-kit', dest: 'cli-kit' },
]

const SPECIFIER_TARGETS: Record<string, string> = {
  'spaces-config': 'spaces-config/dist/index.js',
  'spaces-runtime': 'spaces-runtime/dist/index.js',
  'spaces-runtime/session': 'spaces-runtime/dist/session/index.js',
  'spaces-harness-claude': 'spaces-harness-claude/dist/index.js',
  'spaces-harness-claude/claude': 'spaces-harness-claude/dist/claude/index.js',
  'spaces-harness-claude/agent-sdk': 'spaces-harness-claude/dist/agent-sdk/index.js',
  'spaces-harness-codex': 'spaces-harness-codex/dist/index.js',
  'spaces-harness-codex/codex-session': 'spaces-harness-codex/dist/codex-session/index.js',
  'spaces-harness-pi': 'spaces-harness-pi/dist/index.js',
  'spaces-harness-pi-sdk': 'spaces-harness-pi-sdk/dist/index.js',
  'spaces-harness-pi-sdk/adapter': 'spaces-harness-pi-sdk/dist/adapters/pi-sdk-adapter.js',
  'spaces-harness-pi-sdk/pi-session': 'spaces-harness-pi-sdk/dist/pi-session/index.js',
  'spaces-execution': 'spaces-execution/dist/index.js',
  'agent-spaces': 'agent-spaces/dist/index.js',
  'agent-scope': 'agent-scope/dist/index.js',
  'cli-kit': 'cli-kit/dist/index.js',
}

const SHIMS = [
  'engine.js',
  'runtime.js',
  'core.js',
  'resolver.js',
  'store.js',
  'materializer.js',
  'git.js',
  'claude.js',
  'lint.js',
]

const BARE_IMPORT_RE =
  /((?:from|import)\s*['"])(spaces-[a-z][a-z-]*(?:\/[a-z][a-z-]*)?|agent-spaces|agent-scope|cli-kit)(['"])/g

async function copyWorkspaces() {
  for (const { src, dest } of WORKSPACES) {
    const destDir = join(BUNDLED, dest)
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })
    const srcDir = join(CLI_ROOT, src)
    await cp(join(srcDir, 'dist'), join(destDir, 'dist'), { recursive: true })
    await cp(join(srcDir, 'package.json'), join(destDir, 'package.json'))
  }
}

async function* walkJs(dir: string): AsyncGenerator<string> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJs(p)
    else if (entry.isFile() && p.endsWith('.js')) yield p
  }
}

function computeRelative(fromFile: string, spec: string): string | null {
  const target = SPECIFIER_TARGETS[spec]
  if (!target) return null
  const absTarget = join(BUNDLED, target)
  let rel = relative(dirname(fromFile), absTarget)
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel.split(sep).join('/')
}

async function rewriteFile(filePath: string) {
  const src = await readFile(filePath, 'utf8')
  let changed = false
  const out = src.replace(BARE_IMPORT_RE, (m, pre, spec, post) => {
    const rel = computeRelative(filePath, spec)
    if (!rel) return m
    changed = true
    return `${pre}${rel}${post}`
  })
  if (changed) await writeFile(filePath, out)
}

async function stripBunExportCondition() {
  // The `bun` export condition points at ./src/*.ts which is not shipped
  // (not in files) and would shadow `import` for Bun consumers. Drop it
  // so published consumers resolve to ./dist/*.js. Postpack reverts via git.
  // npm pack reads the manifest for the registry before prepack runs, so
  // dependency shape changes belong in the committed package.json, not here.
  const pkgPath = join(CLI_ROOT, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  if (pkg.exports) {
    for (const key of Object.keys(pkg.exports)) {
      const v = pkg.exports[key]
      if (v && typeof v === 'object' && 'bun' in v) {
        const { bun: _, ...rest } = v
        pkg.exports[key] = rest
      }
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

async function main() {
  await copyWorkspaces()

  for (const { dest } of WORKSPACES) {
    for await (const f of walkJs(join(BUNDLED, dest, 'dist'))) {
      await rewriteFile(f)
    }
  }
  for await (const f of walkJs(join(CLI_ROOT, 'dist'))) await rewriteFile(f)
  for (const shim of SHIMS) await rewriteFile(join(CLI_ROOT, shim))

  await stripBunExportCondition()
}

await main()
