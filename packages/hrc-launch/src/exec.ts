import { type ChildProcess, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

import { postCallback } from './callback-client.js'
import { readLaunchArtifact } from './launch-artifact.js'
import { spoolCallback } from './spool.js'

async function callbackOrSpool(
  socketPath: string,
  endpoint: string,
  payload: object,
  spoolDir: string,
  launchId: string
): Promise<void> {
  const delivered = await postCallback(socketPath, endpoint, payload)
  if (!delivered) {
    await spoolCallback(spoolDir, launchId, { endpoint, payload })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'launch-file': { type: 'string' },
    },
    strict: true,
  })

  const launchFile = values['launch-file']
  if (!launchFile) {
    process.stderr.write('Usage: hrc-launch exec --launch-file <path>\n')
    process.exit(1)
  }

  const artifact = await readLaunchArtifact(launchFile)
  const { launchId, callbackSocketPath, spoolDir, argv, env, cwd } = artifact

  const command = argv[0]
  if (!command) {
    process.stderr.write('hrc-launch exec: empty argv in launch artifact\n')
    process.exit(1)
  }

  // POST wrapper-started
  await callbackOrSpool(
    callbackSocketPath,
    `/v1/internal/launches/${launchId}/wrapper-started`,
    { launchId, pid: process.pid },
    spoolDir,
    launchId
  )

  // Spawn child
  const child: ChildProcess = spawn(command, argv.slice(1), {
    env: { ...process.env, ...env },
    cwd,
    stdio: 'inherit',
  })

  // POST child-started
  await callbackOrSpool(
    callbackSocketPath,
    `/v1/internal/launches/${launchId}/child-started`,
    { launchId, childPid: child.pid },
    spoolDir,
    launchId
  )

  // Wait for exit
  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code: number | null, signal: string | null) => {
      const payload = {
        launchId,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      }
      callbackOrSpool(
        callbackSocketPath,
        `/v1/internal/launches/${launchId}/exited`,
        payload,
        spoolDir,
        launchId
      ).then(() => {
        resolve(code ?? 1)
      })
    })
  })

  process.exit(exitCode)
}

main().catch((err: unknown) => {
  process.stderr.write(`hrc-launch exec error: ${String(err)}\n`)
  process.exit(1)
})
