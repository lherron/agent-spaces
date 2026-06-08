/**
 * Hook bridge code generation.
 *
 * The hook bridge is a generated Pi extension that translates
 * hooks.toml/hooks.json declarations into Pi event handlers that shell out to
 * the configured scripts.
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { AspError } from 'spaces-config'

import { HOOK_LOG_RELATIVE_DIR } from '../constants.js'

/**
 * Hook definition from hooks.toml or hooks.json.
 */
export interface HookDefinition {
  /** Event name */
  event: string
  /** Path to script */
  script: string
  /** Tools to filter on (optional) */
  tools?: string[] | undefined
  /** Whether hook should block (Pi: best-effort) */
  blocking?: boolean | undefined
  /** Harness-specific hook */
  harness?: string | undefined
}

/**
 * Maps both abstract event names (hooks.toml) and Claude event names
 * (hooks.json), plus lowercased variants, to Pi event names.
 */
const PI_EVENT_MAP: Record<string, string> = {
  // Abstract event names (from hooks.toml)
  pre_tool_use: 'tool_call',
  post_tool_use: 'tool_result',
  session_start: 'session_start',
  session_end: 'session_shutdown',
  // Claude event names (from hooks.json)
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  SessionStart: 'session_start',
  Stop: 'session_shutdown',
  // Lowercased variants (from buggy snake_case conversion in readHooksWithPrecedence)
  sessionstart: 'session_start',
  pretooluse: 'tool_call',
  posttooluse: 'tool_result',
  stop: 'session_shutdown',
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

export async function resolveHookScriptPath(script: string, hooksDir: string): Promise<string> {
  const normalized = script.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/^hooks\//, '')

  // Treat commands with whitespace as raw shell commands.
  if (/\s/.test(normalized)) {
    return script
  }

  if (isAbsolute(normalized)) {
    if (await isFile(normalized)) {
      return normalized
    }
    throw new AspError(`Hook script not found: "${script}"`, 'HOOK_SCRIPT_NOT_FOUND')
  }

  const directPath = join(hooksDir, normalized)
  if (await isFile(directPath)) {
    return directPath
  }

  if (!normalized.startsWith('scripts/')) {
    const scriptsPath = join(hooksDir, 'scripts', normalized)
    if (await isFile(scriptsPath)) {
      return scriptsPath
    }
  }

  // If it doesn't look like a path, treat as a command.
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    return script
  }

  throw new AspError(
    `Hook script not found: "${script}" (tried "${directPath}")`,
    'HOOK_SCRIPT_NOT_FOUND'
  )
}

/**
 * Generate the hook bridge extension for Pi.
 *
 * The hook bridge is a generated extension that translates hooks.toml/hooks.json
 * declarations into Pi event handlers that shell out to the configured scripts.
 */
export function generateHookBridgeCode(hooks: HookDefinition[], spaceIds: string[]): string {
  // Filter hooks applicable to Pi
  const piHooks = hooks.filter((h) => !h.harness || h.harness === 'pi')

  // Single source of truth for the host log dir, shared with constants.ts.
  const logDirSegments = HOOK_LOG_RELATIVE_DIR.map((segment) => JSON.stringify(segment)).join(', ')

  const hookRegistrations = piHooks
    .map((hook) => {
      // Map both abstract event names and Claude event names to Pi events
      const piEvent = PI_EVENT_MAP[hook.event] || hook.event
      const toolsFilter = hook.tools ? JSON.stringify(hook.tools) : 'null'

      return `
  // Hook: ${hook.event} -> ${hook.script}
  pi.on('${piEvent}', async (event, ctx) => {
    const toolsFilter = ${toolsFilter};
    // For tool events, filter by tool name
    if (toolsFilter && event.toolName && !toolsFilter.includes(event.toolName)) {
      return;
    }

    const env = {
      ...process.env,
      ASP_TOOL_NAME: event.toolName || '',
      ASP_TOOL_ARGS: JSON.stringify(event.input || {}),
      ASP_TOOL_RESULT: JSON.stringify(event.result || {}),
      ASP_HARNESS: 'pi',
      ASP_SPACES: ${JSON.stringify(spaceIds.join(','))},
    };

    try {
      log('DEBUG', \`Running hook: ${hook.script}\`);
      const { spawn } = await import('node:child_process');
      let payload = '';
      try {
        payload = JSON.stringify(event ?? {});
      } catch {
        payload = '';
      }
      const proc = spawn('${hook.script}', [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      if (proc.stdin) {
        proc.stdin.write(payload);
        proc.stdin.end();
      }
      const exitCode = await new Promise((resolve) => proc.on('close', resolve));
      const outputParts = [];
      if (stdout.trim().length > 0) {
        outputParts.push(stdout.trimEnd());
      }
      if (stderr.trim().length > 0) {
        outputParts.push(\`[stderr]\\n\${stderr.trimEnd()}\`);
      }
      if (outputParts.length > 0 || exitCode !== 0) {
        const header = \`Hook ${hook.event}: ${hook.script}\`;
        const body = outputParts.length > 0 ? outputParts.join('\\n\\n') : '(no output)';
        const content = \`\${header}\\n\\n\${body}\`;
        const options = ctx.isIdle() ? {} : { deliverAs: 'nextTurn' };
        pi.sendMessage(
          {
            customType: 'asp-hook',
            content,
            display: true,
            details: {
              event: '${hook.event}',
              script: '${hook.script}',
              exitCode,
            },
          },
          options
        );
      }
      if (exitCode !== 0) {
        log('WARN', \`Hook script "${hook.script}" exited with \${exitCode}\`);
      } else {
        log('DEBUG', \`Hook script "${hook.script}" completed successfully\`);
      }
    } catch (err) {
      log('ERROR', \`Hook script "${hook.script}" failed: \${err}\`);
    }
  });`
    })
    .join('\n')

  return `/**
 * ASP Hook Bridge Extension
 *
 * Generated by Agent Spaces - DO NOT EDIT
 *
 * This extension bridges hooks.toml declarations to Pi event handlers,
 * executing shell scripts with standardized ASP_* environment variables.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = path.join(os.homedir(), ${logDirSegments});
const LOG_FILE = path.join(LOG_DIR, 'asp-hooks.log');

function log(level, message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, \`[\${timestamp}] [\${level}] \${message}\\n\`);
  } catch (e) {
    // Silently fail if logging fails
  }
}

module.exports = function(pi) {
  log('INFO', 'ASP Hook Bridge loaded');
${hookRegistrations || '  // No hooks configured'}
};
`
}
