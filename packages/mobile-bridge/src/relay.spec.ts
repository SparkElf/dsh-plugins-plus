import { describe, expect, it } from 'vitest'
import { relayToLocalWeb, type RelayRequest } from './index.ts'

describe('relayToLocalWeb', () => {
  const request: RelayRequest = { id: 'r1', kind: 'http', method: 'GET', path: '/api/x', headers: {}, body: '' }

  it('forwards status, body, and content type', async () => {
    const fake = (async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, fake)
    expect(response).toMatchObject({ id: 'r1', status: 200, body: 'hello' })
  })

  it('round-trips binary payloads as base64 both directions', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const fake = (async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
    const response = await relayToLocalWeb({ ...request, body: png.toString('base64'), bodyEncoding: 'base64' }, 3080, fake)
    expect(response.bodyEncoding).toBe('base64')
    expect(Buffer.from(response.body, 'base64')).toEqual(png)
  })

  it('answers 502 when the local web is unreachable', async () => {
    const failing = (async () => { throw new Error('econnrefused') }) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, failing)
    expect(response.status).toBe(502)
    expect(response.body).toContain('econnrefused')
  })
})
