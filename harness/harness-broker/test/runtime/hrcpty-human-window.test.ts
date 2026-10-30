import { describe, expect, test } from 'bun:test'
import { selectClaudeCodePaneInput } from '../../src/drivers/tmux-shared'
import { HrcptyPtyController } from '../../src/runtime/hrcpty'
import { createFakeHrcpty, hrcptyLease } from '../drivers/claude-code-hrcpty/fake-hrcpty'

function subject(
  options: {
    idle?: number | null
    draft?: string
    old?: boolean
    race?: boolean
    budgetMs?: number
  } = {}
) {
  const fake = createFakeHrcpty({ screen: { box: options.draft ?? '' } })
  let refused = false
  const connect = async (path: string) => {
    const connection = await fake.connect(path)
    return {
      close: () => connection.close(),
      async call(method: string, params: Record<string, unknown> = {}) {
        const result = await (method === 'input' && options.race && !refused
          ? Promise.resolve(null)
          : connection.call(method, params))
        if (method === 'hello' && !options.old)
          return { ...(result as object), capabilities: ['inputIfIdle'] }
        if (method === 'status') return { ...(result as object), humanIdleMs: options.idle ?? null }
        if (method === 'input' && options.race && !refused) {
          refused = true
          return { written: 0, humanIdleMs: 0 }
        }
        return result
      },
    }
  }
  return {
    fake,
    pty: new HrcptyPtyController({
      socketPath: '/fake',
      allowedOps: hrcptyLease().allowedOps,
      token: async () => 'tok-fake',
      connect,
      ...(options.budgetMs !== undefined ? { humanWindowBudgetMs: options.budgetMs } : {}),
    }),
  }
}

const selectInput = selectClaudeCodePaneInput

describe('hrcpty keystroke window', () => {
  test('empty input with no human writes immediately with the 3 s condition', async () => {
    const { fake, pty } = subject()
    await pty.sendSteer('mail', { selectInput })
    expect(fake.screen.submitted).toEqual(['mail'])
    expect(fake.calls.find((c) => c.method === 'input')?.params['ifIdleMs']).toBe(3000)
  })
  test('draft override appends and conditionally writes at 30 s on both paths', async () => {
    for (const path of ['steer', 'start']) {
      const { fake, pty } = subject({ idle: 30000, draft: 'draft ' })
      if (path === 'steer') await pty.sendSteer('mail', { selectInput })
      else await pty.sendPastedLine('mail', { selectInput })
      expect(fake.screen.submitted).toEqual(['draft mail'])
      expect(fake.calls.find((c) => c.method === 'input')?.params['ifIdleMs']).toBe(30000)
      if (path === 'start')
        expect(
          fake.calls.filter((c) => c.method === 'input')[1]?.params['ifIdleMs']
        ).toBeUndefined()
    }
  })
  test('an exhausted window fails open: the caller writes without a condition', async () => {
    for (const options of [{ idle: 2999 }, { idle: 29999, draft: 'draft' }]) {
      const { fake, pty } = subject(options)
      expect(await pty.awaitHumanWindow(selectInput, 0)).toBeUndefined()
      expect(fake.inputs()).toEqual([])
    }
  })
  test('a typist past the budget still gets the mail, appended to the draft, on both paths', async () => {
    for (const path of ['steer', 'start']) {
      const { fake, pty } = subject({ idle: 500, draft: 'draft ', budgetMs: 0 })
      if (path === 'steer') await pty.sendSteer('mail', { selectInput })
      else await pty.sendPastedLine('mail', { selectInput })
      expect(fake.screen.submitted).toEqual(['draft mail'])
      expect(fake.calls.find((c) => c.method === 'input')?.params['ifIdleMs']).toBeUndefined()
    }
  })
  test('the default hold outlasts the 30 s draft override', () => {
    const { pty } = subject()
    expect(pty.humanWindowBudgetMs).toBe(90_000)
  })
  test('a conditional refusal retries before writing a single accepted body', async () => {
    const { fake, pty } = subject({ race: true })
    await pty.sendSteer('mail', { selectInput })
    expect(fake.screen.submitted).toEqual(['mail'])
    expect(fake.inputs()).toHaveLength(1)
  })
  test('old supervisor retains unconditional turn-start paste into a draft', async () => {
    const { fake, pty } = subject({ old: true, draft: 'draft ' })
    await pty.sendPastedLine('mail', { selectInput })
    expect(fake.screen.submitted).toEqual(['draft mail'])
    expect(fake.calls.some((c) => c.method === 'status')).toBe(false)
    expect(
      fake.calls
        .filter((c) => c.method === 'input')
        .every((c) => c.params['ifIdleMs'] === undefined)
    ).toBe(true)
  })
  test('old supervisor retains the steer guard and never writes into a draft', async () => {
    const { fake, pty } = subject({ old: true, draft: 'draft' })
    await expect(
      pty.sendSteer('mail', { selectInput, quiescenceTimeoutMs: 0 })
    ).rejects.toMatchObject({ phase: 'before_paste' })
    expect(fake.inputs()).toEqual([])
  })
})
