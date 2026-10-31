/**
 * Connector state adapter: wire parsing, Host reads/writes, capability
 * projection, and task filtering by connector/capability.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTOR_ROUTE,
  fetchConnectorState,
  filterConnectorTasks,
  parseConnectorState,
  saveConnectorState,
  taskCapabilityId,
  taskConnectorId,
  visibleCapabilities,
} from '../src/client/connector-state.ts'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
  vi.restoreAllMocks()
})

describe('connector state parsing', () => {
  it('reads the Host boolean shape and keeps only permitted capabilities', () => {
    const state = parseConnectorState({
      enabled: true,
      capabilities: {
        'approval.push': true,
        'task.writeback': false,
        'admin.only': { enabled: true, permitted: false, reason: '管理员能力' },
      },
    })
    expect(state.enabled).toBe(true)
    expect(state.capabilities).toEqual({ 'approval.push': true, 'task.writeback': false })
  })

  it('carries a per-capability reason from either object entry or the reasons map', () => {
    const state = parseConnectorState({
      enabled: true,
      capabilities: { 'approval.push': { enabled: false, reason: '缺少凭据' } },
      reasons: { 'task.writeback': '未开通' },
    })
    expect(state.capabilities).toEqual({ 'approval.push': false })
    expect(state.reasons).toEqual({ 'approval.push': '缺少凭据', 'task.writeback': '未开通' })
  })

  it('treats a missing or malformed answer as disabled with no capabilities', () => {
    expect(parseConnectorState(null)).toEqual({ enabled: false, capabilities: {} })
    expect(parseConnectorState({ enabled: 'yes' })).toEqual({ enabled: false, capabilities: {} })
  })
})

describe('connector capability projection', () => {
  it('labels the known approval capability and humanizes an unknown one', () => {
    const rows = visibleCapabilities({
      enabled: true,
      capabilities: { 'approval.push': true, 'future.capability': false },
    })
    expect(rows.map(row => row.label)).toEqual(['接收审批任务', 'future capability'])
    expect(rows[0]?.enabled).toBe(true)
  })

  it('renders no rows when the account has no capabilities', () => {
    expect(visibleCapabilities(null)).toEqual([])
    expect(visibleCapabilities({ enabled: true, capabilities: {} })).toEqual([])
  })
})

describe('task projection', () => {
  const tasks = [
    { id: 'approval:1', sourceType: 'dataops_approval', source: { type: 'approval' } },
    { id: 'approval:2', sourceType: 'dataops_approval', source: { type: 'approval' }, connectorId: 'wanxiang-ai', capabilityId: 'approval.writeback' },
    { id: 'task:1', sourceType: 'task_bus', source: { type: 'manual' } },
  ] as const

  it('assigns an id-less DataOps approval row to the connector and approval.push', () => {
    expect(taskConnectorId(tasks[0])).toBe('wanxiang-ai')
    expect(taskCapabilityId(tasks[0])).toBe('approval.push')
    expect(taskConnectorId(tasks[2])).toBeUndefined()
  })

  it('filters by connector and capability', () => {
    expect(filterConnectorTasks(tasks, 'all').map(task => task.id)).toEqual(['approval:1', 'approval:2'])
    expect(filterConnectorTasks(tasks, 'approval.push').map(task => task.id)).toEqual(['approval:1'])
    expect(filterConnectorTasks(tasks, 'approval.writeback').map(task => task.id)).toEqual(['approval:2'])
  })
})

describe('connector Host calls', () => {
  it('reads state from the connector route', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      enabled: true,
      capabilities: { 'approval.push': true },
    }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchConnectorState()).resolves.toEqual({
      enabled: true,
      capabilities: { 'approval.push': true },
    })
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(CONNECTOR_ROUTE)
  })

  it('posts capability changes with the current enabled flag', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      enabled: true,
      capabilities: { 'approval.push': false },
    }), { status: 200 })) as unknown as typeof fetch
    await saveConnectorState({ enabled: true, capabilities: { 'approval.push': false } })
    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      capabilities: { 'approval.push': false },
    })
  })

  it('reports a rejected write instead of pretending the state changed', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(saveConnectorState({ enabled: true })).rejects.toThrow(/保存失败/u)
  })
})