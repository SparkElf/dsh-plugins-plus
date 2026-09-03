import type { ApiMultipartPart, ApiRequest, ApiResponse } from '../types.ts'

export function responseForRequest(history: ApiResponse[], requestId: string | undefined, selectedResponseId: string | null): ApiResponse | null {
  if (requestId === undefined || requestId === '') return null
  const responses = history.filter(item => item.requestId === requestId)
  return responses.find(item => item.id === selectedResponseId) ?? responses[0] ?? null
}

export function readMultipartParts(content: string): ApiMultipartPart[] {
  if (content.trim() === '') return []
  try {
    const value = JSON.parse(content) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const part = item as Partial<ApiMultipartPart>
      if (typeof part.key !== 'string' || typeof part.value !== 'string') return []
      return [{ key: part.key, value: part.value, enabled: part.enabled !== false, type: part.type === 'file' ? 'file' : 'text', fileName: part.fileName, contentType: part.contentType, encoding: part.encoding }]
    })
  } catch { return [] }
}

export function writeMultipartParts(parts: ApiMultipartPart[]): string {
  return JSON.stringify(parts, null, 2)
}

export function cloneRequest(request: ApiRequest): ApiRequest {
  return {
    ...request,
    query: request.query.map(item => ({ ...item })),
    headers: request.headers.map(item => ({ ...item })),
    auth: { ...request.auth, options: { ...request.auth.options } },
    body: { ...request.body },
  }
}

export function requestFingerprint(request: ApiRequest): string {
  return JSON.stringify(request)
}

export function formatResponseBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return ''
  try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { return body }
}

export function responseCookies(response: ApiResponse): { name: string; value: string; attributes: string }[] {
  return response.headers
    .filter(header => header.enabled && header.key.toLowerCase() === 'set-cookie')
    .flatMap(header => header.value.split(/,(?=[^;,]+=)/))
    .map(value => {
      const [pair = '', ...attributes] = value.split(';')
      const separator = pair.indexOf('=')
      return {
        name: separator < 0 ? pair.trim() : pair.slice(0, separator).trim(),
        value: separator < 0 ? '' : pair.slice(separator + 1).trim(),
        attributes: attributes.map(item => item.trim()).join('; '),
      }
    })
    .filter(cookie => cookie.name !== '')
}
