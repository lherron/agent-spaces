import Ajv from 'ajv'

export interface JsonSchemaValidationResult {
  valid: boolean
  errors?: unknown[] | undefined
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
