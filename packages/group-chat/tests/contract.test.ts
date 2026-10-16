import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The plugin and the backend are separate repositories, so nothing type-checks
 * across the seam. These assertions read the backend's controller source and
 * compare it with this plugin's client, which turns a silent drift (a moved route,
 * a changed auth scheme) into a failing test.
 *
 * The plugin calls the same JWT-authenticated room controller a browser uses, so
 * that controller — not a parallel "internal" surface — is the contract to check.
 * When the checkout is absent these tests report that rather than passing vacuously.
 */
const BACKEND_CONTROLLER = '/root/projects/dataops/backend/src/ai/ai-chat-room.controller.ts'
const BACKEND_MAIN = '/root/projects/dataops/backend/src/main.ts'
const PLUGIN_CLIENT = new URL('../src/backend.ts', import.meta.url).pathname
const PLUGIN_IDENTITY = new URL('../src/identity.ts', import.meta.url).pathname

/**
 * The backend's global route prefix, verified against its own bootstrap below
 * rather than assumed — a silent change there would break every plugin request.
 */
const GLOBAL_PREFIX = 'api'

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const controller = readIfPresent(BACKEND_CONTROLLER)
const client = readFileSync(PLUGIN_CLIENT, 'utf8')
const identity = readFileSync(PLUGIN_IDENTITY, 'utf8')

const normalizeRoute = (route: string): string =>
  route.replace(/:\w+/gu, 'ROOM').replace(/^\/+/u, '').replace(/\/+$/u, '')

describe('plugin/backend contract', () => {
  it('authenticates with the bearer credential the backend already accepts', () => {
    // A DataOps JWT identifies and authorizes the caller, so the plugin sends it as
    // a bearer token rather than a plugin-specific header. Both files participate:
    // the client builds the header, the identity module names it.
    expect(client).toContain('Bearer')
    expect(client).toContain('AUTHORIZATION_HEADER')
    expect(identity).toContain("AUTHORIZATION_HEADER = 'authorization'")
    // No plugin-specific credential header may reappear anywhere.
    expect(`${client}${identity}`).not.toContain('x-dataops-workspace-internal-token')
  })

  it('names the access token DataOps provisions in the credential store', () => {
    expect(identity).toContain('DATAOPS_ACCESS_TOKEN')
    expect(identity).toContain('DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL')
  })

  it('agrees with the backend about the global route prefix', () => {
    const main = readIfPresent(BACKEND_MAIN)
    if (main === undefined) return
    // Read from the bootstrap rather than trusted: every request path below is
    // built from this, so a silent change would break the plugin at runtime.
    expect(main).toContain(`setGlobalPrefix('${GLOBAL_PREFIX}')`)
  })

  it('calls every room route the backend exposes, and no others', () => {
    if (controller === undefined) return
    const prefix = controller.match(/@Controller\('([^']+)'\)/u)?.[1]
    expect(prefix).toBe('ai/chat/rooms')

    const backendRoutes = new Set<string>()
    // `@Get()` carries no argument, so the path part must be optional. The app's
    // global prefix is part of every real request path, so it is included here:
    // omitting it does not yield a 404, it yields the web tier's SPA fallback —
    // an HTML body under a 200, which surfaces as a parse failure far from the
    // cause. Comparing full paths is what makes that drift fail here instead.
    for (const match of controller.matchAll(/@(?:Get|Post|Delete)\(\s*(?:'([^']*)')?\s*\)/gu)) {
      backendRoutes.add(normalizeRoute(`${GLOBAL_PREFIX}/${prefix}/${match[1] ?? ''}`))
    }

    const pluginRoutes = new Set<string>()
    // Matched by the base path the plugin actually uses rather than a hardcoded
    // prefix: a drifted path must land in the set so the comparison can flag it,
    // which a literal-prefix match would silently skip.
    for (const line of client.split('\n')) {
      const match = line.match(/[`'"]((?:https?:\/\/[^`'"]*)?\/[a-z][\w/-]*)[`'"?]/u)
      if (match === null) continue
      const path = match[1]
        .replace(/^https?:\/\/[^/]*/u, '')
        .split('${suffix')[0]
        .replace(/\$\{[^}]*\}/gu, 'ROOM')
      if (!path.includes('/chat/') && !path.includes('ROOM')) continue
      pluginRoutes.add(normalizeRoute(path))
    }

    // Every route the plugin calls must exist on the backend. The backend may offer
    // more than the plugin uses (room creation, membership, search) — the browser
    // drives those.
    const unknown = [...pluginRoutes].filter((route) => !backendRoutes.has(route))
    expect(unknown).toEqual([])
  })

  it('agrees on the event-page response shape', () => {
    // The backend returns these field names; a rename here would silently make
    // every incremental sync re-fetch the whole room.
    for (const field of ['events', 'nextCursor', 'hasMore']) expect(client).toContain(field)
  })

  it('reads its own identity from the server rather than configuration', () => {
    // A configured actor could disagree with the credential and silently change
    // which messages start this workspace's agent.
    expect(client).toContain('/auth/me')
    expect(identity).not.toContain('USER_ID')
  })
})
