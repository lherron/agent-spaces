/**
 * Pi extension that provides a simple greeting tool.
 * WHY: Minimal extension for smoke testing Pi bundling.
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
        params: { name: string }
      ) => Promise<{ content: { type: string; text: string }[]; details: object }>
    }) => void
  }
  api.registerTool({
    name: 'hello',
    label: 'Hello Tool',
    description: 'Says hello to the user',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name to greet',
        },
      },
      required: ['name'],
    },
    async execute(_toolCallId: string, params: { name: string }) {
      return {
        content: [{ type: 'text', text: `Hello, ${params.name}!` }],
        details: { greeted: params.name },
      }
    },
  })
}
