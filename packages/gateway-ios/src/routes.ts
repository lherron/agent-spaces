import { handleInput, handleInterrupt } from './input.js'
import type { InputHandlerDeps } from './input.js'

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

export function createGatewayIosRoutes(deps: InputHandlerDeps): GatewayIosRoutes {
  const routes = [
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
  deps: InputHandlerDeps
): (request: Request) => Promise<Response> {
  return createGatewayIosRoutes(deps).fetch
}
