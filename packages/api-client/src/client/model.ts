import type { ApiMultipartPart, ApiResponse } from '../types.ts'

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
