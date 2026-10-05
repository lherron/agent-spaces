/** Codex notice-shaped notifications → operator-visible `driver.notice` events. */
import type { MappedEvent } from './event-map'
import { numberValue, stringValue } from './native-params'

export function mapCodexNotice(
  method: string,
  params: Record<string, unknown>
): MappedEvent[] | undefined {
  switch (method) {
    case 'deprecationNotice':
    case 'configWarning': {
      const summary =
        stringValue(params['summary']) ??
        (method === 'deprecationNotice'
          ? 'Codex reported a deprecation.'
          : 'Codex reported a configuration warning.')
      const details = stringValue(params['details'])
      return [
        {
          type: 'driver.notice',
          payload: {
            message: summary,
            code: method,
            ...(details !== undefined ? { data: { details } } : {}),
          },
        },
      ]
    }
    // T-07726 — the provider's two generic user-facing warning channels. Same
    // treatment as the deprecation/config notices above: an operator-visible
    // `driver.notice`, never a debug diagnostic folded out of the pane.
    case 'warning':
    case 'guardianWarning': {
      const message = stringValue(params['message'])
      if (message === undefined || message.length === 0) return []
      return [{ type: 'driver.notice', payload: { message, code: method } }]
    }
    // T-07726 — the model actually serving the turn changed underneath the
    // operator. That is a decision-changing fact, not telemetry.
    case 'model/rerouted': {
      const fromModel = stringValue(params['fromModel'])
      const toModel = stringValue(params['toModel'])
      if (fromModel === undefined || toModel === undefined) return []
      const reason = stringValue(params['reason'])
      return [
        {
          type: 'driver.notice',
          payload: {
            message: `Codex rerouted the model ${fromModel} → ${toModel}${
              reason !== undefined ? ` (${reason})` : ''
            }`,
            code: method,
            data: { fromModel, toModel, ...(reason !== undefined ? { reason } : {}) },
          },
        },
      ]
    }
    case 'windows/worldWritableWarning': {
      const extraCount = numberValue(params['extraCount']) ?? 0
      const failedScan = params['failedScan'] === true
      const samplePaths = Array.isArray(params['samplePaths'])
        ? params['samplePaths'].filter((path): path is string => typeof path === 'string')
        : []
      return [
        {
          type: 'driver.notice',
          payload: {
            message: worldWritableWarningMessage(extraCount, failedScan, samplePaths),
            code: method,
            data: { extraCount, failedScan, samplePaths },
          },
        },
      ]
    }
    default:
      return undefined
  }
}

function worldWritableWarningMessage(
  extraCount: number,
  failedScan: boolean,
  samplePaths: string[]
): string {
  const pathSummary =
    samplePaths.length > 0
      ? ` Sample paths: ${samplePaths.join(', ')}.`
      : ' No sample paths were provided.'
  const extraSummary = ` ${extraCount} additional world-writable path${extraCount === 1 ? '' : 's'} were found.`
  const scanSummary = failedScan
    ? ' The world-writable path scan failed before completion.'
    : ' The world-writable path scan completed.'
  return `Codex detected world-writable paths.${pathSummary}${extraSummary}${scanSummary}`
}
