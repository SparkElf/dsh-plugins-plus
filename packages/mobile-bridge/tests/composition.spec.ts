import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as mobileBridge from '../src/index.ts'
import type { MobileBridgeConfig } from '../src/index.ts'

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => void
}

/** Real cordis composition: the web server seam is stubbed, the runtime is real. */
describe('dsh-mobile-bridge composition', () => {
  it('registers the /mobile overlay route and disposes cleanly', async () => {
    const routes: CapturedRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    } as never)
    const config: MobileBridgeConfig = { serverUrl: '', localPort: 3080, userKey: '', autoConnect: false, autoReconnect: false, ownerEmail: '', emailTwoFactor: false }
    const fiber = ctx.plugin(mobileBridge, config)
    await fiber
    expect(routes.map(route => route.path)).toEqual(['/mobile'])

    let status = 0
    let body = ''
    routes[0].handler({ url: '/mobile/bridge/style.css' }, {
      writeHead(code) { status = code },
      end(out) { body = out },
    })
    expect(status).toBe(200)
    expect(body).toContain('max-width: 720px')

    routes[0].handler({ url: '/mobile/bridge/panel' }, {
      writeHead(code) { status = code },
      end(out) { body = out },
    })
    expect(status).toBe(404)
    expect(body).toBe('not found')

    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })
})
