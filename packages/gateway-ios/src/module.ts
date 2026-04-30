/**
 * GatewayIosModule — lifecycle entry point.
 *
 * Stub implementation for P0. The start/stop lifecycle will be filled in
 * by later phases (P3-P7) as routes, reducers, and composition are added.
 */

import { createLogger } from './logger.js'

const log = createLogger({ component: 'gateway-ios' })

export type GatewayIosModuleOptions = {
  hrcSocketPath: string
  host?: string | undefined
  port?: number | undefined
  bearerToken?: string | undefined
  gatewayId?: string | undefined
}

export type GatewayIosModule = {
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}

export function createGatewayIosModule(options: GatewayIosModuleOptions): GatewayIosModule {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 18480
  const gatewayId = options.gatewayId ?? 'ios-local'

  let running = false

  return {
    async start() {
      if (running) {
        throw new Error('gateway-ios is already running')
      }

      log.info('gateway.starting', {
        data: { host, port, gatewayId, hrcSocketPath: options.hrcSocketPath },
      })

      // Stub: real Bun.serve will be wired in P3/P7
      running = true

      log.info('gateway.started', {
        data: { host, port, gatewayId },
      })

      return { host, port }
    },

    async stop() {
      if (!running) return

      log.info('gateway.stopping', { data: { gatewayId } })

      // Stub: real server shutdown will be wired in P3/P7
      running = false

      log.info('gateway.stopped', { data: { gatewayId } })
    },
  }
}
