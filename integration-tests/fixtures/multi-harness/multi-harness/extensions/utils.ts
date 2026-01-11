/**
 * Pi extension that provides utility tools for the multi-harness space.
 * WHY: Tests that Pi extensions work alongside Claude commands in multi-harness spaces.
 */

export default function registerExtension(pi: unknown) {
  const api = pi as {
    registerTool: (tool: {
      name: string
      label: string
      description: string
      parameters: object
      execute: (
        toolCallId: string,
        params: { json: string; indent?: number }
      ) => Promise<{ content: { type: string; text: string }[]; details: object }>
    }) => void
  }
  api.registerTool({
    name: 'format_json',
    label: 'Format JSON',
    description: 'Pretty-prints JSON content',
    parameters: {
      type: 'object',
      properties: {
        json: {
          type: 'string',
          description: 'JSON string to format',
        },
        indent: {
          type: 'number',
          description: 'Number of spaces for indentation',
        },
      },
      required: ['json'],
    },
    async execute(_toolCallId: string, params: { json: string; indent?: number }) {
      try {
        const parsed = JSON.parse(params.json)
        const formatted = JSON.stringify(parsed, null, params.indent ?? 2)
        return {
          content: [{ type: 'text', text: formatted }],
          details: { success: true },
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: Invalid JSON - ${error}` }],
          details: { success: false },
        }
      }
    },
  })
}
