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
import type { RendererProjection, RendererProjectionOptions } from '../codex-app-server/renderer'
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
