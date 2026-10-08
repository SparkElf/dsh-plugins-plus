/**
 * Activation must not depend on DataOps being reachable.
 *
 * A stored JWT that DataOps has since rejected, or an unreachable backend, is a state the
 * settings panel reports and recovers from. When the MCP connect ran before the routes were
 * registered, a failed connect aborted activation and the plugin mounted with no routes at
 * all: every settings request answered 404, so the browser showed a connection failure and
 * the panel could not even display the reason. These tests drive `apply` with a credential
 * service and MCP client that fail, and assert the routes still came up.
 */

import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One route as the fake Web server received it. */
interface RegisteredRoute {
  path: string
  handler: (request: unknown, response: unknown) => Promise<void>
}

/** A Response double that records what the handler wrote. */
function responseRecorder() {
  const written: { status: number; body: string }[] = []
  return {
    written,
    response: {
      writeHead: (status: number) => { written.push({ status, body: '' }) },
      end: (body?: string) => { if (body !== undefined && written.length > 0) written[written.length - 1]!.body = body },
      setHeader: () => undefined,
    },
  }
}

/**
 * A context that stands in for the DSH Host.
 *
 * Only what `apply` touches is implemented: credential resolution, the Web server registry,
 * effects, and a logger. `plugin` reports a fiber whose `await` rejects, standing in for an
 * MCP connect that cannot complete.
 */
function contextWith(hasCredential: boolean) {
  const routes: RegisteredRoute[] = []
  const context = {
    credentials: { resolve: vi.fn(async () => (hasCredential ? { value: 'stale-jwt' } : undefined)) },
    webServer: {
      register: (route: RegisteredRoute) => { routes.push(route); return () => undefined },
    },
    effect: (factory: () => unknown) => { factory(); return () => undefined },
    on: () => undefined,
    plugin: () => ({
      uid: 1,
      await: async () => { throw new Error('MCP connect refused the stored JWT') },
      dispose: async () => undefined,
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    settings: { describe: () => [], update: async () => undefined },
    skills: { list: () => [] },
    tools: { register: () => undefined },
  }
  return { context, routes }
}

/** The smallest config the plugin accepts. */
const CONFIG = {
  baseUrl: 'http://dataops.test:3101',
  serverName: 'dataops',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  toolCallTimeoutMs: 300_000,
  distributedSettingsNamespaces: [],
} as unknown as Config

describe('apply', () => {
  it('registers every settings route when the MCP connect fails', async () => {
    const { context, routes } = contextWith(true)

    await expect(apply(context as never, CONFIG)).resolves.toBeUndefined()
    expect(routes.map((route) => route.path).sort()).toEqual([
      '/integrations/dataops/managed-auth',
      '/integrations/dataops/model-sync',
      '/integrations/dataops/skill-plaza',
      '/integrations/dataops/workspace-limits',
    ])
  })

  it('registers the routes when no credential is stored', async () => {
    const { context, routes } = contextWith(false)

    await expect(apply(context as never, CONFIG)).resolves.toBeUndefined()
    expect(routes).toHaveLength(4)
  })

  it('answers the limits route rather than failing when the credential was rejected', async () => {
    // The stored JWT is stale, so DataOps refuses it. That is the state that used to abort
    // activation; the route must still exist and must report "not connected".
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })))
    const { context, routes } = contextWith(true)
    await apply(context as never, CONFIG)
    const limits = routes.find((route) => route.path === '/integrations/dataops/workspace-limits')
    expect(limits).toBeDefined()

    const { response, written } = responseRecorder()
    await limits!.handler({ method: 'GET' }, response)
    vi.unstubAllGlobals()

    // 503 is the panel's "not connected" state; a 404 would mean the route never registered.
    expect(written[0]?.status).toBe(503)
  })

  it('records why the connect failed instead of throwing it', async () => {
    const { context } = contextWith(true)
    await apply(context as never, CONFIG)
    expect(context.logger.warn).toHaveBeenCalled()
  })
})
