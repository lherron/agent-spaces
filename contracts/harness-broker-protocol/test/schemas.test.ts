import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { conservativeDefaultLifecyclePolicyOverlay } from '../src/lifecycle'
import {
  validateInvocationInput,
  validateInvocationSpec,
  validateInvocationStartRequest,
} from '../src/schemas'
import {
  arrisResidentSpec,
  expectInvalidInput,
  expectInvalidInputPath,
  expectInvalidSpec,
  expectInvalidStartRequest,
  piSdkSpec,
  specSection19InvocationStartSpec,
  specSection62Example,
} from './schema-test-helpers'

describe('validateInvocationSpec', () => {
  test('accepts the Codex app-server example from spec section 6.2', () => {
    expect(validateInvocationSpec(specSection62Example)).toEqual(specSection62Example)
  })

  test('accepts the invocation.start spec from the minimal end-to-end example', () => {
    expect(validateInvocationSpec(specSection19InvocationStartSpec)).toEqual(
      specSection19InvocationStartSpec
    )
  })

  test('accepts the muse-serve start-fresh fixture (T-08588)', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'src', 'fixtures', 'muse-serve', 'start-fresh.spec.json'),
        'utf-8'
      )
    )
    expect(validateInvocationSpec(fixture)).toEqual(fixture)
  })

  test('rejects a muse-serve approvalMode outside the MSP closed enum', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'src', 'fixtures', 'muse-serve', 'start-fresh.spec.json'),
        'utf-8'
      )
    )
    const invalid = structuredClone(fixture)
    invalid.driver.approvalMode = 'never'

    expectInvalidSpec(invalid, {
      path: 'driver.approvalMode',
      code: 'invalid_literal',
    })
  })

  test('rejects a mismatched harness.driver and muse-serve driver.kind', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'src', 'fixtures', 'muse-serve', 'start-fresh.spec.json'),
        'utf-8'
      )
    )
    const invalid = structuredClone(fixture)
    invalid.harness.driver = 'codex-app-server'

    expectInvalidSpec(invalid, {
      path: 'harness.driver',
      code: 'invalid_driver',
    })
  })

  test('rejects a spec missing process.command with a stable validation code', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.process, 'command')

    expectInvalidSpec(invalid, {
      path: 'process.command',
      code: 'required',
    })
  })

  test('rejects a mismatched harness.driver and driver.kind', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.harness.driver = 'pi-cli'

    expectInvalidSpec(invalid, {
      path: 'harness.driver',
      code: 'invalid_driver',
    })
  })

  test('rejects env keys that cannot be passed to spawn safely', () => {
    const invalidWithEquals = structuredClone(specSection62Example)
    invalidWithEquals.process.lockedEnv['BAD=KEY'] = 'value'
    expectInvalidSpec(invalidWithEquals, {
      path: 'process.lockedEnv.BAD=KEY',
      code: 'invalid_env_key',
    })

    const invalidWithNull = structuredClone(specSection62Example)
    invalidWithNull.process.lockedEnv['BAD\u0000KEY'] = 'value'
    expectInvalidSpec(invalidWithNull, {
      path: 'process.lockedEnv.BAD\u0000KEY',
      code: 'invalid_env_key',
    })
  })

  test('rejects lockedEnv keys from ambient, credential, and reserved classes', () => {
    const ambient = structuredClone(specSection62Example)
    ambient.process.lockedEnv.HOME = '/Users/lherron'
    expectInvalidSpec(ambient, {
      path: 'process.lockedEnv.HOME',
      code: 'ambient_env_key',
    })

    const credential = structuredClone(specSection62Example)
    credential.process.lockedEnv.OPENAI_API_KEY = 'sk-test'
    expectInvalidSpec(credential, {
      path: 'process.lockedEnv.OPENAI_API_KEY',
      code: 'credential_env_key',
    })

    const reserved = structuredClone(specSection62Example)
    reserved.process.lockedEnv.NODE_OPTIONS = '--inspect'
    expectInvalidSpec(reserved, {
      path: 'process.lockedEnv.NODE_OPTIONS',
      code: 'reserved_env_key',
    })
  })

  test('accepts process.pathPrepend as an array of strings', () => {
    const valid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: string[] }
    }
    valid.process.pathPrepend = ['/agent/tools/bin', '/opt/bin']
    expect(validateInvocationSpec(valid)).toEqual(valid)
  })

  test('rejects process.pathPrepend that is not an array', () => {
    const invalid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: unknown }
    }
    invalid.process.pathPrepend = '/agent/tools/bin'
    expectInvalidSpec(invalid, {
      path: 'process.pathPrepend',
      code: 'invalid_type',
    })
  })

  test('rejects process.pathPrepend entries that are not strings', () => {
    const invalid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: unknown[] }
    }
    invalid.process.pathPrepend = ['/agent/tools/bin', 42]
    expectInvalidSpec(invalid, {
      path: 'process.pathPrepend.1',
      code: 'invalid_type',
    })
  })

  test('rejects unsupported specVersion literals', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.specVersion = 'harness-broker.invocation/v2'

    expectInvalidSpec(invalid, {
      path: 'specVersion',
      code: 'invalid_literal',
    })
  })

  test('rejects unsupported driver permission default decisions', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.driver.permissionPolicy = {
      mode: 'ask-client',
      defaultDecision: 'prompt',
    }

    expectInvalidSpec(invalid, {
      path: 'driver.permissionPolicy.defaultDecision',
      code: 'invalid_literal',
    })
  })

  test('reports required (not invalid_literal) for missing harnessTransport.kind', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.process.harnessTransport, 'kind')

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'required',
    })
  })

  test('reports invalid_literal for unsupported harnessTransport.kind', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.process.harnessTransport.kind = 'websocket'

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'invalid_literal',
    })
  })

  test('reports required (not invalid_literal) for missing interaction.mode', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.interaction, 'mode')

    expectInvalidSpec(invalid, {
      path: 'interaction.mode',
      code: 'required',
    })
  })

  test('reports invalid_literal for unsupported interaction.mode', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.interaction.mode = 'batch'

    expectInvalidSpec(invalid, {
      path: 'interaction.mode',
      code: 'invalid_literal',
    })
  })

  test('reports invalid_literal for unsupported interaction.inputQueue', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.interaction.inputQueue = 'lifo'

    expectInvalidSpec(invalid, {
      path: 'interaction.inputQueue',
      code: 'invalid_literal',
    })
  })

  test('accepts spec with optional interaction.inputQueue omitted', () => {
    const valid = structuredClone(specSection62Example)
    Reflect.deleteProperty(valid.interaction, 'inputQueue')

    expect(() => validateInvocationSpec(valid)).not.toThrow()
  })

  test.each([
    ['with thinkingLevel', piSdkSpec],
    [
      'without thinkingLevel',
      (() => {
        const spec = structuredClone(piSdkSpec)
        Reflect.deleteProperty(spec.sdk, 'thinkingLevel')
        return spec
      })(),
    ],
  ])('accepts a pi-sdk in-process spec %s', (_name, spec) => {
    expect(validateInvocationSpec(spec)).toEqual(spec)
  })

  test.each([
    [
      'process block',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec, 'process'),
      { path: 'process', code: 'required' },
    ],
    [
      'sdk block',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec, 'sdk'),
      { path: 'sdk', code: 'required' },
    ],
    [
      'in-process transport',
      (spec: typeof piSdkSpec) => {
        spec.process.harnessTransport.kind = 'pipes'
      },
      { path: 'process.harnessTransport.kind', code: 'invalid_literal' },
    ],
    [
      'command sentinel',
      (spec: typeof piSdkSpec) => {
        spec.process.command = 'pi'
      },
      { path: 'process.command', code: 'invalid_literal' },
    ],
    [
      'empty args',
      (spec: typeof piSdkSpec) => {
        spec.process.args = ['--print']
      },
      { path: 'process.args', code: 'invalid_literal' },
    ],
  ])('rejects a pi-sdk spec without the required %s', (_name, mutate, expectedIssue) => {
    const invalid = structuredClone(piSdkSpec)
    mutate(invalid)
    expectInvalidSpec(invalid, expectedIssue)
  })

  test.each([
    [
      'runtime literal',
      (spec: typeof piSdkSpec) => {
        spec.sdk.runtime = 'other-sdk'
      },
      { path: 'sdk.runtime', code: 'invalid_literal' },
    ],
    [
      'provider',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec.sdk, 'provider'),
      { path: 'sdk.provider', code: 'required' },
    ],
    [
      'modelId',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec.sdk, 'modelId'),
      { path: 'sdk.modelId', code: 'required' },
    ],
    [
      'authMode',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec.sdk, 'authMode'),
      { path: 'sdk.authMode', code: 'required' },
    ],
    [
      'authMode literal',
      (spec: typeof piSdkSpec) => {
        spec.sdk.authMode = 'ambient'
      },
      { path: 'sdk.authMode', code: 'invalid_literal' },
    ],
    [
      'thinkingLevel type',
      (spec: typeof piSdkSpec) => {
        spec.sdk.thinkingLevel = 42
      },
      { path: 'sdk.thinkingLevel', code: 'invalid_type' },
    ],
  ])('rejects a pi-sdk spec with invalid %s', (_name, mutate, expectedIssue) => {
    const invalid = structuredClone(piSdkSpec)
    mutate(invalid)
    expectInvalidSpec(invalid, expectedIssue)
  })

  test('rejects an sdk block for another driver', () => {
    const invalid = structuredClone(specSection62Example) as typeof specSection62Example & {
      sdk?: typeof piSdkSpec.sdk
    }
    invalid.sdk = structuredClone(piSdkSpec.sdk)

    expectInvalidSpec(invalid, { path: 'sdk', code: 'forbidden' })
  })

  test('rejects in-process transport for another driver', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.process.harnessTransport.kind = 'in-process'

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'forbidden',
    })
  })

  test('accepts an arris-resident in-process spec with no sdk block', () => {
    expect(validateInvocationSpec(arrisResidentSpec)).toEqual(arrisResidentSpec)
  })

  test('still forbids an sdk block on the arris-resident driver', () => {
    const invalid = structuredClone(arrisResidentSpec) as typeof arrisResidentSpec & {
      sdk?: typeof piSdkSpec.sdk
    }
    invalid.sdk = structuredClone(piSdkSpec.sdk)

    expectInvalidSpec(invalid, { path: 'sdk', code: 'forbidden' })
  })

  test.each([
    ['codex-app-server', 'codex-app-server'],
    ['noop-driver', 'noop-driver'],
    ['an unknown driver', 'totally-unknown-driver'],
  ])('still rejects in-process transport for %s', (_name, driverKind) => {
    const invalid = structuredClone(specSection62Example) as Record<string, any>
    invalid.harness.driver = driverKind
    invalid.driver.kind = driverKind
    invalid.process.harnessTransport.kind = 'in-process'

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'forbidden',
    })
  })

  test('does not relax the pi-sdk in-process host requirements', () => {
    const invalid = structuredClone(piSdkSpec)
    invalid.process.command = 'arris-resident-external'

    expectInvalidSpec(invalid, { path: 'process.command', code: 'invalid_literal' })
  })
})

describe('validateInvocationInput', () => {
  test('accepts text and local image content', () => {
    const input = {
      inputId: 'input_1',
      kind: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'local_image', path: '/tmp/image.png' },
      ],
      metadata: { source: 'test' },
    }

    expect(validateInvocationInput(input)).toEqual(input)
  })

  test('accepts per-turn response formats for text and JSON Schema object roots', () => {
    const jsonSchemaInput = {
      inputId: 'input_structured_response',
      kind: 'user',
      content: [{ type: 'text', text: 'return a status object' }],
      responseFormat: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['ok', 'blocked'] },
            count: { type: 'number', minimum: 0 },
            nullable: { type: ['string', 'null'] },
          },
          required: ['status'],
        },
      },
    }
    const textInput = {
      ...jsonSchemaInput,
      inputId: 'input_text_response',
      responseFormat: { kind: 'text' },
    }

    expect(validateInvocationInput(jsonSchemaInput)).toEqual(jsonSchemaInput)
    expect(validateInvocationInput(textInput)).toEqual(textInput)
  })

  test.each([
    ['text format carrying schema', { kind: 'text', schema: { type: 'object' } }, 'schema'],
    ['json_schema missing schema', { kind: 'json_schema' }, 'schema'],
    ['json_schema null root', { kind: 'json_schema', schema: null }, 'schema'],
    ['json_schema array root', { kind: 'json_schema', schema: [] }, 'schema'],
    ['json_schema primitive root', { kind: 'json_schema', schema: true }, 'schema'],
    ['unknown response format kind', { kind: 'xml_schema', schema: {} }, 'kind'],
    [
      'nested undefined schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: undefined } } },
      'schema.properties.value',
    ],
    [
      'nested function schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: () => true } } },
      'schema.properties.value',
    ],
    [
      'nested symbol schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: Symbol('x') } } },
      'schema.properties.value',
    ],
    [
      'nested bigint schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: 1n } } },
      'schema.properties.value',
    ],
    [
      'nested non-finite schema number',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: Number.NaN } } },
      'schema.properties.value',
    ],
    [
      'nested Date schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Date(0) } } },
      'schema.properties.value',
    ],
    [
      'nested Map schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Map() } } },
      'schema.properties.value',
    ],
    [
      'nested Set schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Set() } } },
      'schema.properties.value',
    ],
    [
      'nested class instance schema value',
      {
        kind: 'json_schema',
        schema: { type: 'object', properties: { value: new (class SchemaValue {})() } },
      },
      'schema.properties.value',
    ],
  ])('rejects malformed responseFormat: %s', (_name, responseFormat, pathSuffix) => {
    expectInvalidInputPath(
      {
        kind: 'user',
        content: [{ type: 'text', text: 'return a status object' }],
        responseFormat,
      },
      `responseFormat.${pathSuffix}`
    )
  })

  test('rejects missing content with a stable validation code', () => {
    expectInvalidInput(
      {
        kind: 'user',
      },
      {
        path: 'content',
        code: 'required',
      }
    )
  })
})

describe('validateInvocationStartRequest', () => {
  test('accepts a start request with initial input', () => {
    const request = {
      spec: specSection19InvocationStartSpec,
      initialInput: {
        inputId: 'input_1',
        kind: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    }

    expect(validateInvocationStartRequest(request)).toEqual(request)
  })

  test('rejects an invalid nested spec with prefixed issue paths', () => {
    const invalidSpec = structuredClone(specSection19InvocationStartSpec)
    Reflect.deleteProperty(invalidSpec.process, 'command')

    expectInvalidStartRequest(
      {
        spec: invalidSpec,
      },
      {
        path: 'spec.process.command',
        code: 'required',
      }
    )
  })

  test('rejects stale runtime overlays on start requests', () => {
    expectInvalidStartRequest(
      {
        spec: specSection19InvocationStartSpec,
        runtime: { tmux: { socketPath: '/tmp/stale-start-request.sock' } },
      },
      {
        path: 'runtime',
        code: 'stale_runtime_overlay',
      }
    )
  })

  test('rejects lifecycle overlays on start requests', () => {
    expectInvalidStartRequest(
      {
        spec: specSection19InvocationStartSpec,
        lifecyclePolicy: conservativeDefaultLifecyclePolicyOverlay('policy_start_request_stale'),
      },
      {
        path: 'lifecyclePolicy',
        code: 'stale_lifecycle_overlay',
      }
    )
  })

  test('accepts a pi-sdk in-process spec', () => {
    const request = { spec: piSdkSpec }
    expect(validateInvocationStartRequest(request)).toEqual(request)
  })

  test.each([
    [
      'missing sdk block',
      (spec: typeof piSdkSpec) => Reflect.deleteProperty(spec, 'sdk'),
      { path: 'spec.sdk', code: 'required' },
    ],
    [
      'child-process transport',
      (spec: typeof piSdkSpec) => {
        spec.process.harnessTransport.kind = 'pipes'
      },
      { path: 'spec.process.harnessTransport.kind', code: 'invalid_literal' },
    ],
    [
      'non-sentinel command',
      (spec: typeof piSdkSpec) => {
        spec.process.command = 'pi'
      },
      { path: 'spec.process.command', code: 'invalid_literal' },
    ],
    [
      'non-empty args',
      (spec: typeof piSdkSpec) => {
        spec.process.args = ['--print']
      },
      { path: 'spec.process.args', code: 'invalid_literal' },
    ],
  ])('rejects a pi-sdk start request with %s', (_name, mutate, expectedIssue) => {
    const invalidSpec = structuredClone(piSdkSpec)
    mutate(invalidSpec)
    expectInvalidStartRequest({ spec: invalidSpec }, expectedIssue)
  })

  test.each([
    [
      'sdk block',
      (spec: typeof specSection19InvocationStartSpec & { sdk?: typeof piSdkSpec.sdk }) => {
        spec.sdk = structuredClone(piSdkSpec.sdk)
      },
      { path: 'spec.sdk', code: 'forbidden' },
    ],
    [
      'in-process transport',
      (spec: typeof specSection19InvocationStartSpec) => {
        spec.process.harnessTransport.kind = 'in-process'
      },
      { path: 'spec.process.harnessTransport.kind', code: 'forbidden' },
    ],
  ])('rejects a non-pi-sdk start request with %s', (_name, mutate, expectedIssue) => {
    const invalidSpec = structuredClone(specSection19InvocationStartSpec)
    mutate(invalidSpec)
    expectInvalidStartRequest({ spec: invalidSpec }, expectedIssue)
  })

  test('accepts an arris-resident in-process start request', () => {
    const request = { spec: arrisResidentSpec }
    expect(validateInvocationStartRequest(request)).toEqual(request)
  })

  test('rejects an arris-resident start request carrying an sdk block', () => {
    const invalidSpec = structuredClone(arrisResidentSpec) as typeof arrisResidentSpec & {
      sdk?: typeof piSdkSpec.sdk
    }
    invalidSpec.sdk = structuredClone(piSdkSpec.sdk)
    expectInvalidStartRequest({ spec: invalidSpec }, { path: 'spec.sdk', code: 'forbidden' })
  })
})
