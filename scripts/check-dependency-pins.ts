/**
 * Pinned-dependency agreement guard.
 *
 * The root package.json `overrides` block is this repo's pin table: an exact
 * version recorded there is the ONE version the whole workspace is allowed to
 * resolve. This guard makes every workspace manifest agree with it.
 *
 * WHY: a workspace member that declares a governed dependency with a floating
 * specifier ("latest", a caret, a dist-tag) does not merely widen the range —
 * bun resolves it separately and, when it lands on a different version than the
 * root, materialises a NESTED node_modules/<pkg> copy inside that package. TypeScript
 * resolves types from the nearest node_modules, so the nested copy SHADOWS the root
 * for every file in that package while the lockfile still shows one clean resolution.
 * That is how `@types/bun: "latest"` in harness/harness-broker floated to 1.4.0 over a
 * root pinned at 1.3.14 and made `bun run build` red on a clean tree in files no commit
 * had touched (T-07690; third recurrence after hrc-runtime C-15465 and T-07682).
 * `bun install --frozen-lockfile` reports "no changes" against such a tree, so the
 * lockfile cannot be the oracle here — the declarations have to be.
 *
 * Governed set is DERIVED, not hardcoded: whatever the root pins exactly in
 * `overrides` is governed, so adding a pin there extends this guard automatically.
 * Non-exact override entries (ranges, file:/workspace: redirects) are ignored —
 * they express intent other than "exactly this version".
 *
 * peerDependencies are deliberately NOT governed: a peer range is a compatibility
 * statement about the consumer's tree, not a resolution this workspace performs.
 */
import { readdir } from 'node:fs/promises'
import { defineGuard, runGuard } from './lib/boundary-guard/engine.ts'
import type { GuardContext, GuardDiagnostic } from './lib/boundary-guard/engine.ts'

const workspaceRoots = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']
const surfaceDirs = [...workspaceRoots, 'integration-tests']
const ignoredDirectories = ['.git', 'coverage', 'dist', 'node_modules', 'tmp']
const governedSections = ['dependencies', 'devDependencies'] as const

const rootManifest = 'package.json'
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

type PackageJson = {
  overrides?: unknown
  dependencies?: unknown
  devDependencies?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

/** The pin table: root `overrides` entries that name one exact version. */
function pinTable(rootContent: string): Map<string, string> {
  const overrides = asRecord((JSON.parse(rootContent) as PackageJson).overrides)
  const pins = new Map<string, string>()
  for (const [dependency, specifier] of Object.entries(overrides)) {
    if (typeof specifier === 'string' && exactVersion.test(specifier)) {
      pins.set(dependency, specifier)
    }
  }
  return pins
}

/**
 * Line of a dependency's declaration in its own manifest text. The guard reports
 * the manifest, so an approximate line would send the reader to the wrong key;
 * scanning the raw text keeps file:line clickable and exact.
 */
function declarationLine(content: string, dependency: string): number {
  const lines = content.split('\n')
  const key = `"${dependency}"`
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}:`))
  return index === -1 ? 1 : index + 1
}

function manifestPaths(ctx: GuardContext): string[] {
  const fromSurface = ctx.files.filter((file) => file.endsWith('/package.json'))
  return [rootManifest, ...fromSurface].sort()
}

async function detectUnpinnedDeclarations(ctx: GuardContext): Promise<GuardDiagnostic[]> {
  const rootContent = ctx.readFile(rootManifest)
  const pins = pinTable(rootContent)
  if (pins.size === 0) {
    return []
  }

  const diagnostics: GuardDiagnostic[] = []
  for (const manifest of manifestPaths(ctx)) {
    const content = ctx.readFile(manifest)
    const packageJson = JSON.parse(content) as PackageJson

    for (const section of governedSections) {
      for (const [dependency, specifier] of Object.entries(asRecord(packageJson[section]))) {
        const pinned = pins.get(dependency)
        if (pinned === undefined || specifier === pinned) {
          continue
        }

        diagnostics.push({
          location: { file: manifest, line: declarationLine(content, dependency) },
          ruleId: 'PINS:unpinned-governed-dependency',
          expected: `${manifest} declares '${dependency}' as "${pinned}", the exact version pinned in the root overrides`,
          got: `${section} declares '${dependency}' as "${specifier}"`,
          fix: `set "${dependency}": "${pinned}" in ${manifest}, then run \`bun install\` and \`just doctor\` to prune any nested copy already on disk`,
          why: 'a specifier that disagrees with the root pin resolves separately and installs a NESTED node_modules copy that shadows the root for that package only — types and runtime silently differ there while the lockfile still shows one resolution',
          exception:
            'to hold a different version deliberately, remove the dependency from the root overrides pin table so it is no longer governed, and record why',
          doNotSuppress:
            'Do not suppress, silence, disable, or vendor around this; make the specifier match the pin or ungovern the dependency.',
        })
      }
    }
  }

  return diagnostics.sort(
    (left, right) =>
      left.location.file.localeCompare(right.location.file) ||
      left.location.line - right.location.line
  )
}

export const guard = defineGuard({
  surface: {
    dirs: surfaceDirs,
    ignore: ignoredDirectories,
  },
  rules: [
    {
      id: 'PINS:unpinned-governed-dependency',
      kind: 'custom',
      detect: detectUnpinnedDeclarations,
    },
  ],
})

if (import.meta.main) {
  // Fail loudly rather than silently passing if the workspace roots move.
  for (const dir of surfaceDirs) {
    await readdir(dir)
  }

  const exitCode = await runGuard(guard)
  if (exitCode === 0) {
    console.log('Dependency pin check passed.')
  }
  process.exit(exitCode)
}
