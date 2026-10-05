# Add Extension

Add a new agent-harness (Pi) extension to an existing space with a best‑practice template.

## Usage

Run this command to add an extension. Extensions are TypeScript modules that register tools for the Pi-based `agent-harness`.

## Required Information

1. **Space ID or Path**: Which space to add the extension to
2. **Extension Name**: Filename for the extension (kebab-case, without .ts)
3. **Tool Name**: Tool identifier (kebab-case)
4. **Tool Description**: What the tool does

## Extension Structure

Extensions live in `extensions/`:

```
spaces/<space-id>/
└── extensions/
    └── <extension-name>.ts
```

## Template

The created extension will follow this structure:

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({
      input: Type.String({ description: "Input string" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Got: ${params.input}` }],
        details: { success: true }
      }
    }
  })
}
```

## Execution Steps

When you run this command, I will:

1. **Identify the target space**
2. **Collect extension details**
3. **Create the extensions directory** (if needed)
4. **Generate <extension-name>.ts** with the template
5. **Optionally update space.toml**:
   ```toml
   [pi]
   extensions = ["extensions/<extension-name>.ts"]
   ```

## Notes

- Extensions are for the **agent-harness** only. Claude and Codex ignore `extensions/`.
- If you use external deps, add `extensions/package.json` and list them.
- When bundling is enabled, ASP will bundle extensions to JS for execution.
- Configure bundling in `space.toml`:

```toml
[pi.build]
bundle = true           # Bundle extensions to JS (default: true)
format = "esm"          # Output format: esm or cjs (default: esm)
target = "bun"          # Target runtime: bun or node (default: bun)
external = ["some-native-dep"]  # Dependencies to exclude from bundle
```

## Best Practices

- Keep tools focused and composable
- Use clear, descriptive tool names
- Validate inputs and return helpful errors
- Prefer stable, deterministic outputs
