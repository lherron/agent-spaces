import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface TerminateProcessOptions {
  proc: ChildProcessWithoutNullStreams
  graceMs: number
}

export async function terminateProcess({ proc, graceMs }: TerminateProcessOptions): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    return
  }

  const exited = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
  })

  proc.kill('SIGTERM')

  const graceExpired = new Promise<'kill'>((resolve) => {
    setTimeout(() => resolve('kill'), graceMs)
  })

  const result = await Promise.race([exited.then(() => 'exit' as const), graceExpired])
  if (result === 'kill' && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await exited
  }
}
