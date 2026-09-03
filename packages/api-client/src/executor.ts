import { randomUUID } from 'node:crypto'
import type { ApiAuthSecretInput, ApiKeyValue, ApiRequest, ApiResponse } from './types.ts'
import { ApiClientStore } from './store.ts'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/gu

function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(TEMPLATE, (_match, key: string) => {
    if (!(key in variables)) throw new Error('API environment variable is not defined: ' + key)
    return variables[key] as string
  })
}

function enabled(values: ApiKeyValue[], variables: Record<string, string>): ApiKeyValue[] {
  return values.filter(value => value.enabled).map(value => ({ ...value, key: interpolate(value.key, variables), value: interpolate(value.value, variables) }))
}

function applyAuth(headers: Headers, url: URL, request: ApiRequest, secret: ApiAuthSecretInput | undefined): void {
  const kind = request.auth.kind
  if (kind === 'none' || kind === 'inherit') return
  if (secret === undefined) throw new Error('API authorization credential is not configured')
  if (kind === 'basic') {
    headers.set('authorization', 'Basic ' + Buffer.from((secret.username ?? '') + ':' + (secret.password ?? '')).toString('base64'))
    return
  }
  if (kind === 'bearer' || kind === 'oauth2') {
    if (!secret.token) throw new Error('API bearer token is not configured')
    headers.set('authorization', 'Bearer ' + secret.token)
    return
  }
  if (kind === 'api-key') {
    const name = request.auth.options.name?.trim()
    if (!name || !secret.key) throw new Error('API key name and value are required')
    if (request.auth.options.location === 'query') url.searchParams.set(name, secret.key)
    else headers.set(name, secret.key)
    return
  }
  throw new Error('AWS SigV4 execution is not implemented yet')
}

function requestBody(request: ApiRequest, variables: Record<string, string>, headers: Headers): string | undefined {
  const body = interpolate(request.body.content, variables)
  if (request.body.kind === 'none') return undefined
  if (request.body.kind === 'json') { if (!headers.has('content-type')) headers.set('content-type', 'application/json'); JSON.parse(body); return body }
  if (request.body.kind === 'graphql') { if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return JSON.stringify({ query: body }) }
  if (request.body.kind === 'form') { if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded'); return body }
  if (request.body.kind === 'xml') { if (!headers.has('content-type')) headers.set('content-type', 'application/xml'); return body }
  if (request.body.kind === 'text') { if (!headers.has('content-type')) headers.set('content-type', 'text/plain'); return body }
  throw new Error('Multipart and binary request bodies are not implemented yet')
}

async function boundedBody(response: Response): Promise<{ body: string; bytes: number; truncated: boolean }> {
  if (response.body === null) return { body: '', bytes: 0, truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = MAX_RESPONSE_BYTES - bytes
    if (remaining <= 0) { truncated = true; await reader.cancel(); break }
    chunks.push(value.byteLength <= remaining ? value : value.subarray(0, remaining))
    bytes += Math.min(value.byteLength, remaining)
    if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break }
  }
  const body = new TextDecoder(response.headers.get('content-type')?.match(/charset=([^;]+)/iu)?.[1] ?? 'utf-8').decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  return { body, bytes, truncated }
}

export async function executeApiRequest(store: ApiClientStore, requestId: string): Promise<ApiResponse> {
  const request = await store.request(requestId)
  const variables = await store.environmentValues(request.environmentId)
  const url = new URL(interpolate(request.url, variables))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API Client only supports HTTP and HTTPS URLs')
  if (url.username !== '' || url.password !== '') throw new Error('Credentials in API URLs are not allowed; use the authorization editor')
  for (const item of enabled(request.query, variables)) url.searchParams.append(item.key, item.value)
  const headers = new Headers(enabled(request.headers, variables).map(item => [item.key, item.value] as [string, string]))
  applyAuth(headers, url, request, await store.authSecret(request))
  const body = requestBody(request, variables, headers)
  const started = performance.now()
  const response = await fetch(url, { method: request.method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  const payload = await boundedBody(response)
  const result: ApiResponse = {
    id: randomUUID(), requestId: request.id, status: response.status, statusText: response.statusText,
    durationMs: Math.round(performance.now() - started), sizeBytes: Number(response.headers.get('content-length') ?? payload.bytes),
    headers: [...response.headers.entries()].map(([key, value]) => ({ key, value, enabled: true })), body: payload.body, bodyTruncated: payload.truncated, receivedAt: Date.now(),
  }
  await store.addHistory(result)
  return result
}
