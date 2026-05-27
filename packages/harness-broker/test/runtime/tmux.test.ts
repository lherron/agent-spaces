import { describe, expect, test } from 'bun:test'

type FakeExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
}

const createRecordingTmux = async () => {
  const target = (await import('../../src/runtime/tmux')) as {
    createTmuxManager: (options: {
      socketPath: string
      tmuxBin?: string | undefined
      exec: (
        argv: string[],
        options?: { env?: Record<string, string | undefined> | undefined }
      ) => Promise<{ stdout: string; stderr: string }>
    }) => {
      getAttachDescriptor: (sessionName: string) => { argv: string[] }
      sendLiteral: (paneId: string, text: string) => Promise<void>
      sendEnter: (paneId: string) => Promise<void>
      sendKeys: (paneId: string, keys: string) => Promise<void>
    }
  }
  const calls: FakeExecCall[] = []
  const manager = target.createTmuxManager({
    socketPath: '/tmp/harness-broker-tmux.sock',
    tmuxBin: '/opt/bin/tmux',
    exec: async (argv: string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push({ argv, env: options?.env })
      return { stdout: '', stderr: '' }
    },
  })
  return { manager, calls }
}

describe('tmux runtime substrate', () => {
  test('getAttachDescriptor returns a direct tmux attach command for the reported session', async () => {
    const { manager } = await createRecordingTmux()

    expect(manager.getAttachDescriptor('asp-inv-123')).toEqual({
      argv: [
        '/opt/bin/tmux',
        '-S',
        '/tmp/harness-broker-tmux.sock',
        'attach-session',
        '-t',
        'asp-inv-123',
      ],
    })
  })

  test('sendLiteral sends literal text to the pane without appending Enter', async () => {
    const { manager, calls } = await createRecordingTmux()

    await manager.sendLiteral('%12', 'hello $USER')

    expect(calls.map((call) => call.argv)).toEqual([
      [
        '/opt/bin/tmux',
        '-S',
        '/tmp/harness-broker-tmux.sock',
        'send-keys',
        '-l',
        '-t',
        '%12',
        'hello $USER',
      ],
    ])
  })

  test('sendEnter sends only Enter to the pane', async () => {
    const { manager, calls } = await createRecordingTmux()

    await manager.sendEnter('%12')

    expect(calls.map((call) => call.argv)).toEqual([
      ['/opt/bin/tmux', '-S', '/tmp/harness-broker-tmux.sock', 'send-keys', '-t', '%12', 'Enter'],
    ])
  })

  test('sendKeys sends literal text followed by Enter', async () => {
    const { manager, calls } = await createRecordingTmux()

    await manager.sendKeys('%12', 'continue')

    expect(calls.map((call) => call.argv)).toEqual([
      [
        '/opt/bin/tmux',
        '-S',
        '/tmp/harness-broker-tmux.sock',
        'send-keys',
        '-l',
        '-t',
        '%12',
        'continue',
      ],
      ['/opt/bin/tmux', '-S', '/tmp/harness-broker-tmux.sock', 'send-keys', '-t', '%12', 'Enter'],
    ])
  })
})
