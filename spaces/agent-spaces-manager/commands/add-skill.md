# Add Skill

Add a new skill to an existing space with best-practice template.

## Usage

Run this command to add a skill to a space. A skill provides specialized knowledge or capabilities that Claude can use during conversations.

## Required Information

1. **Space ID or Path**: Which space to add the skill to
2. **Skill Name**: Name for the skill directory (kebab-case)
3. **Skill Title**: Human-readable title for the skill
4. **Skill Description**: What the skill does and when to use it

## Skill Structure

Skills are stored in `skills/<skill-name>/SKILL.md`:

```
spaces/<space-id>/
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

## Template

The created SKILL.md will follow this structure:

```markdown
# <Skill Title>

<Description of what this skill does>

## When to Use

<Describe when Claude should activate this skill>

## Context

<Provide domain knowledge, best practices, patterns>

## Guidelines

<Specific instructions for how to apply this skill>

## Examples

<Show examples of the skill in action>
```

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get skill details**:
   - Skill name (kebab-case, e.g., `code-review`)
   - Skill title (e.g., "Code Review Expert")
   - Description and trigger conditions

3. **Create the skill directory and file**:
   ```bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/skills/<skill-name>
   ```

4. **Generate SKILL.md** with best-practice template

5. **Verify** the skill is properly structured

## Example

Adding a TypeScript skill to a development space:

```markdown
# TypeScript Expert

Expert guidance for TypeScript development.

## When to Use

Activate this skill when:
- Writing or reviewing TypeScript code
- Configuring tsconfig.json
- Debugging type errors
- Migrating JavaScript to TypeScript

## Context

TypeScript is a typed superset of JavaScript. Key principles:
- Prefer strict mode (`"strict": true`)
- Use explicit return types for public APIs
- Leverage type inference for local variables
- Avoid `any` - use `unknown` when type is truly unknown

## Guidelines

1. **Type Definitions**
   - Define interfaces for object shapes
   - Use type aliases for unions and complex types
   - Export types that are part of public API

2. **Generics**
   - Use meaningful constraint names
   - Default to simpler types when generics aren't needed

3. **Error Handling**
   - Type catch blocks properly
   - Use discriminated unions for result types

## Examples

### Good: Typed function
\`\`\`typescript
function processItems<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]));
}
\`\`\`
```

## Best Practices

- Keep skills focused on a specific domain
- Provide concrete examples
- Include when-to-use triggers
- Document edge cases and gotchas
- Update skills as you learn new patterns
