import { describe, expect, it } from 'vitest'
import { relayToLocalWeb, type RelayRequest } from './index.ts'

describe('relayToLocalWeb', () => {
  const request: RelayRequest = { id: 'r1', kind: 'http', method: 'GET', path: '/api/x', headers: {}, body: '' }

  it('forwards status, body, and content type', async () => {
    const fake = (async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, fake)
    expect(response).toMatchObject({ id: 'r1', status: 200, body: 'hello' })
  })

  it('answers 502 when the local web is unreachable', async () => {
    const failing = (async () => { throw new Error('econnrefused') }) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, failing)
    expect(response.status).toBe(502)
    expect(response.body).toContain('econnrefused')
  })
})
