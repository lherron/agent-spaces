/**
 * Hermetic-environment helpers for the integration suite.
 *
 * WHY: two host dependencies made this suite unrunnable on a clean machine and
 * misleading on a praesidium node (T-07685 buckets 1 and 2, 27 of 51 reds).
 *
 * 1. Every path that resolves a target reaches `ensureImmutableRegistry`, which
 *    clones `PORTABLE_SPACES_REGISTRY.canonicalRemote` into `<ASP_HOME>/sources`
 *    when the mirror is absent. `scripts/run-tests-no-git-clone.ts` forbids
 *    clones during tests, so the suite failed on the network reach rather than
 *    on anything under test. {@link seedImmutableRegistryMirror} pre-places the
 *    mirror -- which is also its steady state in production -- so the product
 *    finds it already there.
 *
 * 2. `getAgentsRoot` falls back to `$HOME/praesidium/var/agents` when that
 *    directory exists, so on any praesidium node the CLI read the operator's
 *    real agent homes and resolved test *target* names against them: green in
 *    CI, red on every dev box. {@link hermeticAgentsRoot} pins that lookup at an
 *    empty per-process temp root.
 *
 * The seeded mirror is deliberately EMPTY of spaces: a test that needs registry
 * content still fails loudly on the content it is missing rather than being
 * quietly satisfied by a fixture the product would never have produced.
 */

import { afterAll, beforeAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PORTABLE_SPACES_REGISTRY, PathResolver } from 'spaces-config'

let agentsRoot: string | undefined

/**
 * Empty agents root to pin into every test environment.
 *
 * Keeps `getAgentsRoot` off the operator's real `~/praesidium/var/agents`.
 *
 * A temp directory rather than a committed fixture because the CLI WRITES here:
 * `asp run <target>` materializes `<agentsRoot>/<target>/var/{cache,state,logs}`.
 * That write into the operator's tree is half of what the pin exists to stop, so
 * aiming it at an in-repo fixture would only relocate the mess into git.
 */
export function hermeticAgentsRoot(): string {
  if (agentsRoot === undefined) {
    agentsRoot = mkdtempSync(join(tmpdir(), 'asp-agents-root-'))
  }
  return agentsRoot
}

const DEFAULT_BRANCH = PORTABLE_SPACES_REGISTRY.defaultBranch ?? 'main'

let mirrorTemplate: string | undefined

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/**
 * Build, once per process, the template that every test ASP_HOME gets a copy of.
 *
 * The mirror must satisfy two product checks at once, which is why it is not
 * simply a local repo:
 *
 * - `ensureImmutableSourceMirror` rejects a mirror whose `origin` fetch URL is
 *   not the canonical remote, so `origin` really is `git@github.com:...`.
 * - `asp install` (unlike the run/compile paths, which all pass `fetch: false`)
 *   asks for `git fetch origin`. A repo-local `core.sshCommand` points that
 *   fetch at a local upstream, so the canonical URL never leaves the machine.
 *
 * `url.<local>.insteadOf` would be the obvious rewrite, but `git remote -v` --
 * which is what `listRemotes` reads -- reports the *rewritten* URL, so it
 * fails the origin check. `core.sshCommand` swaps the transport instead of the
 * URL, leaving the origin genuinely canonical.
 */
function buildMirrorTemplate(): string {
  if (mirrorTemplate) return mirrorTemplate

  const base = mkdtempSync(join(tmpdir(), 'asp-immutable-mirror-'))
  const upstream = join(base, 'upstream')
  const mirror = join(base, 'mirror')
  const sshShim = join(base, 'ssh-shim')

  mkdirSync(upstream, { recursive: true })
  git(['init', '-b', DEFAULT_BRANCH], upstream)
  git(['config', 'user.email', 'test@example.com'], upstream)
  git(['config', 'user.name', 'Test User'], upstream)
  mkdirSync(join(upstream, 'spaces'), { recursive: true })
  writeFileSync(join(upstream, 'spaces', '.gitkeep'), '')
  git(['add', '-A'], upstream)
  git(['commit', '-m', 'hermetic empty immutable source'], upstream)

  // Answers the one request git makes over "ssh" -- git-upload-pack -- from the
  // local upstream, and refuses anything else loudly rather than reaching out.
  writeFileSync(
    sshShim,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    git-upload-pack*) exec git-upload-pack '${upstream}' ;;
  esac
done
echo "hermetic ssh shim: refusing non-fetch git transport: $*" >&2
exit 1
`,
    'utf8'
  )
  chmodSync(sshShim, 0o755)

  mkdirSync(mirror, { recursive: true })
  git(['init', '-b', DEFAULT_BRANCH], mirror)
  git(['config', 'user.email', 'test@example.com'], mirror)
  git(['config', 'user.name', 'Test User'], mirror)
  git(['config', 'core.sshCommand', sshShim], mirror)
  git(['remote', 'add', 'origin', PORTABLE_SPACES_REGISTRY.canonicalRemote], mirror)
  git(['fetch', 'origin', '--tags'], mirror)
  git(['checkout', '-B', DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`], mirror)

  mirrorTemplate = mirror
  return mirror
}

/**
 * Pre-place the node-local immutable-source mirror inside a test ASP_HOME.
 *
 * Must be called for every ASP_HOME the suite hands to the CLI, to
 * `spaces-execution`, or to the compiler, or the first target resolution
 * attempts a real clone and dies on the test Git guard.
 *
 * Idempotent. Returns the mirror path.
 */
export function seedImmutableRegistryMirror(aspHome: string): string {
  const mirror = new PathResolver({ aspHome }).immutableRepository(
    PORTABLE_SPACES_REGISTRY.repository
  )
  if (existsSync(mirror)) return mirror

  mkdirSync(join(aspHome, 'sources'), { recursive: true })
  cpSync(buildMirrorTemplate(), mirror, { recursive: true })
  return mirror
}

/**
 * Pin `ASP_AGENTS_ROOT` for the enclosing file, restoring it afterwards.
 *
 * Covers in-process calls into `spaces-config`/`spaces-execution` that read
 * `process.env` directly, plus any subprocess inheriting it. Save/restore keeps
 * the pin from leaking into the other test files sharing this Bun process.
 */
export function useHermeticAgentsRoot(): void {
  let previous: string | undefined

  beforeAll(() => {
    previous = process.env['ASP_AGENTS_ROOT']
    process.env['ASP_AGENTS_ROOT'] = hermeticAgentsRoot()
  })

  afterAll(() => {
    if (previous === undefined) {
      // Reflect.deleteProperty rather than `= undefined`: Bun unsets on that
      // assignment but Node stores the literal string "undefined", and this is
      // the repo idiom either way (drivers/harness-pi pi-adapter.test.ts).
      Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
    } else {
      process.env['ASP_AGENTS_ROOT'] = previous
    }
  })
}
