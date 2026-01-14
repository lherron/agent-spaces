import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAdapter } from './src/harness/pi-adapter.js'

const tmpDir = join(tmpdir(), `pi-test-${Date.now()}`)
const outputDir = join(tmpDir, 'output')
const artifactDir = join(tmpDir, 'artifact')

async function test() {
  await mkdir(join(artifactDir, 'hooks-scripts/scripts'), { recursive: true })
  await mkdir(outputDir, { recursive: true })

  // Create hooks.json with Claude native format
  await writeFile(
    join(artifactDir, 'hooks-scripts/hooks.json'),
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

  const adapter = new PiAdapter()
  const _result = await adapter.composeTarget(
    {
      targetName: 'test',
      compose: ['space1'],
      roots: ['space1@abc'],
      loadOrder: ['space1@abc'],
      artifacts: [
        {
          spaceKey: 'space1@abc',
          spaceId: 'space1',
          artifactPath: artifactDir,
          pluginName: 'plugin1',
        },
      ],
      settingsInputs: [],
    },
    outputDir,
    {}
  )

  const content = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()

  // Extract the spawn command line
  const spawnMatch = content.match(/spawn\('([^']+)'/)
  console.log('Generated script path:', spawnMatch?.[1] || 'NOT FOUND')
  console.log('Expected to contain: hooks-scripts/scripts/agent_motd.sh')

  // Check if it has the scripts subdirectory
  if (spawnMatch?.[1]?.includes('scripts/agent_motd.sh')) {
    console.log('✓ Path is CORRECT')
  } else {
    console.log('✗ Path is WRONG - missing scripts/ subdirectory')
    console.log('\nFull relevant content:')
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (line.includes('agent_motd') || line.includes('spawn')) {
        console.log(`${i}: ${line}`)
      }
    })
  }

  await rm(tmpDir, { recursive: true, force: true })
}

test().catch(console.error)
