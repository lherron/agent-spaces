import { handleInput, handleInterrupt } from './input.js'
import type { InputHandlerDeps } from './input.js'
import { handleHistoryRequest, type TimelineHistoryClient } from './timeline-history.js'

export type GatewayIosRouteDeps = InputHandlerDeps & {
  gatewayId?: string | undefined
}

export type GatewayIosRoute = {
  method: string
  path: string
  handle(request: Request): Promise<Response>
}

export type GatewayIosRoutes = GatewayIosRoute[] & {
  fetch(request: Request): Promise<Response>
}

function notFound(): Response {
  return new Response(JSON.stringify({ ok: false, code: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

function hasHistoryClient(
  client: InputHandlerDeps['hrcClient']
): client is InputHandlerDeps['hrcClient'] & TimelineHistoryClient {
  const candidate = client as { watch?: unknown; listMessages?: unknown }
  return typeof candidate.watch === 'function' && typeof candidate.listMessages === 'function'
}

export function createGatewayIosRoutes(deps: GatewayIosRouteDeps): GatewayIosRoutes {
  const routes = [
    ...(hasHistoryClient(deps.hrcClient)
      ? [
          {
            method: 'GET',
            path: '/v1/history',
            handle: (request: Request) =>
              handleHistoryRequest(request, { hrcClient: deps.hrcClient }),
          },
        ]
      : []),
    {
      method: 'POST',
      path: '/v1/input',
      handle: (request) => handleInput(request, deps),
    },
    {
      method: 'POST',
      path: '/v1/interrupt',
      handle: (request) => handleInterrupt(request, deps),
    },
  ] satisfies GatewayIosRoute[]

  return Object.assign(routes, {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const route = routes.find(
        (candidate) => candidate.method === request.method && candidate.path === url.pathname
      )
      if (!route) return notFound()
      return await route.handle(request)
    },
  })
}

export function createGatewayIosFetchHandler(
  deps: GatewayIosRouteDeps
): (request: Request) => Promise<Response> {
  return createGatewayIosRoutes(deps).fetch
}
