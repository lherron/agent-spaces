import {
  CustomEditor,
  type ExtensionContext,
  type ExtensionFactory,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent'
import type { EditorTheme, TUI } from '@earendil-works/pi-tui'

type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>

export type ResidentDetachReason = 'quit' | 'ctrl-d' | 'double-ctrl-c'

export interface ResidentDetachControl {
  extensionFactory: ExtensionFactory
  assertReady(): void
}

export function createResidentDetachControl(options: {
  onDetachRequest(reason: ResidentDetachReason): void | Promise<void>
  doubleCtrlCWindowMs?: number | undefined
}): ResidentDetachControl {
  let context: ExtensionContext | undefined
  let installedFactory: EditorFactory | undefined
  const windowMs = options.doubleCtrlCWindowMs ?? 500

  const extensionFactory: ExtensionFactory = (pi) => {
    pi.on('session_start', (_event, ctx) => {
      if (ctx.ui.getEditorComponent() !== undefined) {
        throw new Error('resident detach custom-editor slot is already owned')
      }
      context = ctx

      class ResidentDetachEditor extends CustomEditor {
        private lastClearAt = 0

        constructor(
          tui: TUI,
          theme: EditorTheme,
          private readonly keys: KeybindingsManager
        ) {
          super(tui, theme, keys)
        }

        override handleInput(data: string): void {
          if (this.keys.matches(data, 'tui.input.submit') && this.getText().trim() === '/quit') {
            this.setText('')
            requestDetach('quit', ctx, options.onDetachRequest)
            return
          }
          if (ctx.isIdle() && this.keys.matches(data, 'app.exit') && this.getText().length === 0) {
            requestDetach('ctrl-d', ctx, options.onDetachRequest)
            return
          }
          if (!ctx.isIdle() && this.keys.matches(data, 'app.clear')) {
            ctx.abort()
            return
          }
          if (ctx.isIdle() && this.keys.matches(data, 'app.clear')) {
            const now = Date.now()
            if (now - this.lastClearAt < windowMs) {
              this.lastClearAt = 0
              requestDetach('double-ctrl-c', ctx, options.onDetachRequest)
              return
            }
            this.lastClearAt = now
          }
          super.handleInput(data)
        }
      }

      installedFactory = (tui: TUI, theme: EditorTheme, keys: KeybindingsManager) =>
        new ResidentDetachEditor(tui, theme, keys)
      ctx.ui.setEditorComponent(installedFactory)
    })
  }

  return {
    extensionFactory,
    assertReady() {
      if (context === undefined || installedFactory === undefined) {
        throw new Error('resident detach custom-editor slot is not installed')
      }
      if (context.ui.getEditorComponent() !== installedFactory) {
        throw new Error('resident detach custom-editor slot was replaced')
      }
    },
  }
}

function requestDetach(
  reason: ResidentDetachReason,
  ctx: ExtensionContext,
  handler: (reason: ResidentDetachReason) => void | Promise<void>
): void {
  Promise.resolve(handler(reason)).catch((error: unknown) => {
    ctx.ui.notify(
      `Detach failed: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    )
  })
}
