import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncAgentToCodexDefault } from './sync-agent-to-codex-default'

/**
 * T-08522 §3: what the Arris resident is told about answering mail.
 *
 * HRC's injected presentation ends with a line of this exact shape:
 *
 *   reply: wrkc say EN-12576 --to mable@arris:primary - <<'HEREDOC'
 *
 * Two facts follow, both checked against a real presented envelope by arris
 * T-08521 rather than assumed. The `EN-` id IS reachable from that line, so the
 * capability's required `envelope_id` is satisfiable through the ordinary
 * delivery path. And the line instructs a shell command the resident cannot
 * run: the host scrubs `ASP_*`/`HRC_*`/`WRKQ*`/`WRKC*` out of the environment
 * its children inherit, and declines an approval naming any ledger or runtime
 * client. So the overlay has to OVERRIDE a concrete instruction it is handed
 * every turn, not offer an alternative beside it.
 *
 * It also has to name the tool the way the model sees it. The capability id is
 * `arris.mail.reply`, but the dynamic-tool projection strips `arris.<ns>.`, so
 * the model is offered a `reply` tool in a `mail` namespace. A sentence naming
 * only `arris.mail.reply` names something absent from the model's tool list.
 *
 * This asserts the RENDERED overlay -- the managed block the sync script writes
 * into the Codex home -- not the source file. A sentence that is present in
 * `RESIDENT.md` but dropped on the way through the template is not priming.
 */
const MANDATED_SENTENCE =
  'Presented mail is answered with the `reply` tool in the `mail` namespace ' +
  '(capability `arris.mail.reply`), passing the `EN-xxxxx` id from the injected ' +
  '`reply:` line as `envelope_id`. The `wrkc say` shell command in that line is ' +
  'not available to you, and ending the turn is not a reply. If no `mail` ' +
  'namespace is offered, the host has no ledger identity configured: say so and ' +
  'stop; do not look for another way to send.'

const agentsRoot = process.env['ASP_AGENTS_ROOT'] ?? join(homedir(), 'praesidium/var/agents')
const agentsRootPresent = existsSync(join(agentsRoot, 'spaces'))

const originalAspHome = process.env['ASP_HOME']
afterEach(() => {
  process.env['ASP_HOME'] = originalAspHome
})

/**
 * Skipped only where the shared agents source is not checked out at all -- a
 * clone of this repository alone. Where it IS present, a missing `arris` agent
 * is a failure, not a skip: the overlay this asserts would be broken.
 */
describe.skipIf(!agentsRootPresent)('the Arris resident overlay priming', () => {
  let rendered = ''
  let root = ''

  beforeAll(async () => {
    expect(existsSync(join(agentsRoot, 'arris', 'agent-profile.toml'))).toBe(true)
    root = await mkdtemp(join(tmpdir(), 'arris-priming-overlay-'))
    const codexHome = join(root, 'codex-home')
    await syncAgentToCodexDefault({
      agentId: 'arris',
      codexHome,
      aspHome: join(root, 'asp-home'),
      agentsRoot,
      projectRoot: join(homedir(), 'praesidium'),
      apply: true,
      fetchRegistry: false,
      installHooks: false,
    })
    rendered = await readFile(join(codexHome, 'AGENTS.md'), 'utf8')
  })

  afterAll(async () => {
    if (root.length === 0) return
    await rm(root, { recursive: true, force: true })
  })

  test('renders the mandated sentence verbatim', () => {
    expect(rendered).toContain(MANDATED_SENTENCE)
  })

  /**
   * The bar is "no `wrkc say` COMMAND lines", not "the string never appears":
   * the mandated sentence names the command in order to forbid it, and the
   * shared `AGENT_MOTD.md` -- untouched on purpose, since it is what the
   * sentence overrides -- mentions it in prose. Both write it as inline code.
   * A command line does not: it is followed by an argument.
   */
  test('leaves no wrkc say command line for the resident to run', () => {
    const commandForm = /wrkc say(?!`)/g
    const offenders = [...rendered.matchAll(commandForm)].map((match) =>
      rendered.slice(match.index, match.index + 60)
    )
    expect(offenders).toEqual([])
  })

  test('drops the wrkq and wrkc guides, which are pages of shell recipes', () => {
    // Recipe markers unique to the injected `wrkq info` / `wrkc info` output.
    expect(rendered).not.toContain('wrkq touch')
    expect(rendered).not.toContain('wrkc inbox')
    expect(rendered).not.toContain('task_tracking_rules')
    expect(rendered).not.toContain('wrkc agent guide')
  })

  /**
   * The sentence overrides the shared platform preamble; it does not replace
   * it. If this ever fails, someone edited `AGENT_MOTD.md` -- which every other
   * agent also renders -- instead of the Arris agent source.
   */
  test('overrides the shared platform mail prose rather than editing it', () => {
    expect(rendered).toContain('Answer addressed mail through')
    const sentenceAt = rendered.indexOf(MANDATED_SENTENCE)
    expect(sentenceAt).toBeGreaterThan(rendered.indexOf('Answer addressed mail through'))
  })

  test('keeps the rest of the resident priming intact', () => {
    expect(rendered).toContain('arris.document.save')
    expect(rendered).toContain('arris.mutation.apply_batch')
  })
})
