import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification']
// Claude already launches a shell for the command. Reject known HRC markers
// in that shell before touching any installed file or starting another shell.
const command = [
  'case "${HARNESS_BROKER_INVOCATION_ID+x}${HARNESS_BROKER_RUNTIME_ID+x}${HARNESS_BROKER_CALLBACK_SOCKET+x}" in *x*) exit 0 ;; esac',
  'script="$HOME/.claude/hrc-desktop-hook/join.sh"',
  '[ -r "$script" ] || exit 0',
  'exec /bin/sh "$script"',
].join('; ')
const managedGroup = { hooks: [{ type: 'command', command }] }
const sources = join(import.meta.dir, 'claude-desktop-overlay')

type Container = ts.ObjectLiteralExpression | ts.ArrayLiteralExpression

function property(node: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  let value: ts.Expression | undefined
  for (const member of node.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      ts.isStringLiteral(member.name) &&
      member.name.text === key
    ) {
      value = member.initializer
    }
  }
  return value
}

function object(node: ts.Node | undefined, label: string): ts.ObjectLiteralExpression {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return node
}

// Use syntax offsets to append values without reserializing any user bytes.
function append(
  source: string,
  node: Container,
  values: string[],
  depth: number
): { offset: number; text: string } {
  const children = ts.isObjectLiteralExpression(node) ? node.properties : node.elements
  const last = children.at(-1)
  const indent = '  '.repeat(depth)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  return {
    offset: last?.end ?? node.getStart() + 1,
    text:
      (last ? ',' : '') +
      newline +
      indent +
      values.map((value) => value.replaceAll('\n', newline + indent)).join(`,${newline}${indent}`) +
      (last ? '' : newline + indent.slice(2)),
  }
}

function mergeSettings(source: string): string {
  const parsed = JSON.parse(source)
  const ast = ts.createSourceFile(
    'settings.json',
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JSON
  )
  const statement = ast.statements[0]
  const root = object(
    statement && ts.isExpressionStatement(statement) ? statement.expression : undefined,
    'settings.json'
  )
  const existingHooks = property(root, 'hooks')
  const hooks = existingHooks ? object(existingHooks, 'hooks') : undefined
  const edits: ReturnType<typeof append>[] = []
  const missingEvents: string[] = []
  const group = JSON.stringify(managedGroup, null, 2)

  for (const event of events) {
    const eventNode = hooks && property(hooks, event)
    if (!eventNode) {
      missingEvents.push(event)
      continue
    }
    if (!ts.isArrayLiteralExpression(eventNode)) throw new Error(`hooks.${event} must be an array`)
    const installed = parsed.hooks[event].some((entry: { hooks?: unknown }) => {
      if (!Array.isArray(entry?.hooks)) return false
      return entry.hooks.some((hook) => hook?.type === 'command' && hook.command === command)
    })
    if (!installed) edits.push(append(source, eventNode, [group], 3))
  }
  if (hooks && missingEvents.length) {
    edits.push(
      append(
        source,
        hooks,
        missingEvents.map((event) => `"${event}": ${JSON.stringify([managedGroup], null, 2)}`),
        2
      )
    )
  }
  if (!hooks) {
    const allHooks = Object.fromEntries(events.map((event) => [event, [managedGroup]]))
    edits.push(append(source, root, [`"hooks": ${JSON.stringify(allHooks, null, 2)}`], 1))
  }

  let merged = source
  for (const { offset, text } of edits.sort((left, right) => right.offset - left.offset)) {
    merged = merged.slice(0, offset) + text + merged.slice(offset)
  }
  return merged
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function replace(path: string, text: string, before: string | undefined, mode: number) {
  if (text === before) return false
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode, flag: 'wx' })
  try {
    if ((await readOptional(path)) !== before) throw new Error(`${path} changed during overlay`)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

async function overlayClaude(claudeHome: string): Promise<boolean> {
  const settingsPath = join(claudeHome, 'settings.json')
  const before = await readOptional(settingsPath)
  const after = mergeSettings(before ?? '{}\n')
  const settingsMode = before === undefined ? 0o600 : (await stat(settingsPath)).mode & 0o777

  // Standalone Node hook with the same project resolution as the joiner.
  const bundle = await Bun.build({
    entrypoints: [join(sources, 'join.ts')],
    target: 'node',
    conditions: ['bun'],
    format: 'esm',
  })
  const output = bundle.outputs[0]
  if (!bundle.success || !output) throw new Error('Could not bundle the Claude Desktop hook')

  const scriptPath = join(claudeHome, 'hrc-desktop-hook', 'join.sh')
  const modulePath = join(dirname(scriptPath), 'join.mjs')
  await mkdir(dirname(scriptPath), { recursive: true, mode: 0o700 })
  const moduleChanged = await replace(
    modulePath,
    await output.text(),
    await readOptional(modulePath),
    0o600
  )
  const scriptChanged = await replace(
    scriptPath,
    await readFile(join(sources, 'join.sh'), 'utf8'),
    await readOptional(scriptPath),
    0o600
  )
  const settingsChanged = await replace(settingsPath, after, before, settingsMode)
  return moduleChanged || scriptChanged || settingsChanged
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  try {
    if (args.length && (args.length !== 2 || args[0] !== '--to' || !args[1])) {
      throw new Error('Usage: just overlay-claude [--to <copy-of-claude-home>]')
    }
    const target = args[1] ? resolve(args[1]) : join(homedir(), '.claude')
    const changed = await overlayClaude(target)
    console.log(`Claude Desktop overlay ${changed ? 'updated' : 'unchanged'} in ${target}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
