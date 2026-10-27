import { describe, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationInput } from '../src/commands'
import type { HarnessInvocationSpec } from '../src/invocation'
import { inputIdFrom } from './ids'
import {
  arrisResidentSpec,
  expectInvalidInput,
  expectInvalidInputPath,
  expectInvalidSpec,
  expectValidCommand,
  inputCommand,
  piSdkSpec,
  piSdkSpecSdk,
  specSection62Example,
  startCommand,
  withValueAt,
  withoutKeyAt,
} from './schema-test-helpers'

// Every case drives `validateCommand`, the registry the broker runs before each
// JSON-RPC handler: specs ride in `invocation.start` (issue paths under
// `params.startRequest.spec.`), inputs in `invocation.input` (under `params.input.`).
describe('invocation.start spec validation', () => {
  test('accepts the Codex app-server example from spec section 6.2', () => {
    expectValidCommand(startCommand(specSection62Example))
  })

  test('accepts the muse-serve start-fresh fixture (T-08588)', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'src', 'fixtures', 'muse-serve', 'start-fresh.spec.json'),
        'utf-8'
      )
    )
    expectValidCommand(startCommand(fixture))
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

  test('rejects a spec missing process.command with a stable validation code', () => {
    const invalid = withoutKeyAt(specSection62Example, ['process', 'command'])

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
    const invalidWithEquals = withValueAt(
      specSection62Example,
      ['process', 'lockedEnv', 'BAD=KEY'],
      'value'
    )
    expectInvalidSpec(invalidWithEquals, {
      path: 'process.lockedEnv.BAD=KEY',
      code: 'invalid_env_key',
    })

    const invalidWithNull = withValueAt(
      specSection62Example,
      ['process', 'lockedEnv', 'BAD\u0000KEY'],
      'value'
    )
    expectInvalidSpec(invalidWithNull, {
      path: 'process.lockedEnv.BAD\u0000KEY',
      code: 'invalid_env_key',
    })
  })

  test('rejects lockedEnv keys from ambient, credential, and reserved classes', () => {
    const ambient = withValueAt(
      specSection62Example,
      ['process', 'lockedEnv', 'HOME'],
      '/Users/lherron'
    )
    expectInvalidSpec(ambient, {
      path: 'process.lockedEnv.HOME',
      code: 'ambient_env_key',
    })

    const credential = withValueAt(
      specSection62Example,
      ['process', 'lockedEnv', 'OPENAI_API_KEY'],
      'sk-test'
    )
    expectInvalidSpec(credential, {
      path: 'process.lockedEnv.OPENAI_API_KEY',
      code: 'credential_env_key',
    })

    const reserved = withValueAt(
      specSection62Example,
      ['process', 'lockedEnv', 'NODE_OPTIONS'],
      '--inspect'
    )
    expectInvalidSpec(reserved, {
      path: 'process.lockedEnv.NODE_OPTIONS',
      code: 'reserved_env_key',
    })
  })

  test('accepts process.pathPrepend as an array of strings', () => {
    const valid: HarnessInvocationSpec = {
      ...specSection62Example,
      process: { ...specSection62Example.process, pathPrepend: ['/agent/tools/bin', '/opt/bin'] },
    }
    expectValidCommand(startCommand(valid))
  })

  test.each([
    { pathPrepend: '/agent/tools/bin', path: 'process.pathPrepend' },
    { pathPrepend: ['/agent/tools/bin', 42], path: 'process.pathPrepend.1' },
  ])(
    'rejects process.pathPrepend that is not an array of strings at $path',
    ({ pathPrepend, path }) => {
      const invalid = withValueAt(specSection62Example, ['process', 'pathPrepend'], pathPrepend)
      expectInvalidSpec(invalid, { path, code: 'invalid_type' })
    }
  )

  test('rejects unsupported specVersion literals', () => {
    const invalid = withValueAt(
      specSection62Example,
      ['specVersion'],
      'harness-broker.invocation/v2'
    )

    expectInvalidSpec(invalid, {
      path: 'specVersion',
      code: 'invalid_literal',
    })
  })

  test('rejects unsupported driver permission default decisions', () => {
    const invalid = withValueAt(specSection62Example, ['driver', 'permissionPolicy'], {
      mode: 'ask-client',
      defaultDecision: 'prompt',
    })

    expectInvalidSpec(invalid, {
      path: 'driver.permissionPolicy.defaultDecision',
      code: 'invalid_literal',
    })
  })

  test.each([
    {
      field: ['process', 'harnessTransport', 'kind'],
      value: undefined,
      code: 'required',
    },
    {
      field: ['process', 'harnessTransport', 'kind'],
      value: 'websocket',
      code: 'invalid_literal',
    },
    { field: ['interaction', 'mode'], value: undefined, code: 'required' },
    { field: ['interaction', 'mode'], value: 'batch', code: 'invalid_literal' },
    { field: ['interaction', 'inputQueue'], value: 'lifo', code: 'invalid_literal' },
    // inputQueue is the optional literal: omitting it is accepted.
    { field: ['interaction', 'inputQueue'], value: undefined, code: undefined },
  ])(
    'a missing literal field reports required and an unsupported value reports invalid_literal: $field $value',
    ({ field, value, code }) => {
      const spec =
        value === undefined
          ? withoutKeyAt(specSection62Example, field)
          : withValueAt(specSection62Example, field, value)
      if (code === undefined) {
        expectValidCommand(startCommand(spec))
      } else {
        expectInvalidSpec(spec, { path: field.join('.'), code })
      }
    }
  )

  test.each([
    ['with thinkingLevel', piSdkSpec],
    [
      'without thinkingLevel',
      (() => {
        const { thinkingLevel: _omitted, ...sdk } = piSdkSpecSdk
        const spec: HarnessInvocationSpec = { ...piSdkSpec, sdk }
        return spec
      })(),
    ],
  ])('accepts a pi-sdk in-process spec %s', (_name, spec) => {
    expectValidCommand(startCommand(spec))
  })

  test.each([
    [
      'process block',
      () => withoutKeyAt(piSdkSpec, ['process']),
      { path: 'process', code: 'required' },
    ],
    ['sdk block', () => withoutKeyAt(piSdkSpec, ['sdk']), { path: 'sdk', code: 'required' }],
    [
      'in-process transport',
      () => withValueAt(piSdkSpec, ['process', 'harnessTransport', 'kind'], 'pipes'),
      { path: 'process.harnessTransport.kind', code: 'invalid_literal' },
    ],
    [
      'command sentinel',
      () => withValueAt(piSdkSpec, ['process', 'command'], 'pi'),
      { path: 'process.command', code: 'invalid_literal' },
    ],
    [
      'empty args',
      () => withValueAt(piSdkSpec, ['process', 'args'], ['--print']),
      { path: 'process.args', code: 'invalid_literal' },
    ],
  ])('rejects a pi-sdk spec without the required %s', (_name, corrupt, expectedIssue) => {
    const invalid = corrupt()
    expectInvalidSpec(invalid, expectedIssue)
  })

  test.each([
    [
      'runtime literal',
      () => withValueAt(piSdkSpec, ['sdk', 'runtime'], 'other-sdk'),
      { path: 'sdk.runtime', code: 'invalid_literal' },
    ],
    [
      'provider',
      () => withoutKeyAt(piSdkSpec, ['sdk', 'provider']),
      { path: 'sdk.provider', code: 'required' },
    ],
    [
      'modelId',
      () => withoutKeyAt(piSdkSpec, ['sdk', 'modelId']),
      { path: 'sdk.modelId', code: 'required' },
    ],
    [
      'authMode',
      () => withoutKeyAt(piSdkSpec, ['sdk', 'authMode']),
      { path: 'sdk.authMode', code: 'required' },
    ],
    [
      'authMode literal',
      () => withValueAt(piSdkSpec, ['sdk', 'authMode'], 'ambient'),
      { path: 'sdk.authMode', code: 'invalid_literal' },
    ],
    [
      'thinkingLevel type',
      () => withValueAt(piSdkSpec, ['sdk', 'thinkingLevel'], 42),
      { path: 'sdk.thinkingLevel', code: 'invalid_type' },
    ],
  ])('rejects a pi-sdk spec with invalid %s', (_name, corrupt, expectedIssue) => {
    const invalid = corrupt()
    expectInvalidSpec(invalid, expectedIssue)
  })

  // arris-resident allows in-process transport but still carries no sdk block:
  // in-process membership does not imply an sdk block.
  test.each([
    ['codex-app-server', specSection62Example],
    ['arris-resident', arrisResidentSpec],
  ])('rejects an sdk block for another driver: %s', (_name, spec) => {
    expectInvalidSpec(withValueAt(spec, ['sdk'], piSdkSpecSdk), { path: 'sdk', code: 'forbidden' })
  })

  test('accepts an arris-resident in-process spec with no sdk block', () => {
    expectValidCommand(startCommand(arrisResidentSpec))
  })

  test.each([
    ['codex-app-server', 'codex-app-server'],
    ['noop-driver', 'noop-driver'],
    ['an unknown driver', 'totally-unknown-driver'],
  ])('still rejects in-process transport for %s', (_name, driverKind) => {
    const invalid = withValueAt(
      withValueAt(
        withValueAt(specSection62Example, ['harness', 'driver'], driverKind),
        ['driver', 'kind'],
        driverKind
      ),
      ['process', 'harnessTransport', 'kind'],
      'in-process'
    )

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'forbidden',
    })
  })
})

describe('invocation.input validation', () => {
  test('accepts text and local image content', () => {
    const input: InvocationInput = {
      inputId: inputIdFrom('input_1'),
      kind: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'local_image', path: '/tmp/image.png' },
      ],
      metadata: { source: 'test' },
    }

    expectValidCommand(inputCommand(input))
  })

  test('accepts per-turn response formats for text and JSON Schema object roots', () => {
    const jsonSchemaInput: InvocationInput = {
      inputId: inputIdFrom('input_structured_response'),
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
    const textInput: InvocationInput = {
      ...jsonSchemaInput,
      inputId: inputIdFrom('input_text_response'),
      responseFormat: { kind: 'text' },
    }

    expectValidCommand(inputCommand(jsonSchemaInput))
    expectValidCommand(inputCommand(textInput))
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
