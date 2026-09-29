/**
 * Structural MSP schema gate tests (T-09879).
 *
 * Real exports from four muse releases must pass. Each synthetic mutation of
 * the 1.4.1 export must refuse with one specific reason. The real
 * 1.4.0→1.4.1 drift must yield exactly one warning and no refusal.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMuseTurnStartParams } from './input'
import { buildMuseApprovalDecideParams } from './permissions'
import {
  MUSE_LAST_VERIFIED_SCHEMA,
  checkMuseSchemaCompatibility,
  describeMuseSchemaDrift,
  gateMuseSchema,
} from './schema-compat'
import { MUSE_DRIVER_SCHEMA_SURFACE } from './schema-surface'

const fixtures = join(import.meta.dir, '../../../test/fixtures/muse-schema')

type Json = Record<string, any>

function loadExport(version: string): { fingerprint: string; schema: Json } {
  const schema = JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(readFileSync(join(fixtures, `msp-${version}.schema.json.gz`)))
    )
  ) as Json
  const manifest = JSON.parse(
    readFileSync(join(fixtures, `msp-${version}.manifest.json`), 'utf8')
  ) as Json
  return { fingerprint: manifest['fingerprint'] as string, schema }
}

const RELEASES = ['1.3.0-R3233.1', '1.3.0-R3401.1', '1.4.0-R4302.1', '1.4.1-R4503.1']

const mutated = (edit: (schema: Json) => void): Json => {
  const schema = structuredClone(loadExport('1.4.1-R4503.1').schema)
  edit(schema)
  return schema
}

describe('real exports', () => {
  for (const version of RELEASES) {
    test(`muse ${version} is compatible with the driver-used surface`, () => {
      expect(checkMuseSchemaCompatibility(loadExport(version).schema)).toEqual([])
    })
  }

  test('the last-verified constant is the committed 1.4.1 export fingerprint', () => {
    expect(loadExport('1.4.1-R4503.1').fingerprint).toBe(MUSE_LAST_VERIFIED_SCHEMA.fingerprint)
  })
})

describe('mutations of the 1.4.1 export refuse with a specific reason', () => {
  const cases: Array<[string, (schema: Json) => void, string | string[]]> = [
    [
      'M1 driver-used method removed',
      (s) => Reflect.deleteProperty(s['methods'], 'turn/start'),
      'method turn/start was removed (the driver calls it)',
    ],
    [
      'M2a new required param on turn/start',
      (s) => {
        s['$defs']['TurnStartParams']['properties']['priority'] = { type: 'string' }
        s['$defs']['TurnStartParams']['required'].push('priority')
      },
      'turn/start params: new required field priority (the driver does not send it)',
    ],
    [
      'M2b optional turn/start param becomes required',
      (s) => s['$defs']['TurnStartParams']['required'].push('workspaceRoots'),
      'turn/start params: new required field workspaceRoots (the driver does not send it)',
    ],
    [
      'M3 read field retyped',
      (s) => {
        s['$defs']['TurnStartResult']['properties']['turnId'] = { type: 'integer' }
      },
      'turn/start result: turnId changed type to integer (the driver reads string)',
    ],
    [
      'M4 handled notification removed',
      (s) => Reflect.deleteProperty(s['notifications'], 'turn/completed'),
      'notification turn/completed was removed (the driver handles it)',
    ],
    [
      'M5 depended enum value removed',
      (s) => {
        s['$defs']['TurnTerminal']['enum'] = ['completed', 'failed']
      },
      "turn/completed params: terminal no longer allows 'cancelled' (the driver branches on it)",
    ],
    [
      'M6 read field removed',
      (s) => Reflect.deleteProperty(s['$defs']['TurnCompletedParams']['properties'], 'terminal'),
      'turn/completed params: terminal was removed (the driver reads it)',
    ],
    [
      'M7 sent field removed',
      (s) =>
        Reflect.deleteProperty(s['$defs']['SessionStartParams']['properties'], 'workspaceRoot'),
      'session/start params: workspaceRoot was removed (the driver sends it)',
    ],
    [
      'M8 answered server request removed',
      (s) => Reflect.deleteProperty(s['requests'], 'approval/request'),
      'server request approval/request was removed (the driver answers it)',
    ],
    [
      'M9 sent enum value removed',
      (s) => {
        s['$defs']['TurnInputPartType']['enum'] = ['text', 'skill']
      },
      // turn/start and turn/steer both send input parts.
      [
        "turn/start params: input[].type no longer allows 'image' (the driver sends it)",
        "turn/steer params: input[].type no longer allows 'image' (the driver sends it)",
      ],
    ],
    [
      'M10 nested sent object gains a required field',
      (s) => s['$defs']['ClientInfo']['required'].push('title'),
      'initialize params: new required field clientInfo.title (the driver does not send it)',
    ],
    [
      'M11 read retyped through a $ref',
      (s) => {
        s['$defs']['Session']['properties']['sessionId'] = { type: 'integer' }
      },
      // session/start and session/resume both read the Session def.
      [
        'session/start result: session.sessionId changed type to integer (the driver reads string)',
        'session/resume result: session.sessionId changed type to integer (the driver reads string)',
      ],
    ],
  ]

  for (const [name, edit, expected] of cases) {
    test(name, async () => {
      const schema = mutated(edit)
      const reasons = Array.isArray(expected) ? expected : [expected]
      expect(checkMuseSchemaCompatibility(schema)).toEqual(reasons)
      await expect(
        gateMuseSchema('sha256:mutated', async () => ({ fingerprint: 'sha256:mutated', schema }))
      ).rejects.toThrow(reasons.join('; '))
    })
  }
})

describe('additive drift only warns', () => {
  const additive: Array<[string, (schema: Json) => void]> = [
    [
      'new optional param on turn/start',
      (s) => {
        s['$defs']['TurnStartParams']['properties']['priority'] = { type: 'string' }
      },
    ],
    [
      'new method',
      (s) => {
        s['methods']['session/teleport'] = { params: { type: 'object', properties: {} } }
      },
    ],
    [
      'new notification',
      (s) => {
        s['notifications']['session/teleported'] = { params: { type: 'object', properties: {} } }
      },
    ],
    [
      'description text change',
      (s) => {
        s['$defs']['TurnStartParams']['properties']['sessionId']['description'] = 'reworded'
      },
    ],
    [
      'new optional field on a read shape',
      (s) => {
        s['$defs']['TurnCompletedParams']['properties']['costUsd'] = { type: 'number' }
      },
    ],
    ['new value on an open enum', (s) => s['$defs']['TurnTerminal']['enum'].push('abandoned')],
  ]
  for (const [name, edit] of additive) {
    test(name, () => {
      expect(checkMuseSchemaCompatibility(mutated(edit))).toEqual([])
    })
  }

  test('a new notification is named in the drift warning', () => {
    const schema = mutated((s) => {
      s['notifications']['session/teleported'] = { params: { type: 'object', properties: {} } }
    })
    expect(describeMuseSchemaDrift(schema, 'sha256:new')).toContain(
      'Notifications the driver does not classify: session/teleported.'
    )
  })
})

describe('gateMuseSchema', () => {
  const v140 = loadExport('1.4.0-R4302.1')
  const v141 = loadExport('1.4.1-R4503.1')

  test('the real 1.4.0 → 1.4.1 drift yields exactly one warning and no refusal', async () => {
    let exports = 0
    const outcome = await gateMuseSchema(
      v141.fingerprint,
      async () => {
        exports += 1
        return v141
      },
      { fingerprint: v140.fingerprint, museVersion: '1.4.0-R4302.1' }
    )
    expect(exports).toBe(1)
    expect(outcome.kind).toBe('compatible-drift')
    const warnings = outcome.kind === 'compatible-drift' ? [outcome.warning] : []
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(v141.fingerprint)
    expect(warnings[0]).toContain(v140.fingerprint)
    expect(warnings[0]).not.toContain('does not classify')
  })

  test('the last-verified fingerprint passes without exporting', async () => {
    const outcome = await gateMuseSchema(v141.fingerprint, async () => {
      throw new Error('export must not run')
    })
    expect(outcome).toEqual({ kind: 'last-verified' })
  })

  test('an older compatible release passes with a warning', async () => {
    const outcome = await gateMuseSchema(v140.fingerprint, async () => v140)
    expect(outcome.kind).toBe('compatible-drift')
  })

  test('an absent served fingerprint refuses', async () => {
    await expect(gateMuseSchema(undefined, async () => v141)).rejects.toThrow(
      'carries no schema fingerprint'
    )
  })

  test('a failing export refuses as unverifiable', async () => {
    await expect(
      gateMuseSchema('sha256:new', async () => {
        throw new Error('schema export exited 2')
      })
    ).rejects.toThrow('muse-serve cannot verify schema sha256:new: schema export exited 2')
  })

  test('an export from a different binary refuses', async () => {
    await expect(gateMuseSchema('sha256:served', async () => v141)).rejects.toThrow(
      `muse-serve schema export fingerprint ${v141.fingerprint} does not match the served sha256:served`
    )
  })

  test('a malformed export refuses', async () => {
    await expect(
      gateMuseSchema('sha256:junk', async () => ({ fingerprint: 'sha256:junk', schema: [] }))
    ).rejects.toThrow('export is not an MSP schema bundle')
  })
})

describe('declared sends match what the builders put on the wire', () => {
  const declared = (method: string): Set<string> =>
    new Set(
      Object.keys(MUSE_DRIVER_SCHEMA_SURFACE.methods[method]?.sends.fields ?? {}).filter(
        (path) => !path.includes('.') && !path.includes('[')
      )
    )
  const declaredPartFields = new Set(
    Object.keys(MUSE_DRIVER_SCHEMA_SURFACE.methods['turn/start']?.sends.fields ?? {})
      .filter((path) => path.startsWith('input[].'))
      .map((path) => path.slice('input[].'.length))
  )

  test('turn/start params', async () => {
    const params = await buildMuseTurnStartParams({
      commandId: 'c',
      sessionId: 's',
      reasoningEffort: 'high',
      input: {
        inputId: 'in_1' as never,
        kind: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'file_ref', path: 'a.ts' },
        ],
      },
    })
    for (const key of Object.keys(params)) expect(declared('turn/start')).toContain(key)
    for (const part of params['input'] as Array<Record<string, unknown>>) {
      for (const key of Object.keys(part)) expect(declaredPartFields).toContain(key)
    }
  })

  test('approval/decide params', () => {
    const params = buildMuseApprovalDecideParams(
      {
        approvalId: 'a',
        availableChoices: [],
        sessionId: 's',
        currentRequirementId: { approvalId: 'a', sourceIndex: 0 },
      },
      { choiceId: 'c' }
    )
    expect(new Set(Object.keys(params))).toEqual(declared('approval/decide'))
  })
})
