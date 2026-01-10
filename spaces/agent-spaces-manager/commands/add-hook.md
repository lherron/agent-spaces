# Add Hook

Add a new hook to an existing space with proper configuration.

## Usage

Run this command to add a hook to a space. Hooks allow Claude to execute scripts at specific points during the conversation lifecycle.

## Required Information

1. **Space ID or Path**: Which space to add the hook to
2. **Hook Event**: When the hook should trigger
3. **Script Name**: Name of the script file
4. **Script Content**: What the script should do

## Hook Events

Available hook events:

| Event | Description |
|-------|-------------|
| `on_session_start` | Runs when a Claude session begins |
| `on_session_end` | Runs when a Claude session ends |
| `on_command_start` | Runs before a command executes |
| `on_command_end` | Runs after a command completes |
| `on_tool_start` | Runs before a tool is invoked |
| `on_tool_end` | Runs after a tool completes |

## Hook Structure

Hooks require both a configuration file and script files:

```
spaces/<space-id>/
└── hooks/
    ├── hooks.json      # Hook configuration (required)
    └── scripts/        # Script files
        └── <script>.sh
```

## hooks.json Format

```json
{
  "hooks": [
    {
      "event": "<event-type>",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<script>.sh",
      "timeout_ms": 5000
    }
  ]
}
```

**IMPORTANT**: Always use `${CLAUDE_PLUGIN_ROOT}` for script paths. This ensures paths resolve correctly regardless of where the plugin is materialized.

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get hook details**:
   - Hook event type
   - Script name
   - Script functionality

3. **Create the hooks structure** (if needed):
   ```bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/hooks/scripts
   ```

4. **Create or update hooks.json**:
   - Add the new hook entry
   - Preserve existing hooks

5. **Create the script file**:
   - Generate script with shebang
   - Make it executable (`chmod +x`)

6. **Verify** the hook configuration is valid

## Example

Adding a session-start hook to log environment info:

### hooks.json
```json
{
  "hooks": [
    {
      "event": "on_session_start",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/log-session-start.sh",
      "timeout_ms": 3000
    }
  ]
}
```

### scripts/log-session-start.sh
```bash
#!/bin/bash
# Log session start for debugging

echo "Session started at $(date)"
echo "Working directory: $(pwd)"
echo "Node version: $(node --version 2>/dev/null || echo 'not installed')"
```

## Best Practices

1. **Use `${CLAUDE_PLUGIN_ROOT}`**: Always use this variable for paths in hooks.json
2. **Set Reasonable Timeouts**: Default to 5000ms, adjust based on script complexity
3. **Make Scripts Executable**: Scripts must have execute permission
4. **Handle Errors Gracefully**: Scripts should exit 0 even if they fail (to not block Claude)
5. **Keep Scripts Fast**: Hooks should complete quickly to not slow down Claude
6. **Log for Debugging**: Include logging to help troubleshoot issues

## Warnings

The lint system will emit warnings for:
- **W203**: Hook path missing `${CLAUDE_PLUGIN_ROOT}`
- **W204**: hooks/ exists but hooks.json missing or invalid
- **W206**: Hook script not executable

## Script Template

```bash
#!/bin/bash
# <Description of what this hook does>
# Event: <event-type>

set -e  # Exit on error (optional, remove if you want to continue on failure)

# Your hook logic here

exit 0
```
