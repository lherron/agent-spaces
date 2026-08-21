#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import TOML from '@iarna/toml'

type Table = Record<string, unknown>

const ROSTER_SUFFIX = /-(nova|comet|pulsar|quasar|meteor|aurora|zenith|eclipse|orbit|cosmos)$/
const DELETED_HOME_NAMES = new Set(['labprimary', 'svcprimary'])

function table(value: unknown): Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : {}
}

function defined(entries: Array<[string, unknown]>): Table {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined))
}

function nonEmpty(value: Table): Table | undefined {
  return Object.keys(value).length === 0 ? undefined : value
}

function nestedWithout(source: Table, removed: ReadonlySet<string>): Table | undefined {
  return nonEmpty(Object.fromEntries(Object.entries(source).filter(([key]) => !removed.has(key))))
}

export function migrateAgentProfile(source: string, filePath = 'agent-profile.toml'): string {
  const parsed = table(TOML.parse(source))
  if (parsed['schemaVersion'] !== 2) {
    throw new Error(`${filePath}: expected schemaVersion = 2`)
  }

  const oldIdentity = table(parsed['identity'])
  const oldHarness = table(parsed['harnessDefaults'])
  const oldClaude = table(oldHarness['claude'])
  const oldCodex = table(oldHarness['codex'])
  const oldPlacement = table(parsed['placement'])
  const oldHomes = table(oldPlacement['task-defaults'])
  const harness = oldIdentity['harness']
  const codexHarness = harness === 'codex' || harness === 'codex-cli'
  const claudeHarness = harness === 'claude' || harness === 'claude-code' || harness === 'agent-sdk'

  const pins = Object.fromEntries(
    Object.entries(oldPlacement).filter(
      ([key]) => key !== 'default_home_node' && key !== 'task-defaults'
    )
  )
  const homes = Object.fromEntries(
    Object.entries(oldHomes).filter(
      ([key]) => !ROSTER_SUFFIX.test(key) && !DELETED_HOME_NAMES.has(key)
    )
  )

  const oldNode = oldPlacement['default_home_node']
  const model = codexHarness
    ? (oldCodex['model'] ?? oldHarness['model'])
    : claudeHarness
      ? (oldClaude['model'] ?? oldHarness['model'])
      : (oldHarness['model'] ?? oldCodex['model'] ?? oldClaude['model'])
  const provisioning = defined([
    ['harness', harness],
    ['model', model],
    ['reasoning', oldCodex['model_reasoning_effort']],
    ['node', oldNode === 'local' ? undefined : oldNode],
    ['yolo', oldHarness['yolo']],
    ['sandbox', oldHarness['sandboxMode'] ?? oldCodex['sandbox_mode']],
    ['approval', oldHarness['approvalPolicy'] ?? oldCodex['approval_policy']],
    ['remote', oldHarness['remote_control']],
    ['claude', nestedWithout(oldClaude, new Set(['model']))],
    [
      'codex',
      nestedWithout(
        oldCodex,
        new Set(['model', 'model_reasoning_effort', 'sandbox_mode', 'approval_policy'])
      ),
    ],
  ])

  const oldSpaces = table(parsed['spaces'])
  const oldInstructions = table(parsed['instructions'])
  const identity = defined([
    ['display', oldIdentity['display']],
    // The old descriptive identity.role is deliberately deleted. Only the old
    // default-scope slot survives into v3's reused identity.role name.
    ['role', oldIdentity['default_scope_role']],
  ])
  const spaces = defined([
    ['base', oldSpaces['base']],
    ['modes', oldSpaces['byMode']],
  ])
  const instructions = defined([
    ['template', oldInstructions['template']],
    ['base', oldInstructions['additionalBase']],
    ['modes', oldInstructions['byMode']],
  ])
  const placement = defined([
    ['pins', nonEmpty(pins)],
    ['homes', nonEmpty(homes)],
  ])

  const migrated = defined([
    ['version', 3],
    ['claims_task', parsed['claims_task']],
    ['priming', parsed['priming_prompt']],
    ['priming_file', parsed['priming_prompt_file']],
    ['identity', nonEmpty(identity)],
    ['provisioning', nonEmpty(provisioning)],
    ['spaces', nonEmpty(spaces)],
    ['instructions', nonEmpty(instructions)],
    ['session', parsed['session']],
    ['jobs', parsed['jobs']],
    ['targets', parsed['targets']],
    ['placement', nonEmpty(placement)],
  ])

  return TOML.stringify(migrated as TOML.JsonMap)
}

export function migrateTargets(source: string): string {
  const parsed = table(TOML.parse(source))
  const migratedTargets: Table = {}
  for (const [name, rawTarget] of Object.entries(table(parsed['targets']))) {
    const target = table(rawTarget)
    const oldClaude = table(target['claude'])
    const oldCodex = table(target['codex'])
    const oldProvisioning = table(target['provisioning'])
    const harness = oldProvisioning['harness'] ?? target['harness']
    const provisioning = defined([
      ['harness', harness],
      [
        'model',
        oldProvisioning['model'] ??
          (harness === 'codex' || harness === 'codex-cli'
            ? oldCodex['model']
            : (oldClaude['model'] ?? oldCodex['model'])),
      ],
      ['reasoning', oldProvisioning['reasoning'] ?? oldCodex['model_reasoning_effort']],
      ['node', oldProvisioning['node']],
      ['yolo', oldProvisioning['yolo'] ?? target['yolo']],
      ['sandbox', oldProvisioning['sandbox'] ?? oldCodex['sandbox_mode']],
      ['approval', oldProvisioning['approval'] ?? oldCodex['approval_policy']],
      ['remote', oldProvisioning['remote'] ?? target['remote_control']],
      ['claude', nestedWithout(oldClaude, new Set(['model']))],
      [
        'codex',
        nestedWithout(
          oldCodex,
          new Set(['model', 'model_reasoning_effort', 'sandbox_mode', 'approval_policy'])
        ),
      ],
    ])
    migratedTargets[name] = defined([
      ['description', target['description']],
      ['priming', target['priming'] ?? target['priming_prompt']],
      ['priming_append', target['priming_append'] ?? target['priming_prompt_append']],
      ['compose', target['compose']],
      ['compose_mode', target['compose_mode']],
      ['resolver', target['resolver']],
      ['provisioning', nonEmpty(provisioning)],
    ])
  }

  return TOML.stringify(
    defined([
      ['schema', parsed['schema']],
      ['agents-root', parsed['agents-root']],
      ['claude', parsed['claude']],
      ['codex', parsed['codex']],
      ['targets', migratedTargets],
    ]) as TOML.JsonMap
  )
}

function main(): void {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    throw new Error('usage: migrate-agent-profile-v3.ts <agent-profile.toml|asp-targets.toml>...')
  }
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    const migrated =
      basename(path) === 'agent-profile.toml'
        ? migrateAgentProfile(source, path)
        : basename(path) === 'asp-targets.toml'
          ? migrateTargets(source)
          : (() => {
              throw new Error(`${path}: unsupported filename`)
            })()
    writeFileSync(path, migrated)
    console.log(path)
  }
}

if (import.meta.main) main()
