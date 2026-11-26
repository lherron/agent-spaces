import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposeTargetInput, SpaceKey, SpaceRefString } from 'spaces-config'
import { PiAdapter } from './pi-adapter.js'

describe('PiAdapter', () => {
  const adapter = new PiAdapter()

  describe('composeTarget', () => {
    let tmpDir: string
    let outputDir: string
    let artifact1Dir: string
    let artifact2Dir: string
    let space1: ComposeTargetInput['artifacts'][number]
    let space2: ComposeTargetInput['artifacts'][number]

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `pi-adapter-compose-${Date.now()}`)
      outputDir = join(tmpDir, 'output')
      artifact1Dir = join(tmpDir, 'artifact1')
      artifact2Dir = join(tmpDir, 'artifact2')
      space1 = {
        spaceKey: 'space1@abc' as SpaceKey,
        spaceId: 'space1',
        artifactPath: artifact1Dir,
        pluginName: 'plugin1',
      }
      space2 = {
        spaceKey: 'space2@def' as SpaceKey,
        spaceId: 'space2',
        artifactPath: artifact2Dir,
        pluginName: 'plugin2',
      }

      await mkdir(outputDir, { recursive: true })
      await mkdir(artifact1Dir, { recursive: true })
      await mkdir(artifact2Dir, { recursive: true })
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    function composeInput(artifacts: ComposeTargetInput['artifacts']): ComposeTargetInput {
      const loadOrder = artifacts.map(({ spaceKey }) => spaceKey)
      return {
        targetName: 'test-target',
        // These cases use bare space IDs, as the adapter uses the resolved artifacts.
        compose: artifacts.map(({ spaceId }) => spaceId as SpaceRefString),
        roots: loadOrder.slice(0, 1),
        loadOrder,
        artifacts,
        settingsInputs: [],
      }
    }

    test('merges extensions from multiple artifacts', async () => {
      // Create extensions in artifact1
      await mkdir(join(artifact1Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact1Dir, 'extensions/space1__tool1.js'), 'export default {}')

      // Create extensions in artifact2
      await mkdir(join(artifact2Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact2Dir, 'extensions/space2__tool2.js'), 'export default {}')

      const input = composeInput([space1, space2])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Check bundle structure
      expect(result.bundle.harnessId).toBe('agent-harness')
      expect(result.bundle.targetName).toBe('test-target')
      expect(result.bundle.rootDir).toBe(outputDir)
      expect(result.bundle.pi?.extensionsDir).toBe(join(outputDir, 'extensions'))

      // Verify both extensions are in output
      const ext1Exists = await Bun.file(join(outputDir, 'extensions/space1__tool1.js')).exists()
      const ext2Exists = await Bun.file(join(outputDir, 'extensions/space2__tool2.js')).exists()
      expect(ext1Exists).toBe(true)
      expect(ext2Exists).toBe(true)
    })

    test('merges skills directories', async () => {
      // Create skills in both artifacts
      await mkdir(join(artifact1Dir, 'skills/skill1'), { recursive: true })
      await writeFile(join(artifact1Dir, 'skills/skill1/README.md'), '# Skill 1')

      await mkdir(join(artifact2Dir, 'skills/skill2'), { recursive: true })
      await writeFile(join(artifact2Dir, 'skills/skill2/README.md'), '# Skill 2')

      const input = composeInput([space1, space2])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Skills dir should be set
      expect(result.bundle.pi?.skillsDir).toBe(join(outputDir, 'skills'))

      // Both skills should be merged
      const skill1Exists = await Bun.file(join(outputDir, 'skills/skill1/README.md')).exists()
      const skill2Exists = await Bun.file(join(outputDir, 'skills/skill2/README.md')).exists()
      expect(skill1Exists).toBe(true)
      expect(skill2Exists).toBe(true)
    })

    test('generates hook bridge extension when hooks present', async () => {
      // Create hooks-scripts directory with hooks.toml (Pi uses hooks-scripts/ to avoid conflict)
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "scripts/validate.sh"
`
      )
      // Create script in scripts subdirectory
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/validate.sh'),
        '#!/bin/bash\necho "validating"'
      )

      const input = composeInput([space1])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Hook bridge should be generated
      expect(result.bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))

      // Verify hook bridge file exists
      const bridgeExists = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).exists()
      expect(bridgeExists).toBe(true)

      // Verify content contains hook registration
      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain('pi.on(')
      expect(bridgeContent).toContain('tool_call') // pre_tool_use maps to tool_call in Pi
    })

    test('generates correct script path for Claude native hooks.json with nested scripts', async () => {
      // Create hooks-scripts directory with Claude's native hooks.json format
      // This simulates the structure after materialization from a hooks.json like:
      // ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent_motd.sh
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent_motd.sh',
                  },
                ],
              },
            ],
          },
        })
      )
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/agent_motd.sh'),
        '#!/bin/bash\necho "motd"'
      )

      const input = composeInput([space1])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Hook bridge should be generated
      expect(result.bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))

      // Verify hook bridge file exists and contains correct path
      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()

      // The generated script path should include the 'scripts' subdirectory
      // Expected: hooks-scripts/scripts/agent_motd.sh
      // NOT: /path/to/hooks-scripts/agent_motd.sh
      expect(bridgeContent).toContain('hooks-scripts/scripts/agent_motd.sh')
      expect(bridgeContent).not.toMatch(/hooks-scripts\/agent_motd\.sh[^/]/)
      expect(bridgeContent).not.toContain(outputDir)
    })

    test('resolves missing scripts/ prefix for nested hook scripts', async () => {
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: '${CLAUDE_PLUGIN_ROOT}/hooks/agent_motd.sh',
                  },
                ],
              },
            ],
          },
        })
      )
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/agent_motd.sh'),
        '#!/bin/bash\necho "motd"'
      )

      const input = composeInput([space1])

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain('hooks-scripts/scripts/agent_motd.sh')
    })

    test('passes through raw command hooks without rewriting paths', async () => {
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: 'asp --help',
                  },
                ],
              },
            ],
          },
        })
      )

      const input = composeInput([space1])

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain("const hookScript = 'asp --help'")
      expect(bridgeContent).toContain('const isRawShellCommand = /\\s/.test(hookScript)')
      expect(bridgeContent).toContain(
        'isRawShellCommand ? hookScript : path.join(__dirname, hookScript)'
      )
    })

    test('generates W301 warning for blocking hooks', async () => {
      // Create hooks-scripts with blocking=true (Pi uses hooks-scripts/ to avoid conflict)
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "scripts/validate.sh"
blocking = true
`
      )
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/validate.sh'),
        '#!/bin/bash\necho "blocking"'
      )

      const input = composeInput([space1])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W301 warning
      expect(result.warnings.some((w) => w.code === 'W301')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('cannot block'))).toBe(true)
    })

    test('generates W303 warning for extension collisions', async () => {
      // Create same-named extension in both artifacts (after namespacing collision is impossible,
      // but if they're pre-namespaced the same)
      await mkdir(join(artifact1Dir, 'extensions'), { recursive: true })
      await mkdir(join(artifact2Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact1Dir, 'extensions/shared__tool.js'), 'export default {}')
      await writeFile(join(artifact2Dir, 'extensions/shared__tool.js'), 'export default {}')

      const input = composeInput([space1, space2])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W303 warning
      expect(result.warnings.some((w) => w.code === 'W303')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('collision'))).toBe(true)
    })

    test('generates W304 warning for lint-only permissions', async () => {
      // Create permissions.toml with read permissions (lint_only for Pi)
      await writeFile(
        join(artifact1Dir, 'permissions.toml'),
        `
[read]
paths = ["/tmp", "/var"]

[write]
paths = ["/tmp"]
`
      )

      const input = composeInput([space1])

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W304 warning for lint-only permissions
      expect(result.warnings.some((w) => w.code === 'W304')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('lint-only'))).toBe(true)
    })

    test('cleans output directory when clean: true', async () => {
      // Create existing file
      await writeFile(join(outputDir, 'old-file.txt'), 'old')

      const input = composeInput([])

      await adapter.composeTarget(input, outputDir, { clean: true })

      // Old file should be gone
      const exists = await Bun.file(join(outputDir, 'old-file.txt')).exists()
      expect(exists).toBe(false)
    })

    test('always generates the HRC events bridge extension even when no ASP hooks exist', async () => {
      const input = composeInput([space1])

      await adapter.composeTarget(input, outputDir, {})

      const hrcBridgePath = join(outputDir, 'asp-hrc-events.bridge.js')
      const hrcBridgeFile = Bun.file(hrcBridgePath)
      expect(await hrcBridgeFile.exists()).toBe(true)

      const bridgeContent = await hrcBridgeFile.text()
      expect(bridgeContent.length).toBeGreaterThan(0)
      expect(await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).exists()).toBe(false)
    })

    test('HRC events bridge subscribes to Pi lifecycle and stream events', async () => {
      const input = composeInput([])

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()
      for (const eventName of [
        'before_agent_start',
        'agent_start',
        'agent_end',
        'turn_start',
        'turn_end',
        'message_start',
        'message_update',
        'message_end',
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
        'session_shutdown',
      ]) {
        expect(bridgeContent).toContain(eventName)
      }
    })

    test('HRC events bridge forwards structured payloads through HRC_LAUNCH_HOOK_CLI', async () => {
      const input = composeInput([])

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()
      expect(bridgeContent).toContain('process.env.HRC_LAUNCH_HOOK_CLI')
      expect(bridgeContent).toContain('JSON.stringify')
      expect(bridgeContent).toContain('eventName')
      expect(bridgeContent).toContain('payload')
    })

    test('HRC events bridge registers session_start exactly once (via the enriched handler)', async () => {
      const input = composeInput([])

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()

      // session_start must be subscribed to exactly once — the generic-forward
      // list must NOT also register it alongside the special-cased enriched
      // handler (which captures sessionId/sessionFile from ctx.sessionManager).
      const sessionStartHandlers = bridgeContent.match(/pi\.on\('session_start'/g) ?? []
      expect(sessionStartHandlers).toHaveLength(1)

      // The single registration must be the enriched one (captures sessionId),
      // not a bare generic forward.
      expect(bridgeContent).toContain('getSessionId')
      expect(bridgeContent).toContain('sessionId')
    })
  })

  describe('getTargetOutputPath', () => {
    test('returns correct path for target', () => {
      const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')

      expect(path).toBe('/project/asp_modules/my-target/pi')
    })

    test('handles different asp_modules paths', () => {
      const path = adapter.getTargetOutputPath('/custom/path', 'target')

      expect(path).toBe('/custom/path/target/pi')
    })
  })
})

describe('loadTargetBundle', () => {
  let tmpDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-adapter-load-bundle-${Date.now()}`)
    outputDir = join(tmpDir, 'output')
    await mkdir(outputDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('reports the expected pi paths and omits absent skills/bridges', async () => {
    const adapter = new PiAdapter()

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.harnessId).toBe('agent-harness')
    expect(bundle.targetName).toBe('my-target')
    expect(bundle.rootDir).toBe(outputDir)
    expect(bundle.pi?.extensionsDir).toBe(join(outputDir, 'extensions'))
    // No skills dir / bridges on disk -> undefined.
    expect(bundle.pi?.skillsDir).toBeUndefined()
    expect(bundle.pi?.hookBridgePath).toBeUndefined()
    expect(bundle.pi?.hrcEventsBridgePath).toBeUndefined()
  })

  test('detects skills dir and both bridges when present on disk', async () => {
    const adapter = new PiAdapter()

    // Skills dir with at least one entry.
    await mkdir(join(outputDir, 'skills', 'skill-a'), { recursive: true })
    await writeFile(join(outputDir, 'skills/skill-a/README.md'), '# Skill A')
    // Hook bridge + HRC events bridge files.
    await writeFile(join(outputDir, 'asp-hooks.bridge.js'), 'module.exports = () => {}')
    await writeFile(join(outputDir, 'asp-hrc-events.bridge.js'), 'module.exports = () => {}')

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.pi?.skillsDir).toBe(join(outputDir, 'skills'))
    expect(bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))
    expect(bundle.pi!.hrcEventsBridgePath).toBe(join(outputDir, 'asp-hrc-events.bridge.js'))
  })

  test('treats an empty skills directory as no skills dir', async () => {
    const adapter = new PiAdapter()
    await mkdir(join(outputDir, 'skills'), { recursive: true })

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.pi?.skillsDir).toBeUndefined()
  })
})
