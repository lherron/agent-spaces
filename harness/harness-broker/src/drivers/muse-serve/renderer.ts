/**
 * Muse renderer projection (T-08590, campaign P-00522).
 *
 * Reuses the shared durable-read machinery in codex-app-server/renderer.ts
 * (RendererDurableReadSurface bootstrap + live gap, seq dedup, redraw) with
 * the muse transcript model substituted via the buildTranscript slot. The
 * renderer is NEVER fed a driver-pushed private stream, so its output stays
 * coherent with durable attach/replay; the serve stdio child stays the
 * authoritative transport.
 */
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexAppServerRendererProjection } from '../codex-app-server/renderer'
import type {
  RendererLaunchOptions,
  RendererProjection,
  RendererProjectionOptions,
} from '../codex-app-server/renderer'
import { shellQuote } from '../tmux-shared'
import { createMuseTranscriptModel } from './transcript'

export type MuseRendererProjectionOptions = Omit<RendererProjectionOptions, 'buildTranscript'>

export function createMuseServeRendererProjection(
  options: MuseRendererProjectionOptions
): RendererProjection {
  return createCodexAppServerRendererProjection({
    ...options,
    buildTranscript: (emit) =>
      createMuseTranscriptModel({
        emit,
        ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
      }),
  })
}

/**
 * Resolve the absolute path to the muse renderer entry process that ships
 * beside this module (`renderer-entry.ts` in dev, `.js` once built by tsc).
 */
export function resolveMuseRendererEntryPath(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), `renderer-entry${extname(self)}`)
}

/**
 * Build the command line pasted into the leased pane to launch the muse
 * renderer. Mirrors the codex launch command: names the driver, the durable
 * read source (`invocation.eventsSince` bootstrap, `invocation.event` live),
 * and never routes through an interactive TUI — serve stdio stays the
 * harness transport.
 */
export function buildMuseRendererLaunchCommand(options: RendererLaunchOptions): string {
  const launch =
    options.launcher !== undefined
      ? [shellQuote(options.launcher.command), ...options.launcher.args.map(shellQuote)]
      : ['bun', shellQuote(options.rendererEntryPath ?? resolveMuseRendererEntryPath())]
  return [
    `exec ${launch.join(' ')}`,
    '--driver muse-serve',
    `--invocation-id ${shellQuote(options.invocationId)}`,
    `--observer-socket ${shellQuote(options.observerSocketPath)}`,
    `--control-socket ${shellQuote(options.controlSocketPath)}`,
    ...(options.runtimeId !== undefined ? [`--runtime-id ${shellQuote(options.runtimeId)}`] : []),
    '--bootstrap-method invocation.eventsSince',
    '--live-method invocation.event',
  ].join(' ')
}
