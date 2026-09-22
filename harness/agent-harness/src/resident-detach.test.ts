import { describe, expect, test } from 'bun:test'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import { createResidentDetachControl } from './resident-detach'

type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>

function harness(existing?: EditorFactory) {
  let handler: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined
  let current = existing
  const control = createResidentDetachControl({ onDetachRequest: () => undefined })
  control.extensionFactory({
    on(event: string, next: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (event === 'session_start') handler = next
    },
  } as never)
  const ctx = {
    isIdle: () => true,
    abort: () => undefined,
    ui: {
      getEditorComponent: () => current,
      setEditorComponent: (factory: EditorFactory | undefined) => {
        current = factory
      },
    },
  } as unknown as ExtensionContext
  return {
    control,
    start: () => handler?.({}, ctx),
    replace(factory: EditorFactory) {
      current = factory
    },
  }
}

describe('resident detach custom-editor ownership', () => {
  test('refuses when another extension owns the slot first', () => {
    const prior = (() => ({})) as EditorFactory
    const subject = harness(prior)
    expect(() => subject.start()).toThrow('custom-editor slot is already owned')
  })

  test('fails readiness when another extension replaces the installed factory', () => {
    const subject = harness()
    subject.start()
    expect(() => subject.control.assertReady()).not.toThrow()
    subject.replace((() => ({})) as EditorFactory)
    expect(() => subject.control.assertReady()).toThrow('custom-editor slot was replaced')
  })
})
