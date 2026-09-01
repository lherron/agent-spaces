import Ajv from 'ajv'

export interface JsonSchemaValidationResult {
  valid: boolean
  errors?: unknown[] | undefined
}

/** Frozen JSON-Schema projection of the harness-broker/0.3 admission ABI. */
export const BROKER_ADMISSION_JSON_SCHEMAS = {
  origin: originJsonSchema(),
  steerRequest: submissionRequestSchema(false, false),
  enqueueRequest: submissionRequestSchema(true, true),
  invokeRequest: submissionRequestSchema(false, true),
  preemptRequest: submissionRequestSchema(true, true),
  response: {
    type: 'object',
    additionalProperties: false,
    required: ['submissionId', 'admission'],
    properties: {
      submissionId: { type: 'string', minLength: 1 },
      admission: { enum: ['admitted', 'rejected'] },
      reason: { type: 'string' },
    },
  },
} as const

function originJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['principalRef'],
    properties: {
      principalRef: { type: 'string', minLength: 1 },
      scopeRef: { type: 'string' },
      envelopeId: { type: 'string' },
    },
  } as const
}

function submissionRequestSchema(allowTtl: boolean, allowTurnPolicy: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['invocationId', 'origin', 'body'],
    properties: {
      invocationId: { type: 'string', minLength: 1 },
      origin: originJsonSchema(),
      body: { type: 'string' },
      responseFormat: { type: 'object' },
      freshContext: { type: 'boolean' },
      ...(allowTtl ? { ttlMs: { type: 'number', exclusiveMinimum: 0 } } : {}),
      ...(allowTurnPolicy ? { turnPolicy: { enum: ['open', 'guarded'] } } : {}),
    },
  } as const
}

/**
 * Validate an arbitrary value against a caller-supplied JSON Schema.
 *
 * The broker core already owns the Ajv runtime dependency for persisted event
 * validation.  Publishing this narrow helper lets composed driver packages
 * re-validate structured responses without adding a second validator (or a
 * transitive undeclared dependency) to their isolated package graph.
 */
export function validateJsonSchemaValue(
  schema: Record<string, unknown>,
  value: unknown
): JsonSchemaValidationResult {
  try {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
    const valid = validate(value)
    return valid
      ? { valid: true }
      : { valid: false, errors: validate.errors?.map((error) => ({ ...error })) ?? [] }
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          keyword: 'schema_compile',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}
