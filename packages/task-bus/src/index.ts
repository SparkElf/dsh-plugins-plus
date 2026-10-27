/**
 * DataOps Task Center bridge for a managed DSH workspace.
 *
 * Approval tasks remain owned by DataOps. This plugin never stores or mutates
 * approval state; it proxies the Task Center read/action API with the workspace
 * principal and exposes the same surface to the agent as tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'task-bus'
export const inject = ['webServer', 'tools', 'sessionController', 'credentials']

export const TASK_BUS_ROUTE = '/dsh-task-bus/api'
const TASK_CENTER_PATH = '/api/task-center'
const DATAOPS_CREDENTIAL_REF = 'DATAOPS_ACCESS_TOKEN'

type RequestLike = { url?: string; method?: string; on?: unknown }
type ResponseLike = {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

interface TaskBusHost {
  credentials: {
    resolve(ref: unknown): Promise<{ value?: string } | undefined>
  }
  sessionController: {
    create(request: { sessionId: string; cwd?: string }): Promise<{ sessionId: string }>
    resolveAgent(sessionId: string): Promise<{ agent?: { followup(message: unknown): void } } | { agent: { followup(message: unknown): void } }>
  }
  webServer: {
    register(options: {
      kind: 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => Promise<void>
    }): () => void
  }
  tools: {
    register(tool: unknown): () => void
  }
}

const resolveBase = () => {
  const base = process.env.DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL?.trim().replace(/\/+$/u, '')
  if (!base) throw new Error('DataOps Task Center is not configured in this workspace')
  return base
}


/** Make approval links usable inside the DataOps iframe, where `/tasks` is not this origin. */
const absoluteApprovalLinks = (payload: unknown): unknown => {
  const origin = process.env.DATAOPS_PUBLIC_APP_ORIGIN?.trim().replace(/\/+$/u, '')
  if (!origin || payload === null || typeof payload !== 'object') return payload
  const fix = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    const item = value as { source?: { deepLink?: unknown } }
    if (item.source !== undefined && typeof item.source.deepLink === 'string' && item.source.deepLink.startsWith('/')) {
      item.source.deepLink = origin + item.source.deepLink
    }
  }
  const record = payload as { item?: unknown; items?: unknown[] }
  fix(record.item)
  for (const item of record.items ?? []) fix(item)
  return payload
}

const createTaskCenterClient = (host: TaskBusHost) => {
  const base = resolveBase()
  return async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const resolved = await host.credentials.resolve(credentialRef(DATAOPS_CREDENTIAL_REF))
    const token = resolved?.value?.trim()
    if (!token) throw new Error('DataOps Task Center credential is not configured')
    const response = await fetch(base + TASK_CENTER_PATH + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) as unknown : null
    if (!response.ok) {
      const message = payload !== null && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Task Center request failed (${response.status})`
      throw new Error(message)
    }
    return payload
  }
}

const readJsonBody = async (request: RequestLike) => {
  if (request.on === undefined) return undefined
  let body = ''
  for await (const chunk of request as AsyncIterable<unknown>) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
  }
  return body.trim() ? JSON.parse(body) as unknown : undefined
}

const writeJson = (response: ResponseLike, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const taskListPath = (search: string) => {
  const params = new URLSearchParams(search)
  if (!params.has('status')) params.set('status', 'all')
  return '/items?' + params.toString()
}

const genericListPath = (search: string) => {
  const params = new URLSearchParams(search)
  if (!params.has('scope')) params.set('scope', 'mine')
  if (!params.has('pageSize')) params.set('pageSize', '20')
  return '/generic?' + params.toString()
}

const open = { type: 'object', additionalProperties: true } as const

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
) => defineTool({
  name,
  description,
  parameters: parameters as never,
  output: { schema: open, render: renderJson },
  execute: (async (args: Record<string, unknown>) => execute(args)) as never,
})

export const apply = (ctx: Context) => {
  const host = ctx as unknown as TaskBusHost
  const client = createTaskCenterClient(host)

  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: TASK_BUS_ROUTE,
    handler: async (rawRequest, rawResponse) => {
      const request = rawRequest as RequestLike
      const response = rawResponse as ResponseLike
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const route = url.pathname.slice(TASK_BUS_ROUTE.length).replace(/^\/+/u, '')
      try {
        if (request.method === 'GET' && route === 'health') {
          resolveBase()
          writeJson(response, 200, { ok: true, source: 'dataops_approval' })
          return
        }
        if (request.method === 'GET' && route === 'overview') {
          writeJson(response, 200, absoluteApprovalLinks(await client('/overview')))
          return
        }
        if (request.method === 'GET' && route === 'count') {
          writeJson(response, 200, await client('/count'))
          return
        }
        if (request.method === 'GET' && route === 'attachment') {
          const taskId = url.searchParams.get('taskId')?.trim() ?? ''
          const attachmentId = url.searchParams.get('attachmentId')?.trim() ?? ''
          if (!/^\d+$/u.test(taskId) || !/^[0-9a-fA-F-]{36}$/u.test(attachmentId)) {
            throw new Error('attachment requires numeric taskId and UUID attachmentId')
          }
          const resolved = await host.credentials.resolve(credentialRef(DATAOPS_CREDENTIAL_REF))
          const token = resolved?.value?.trim()
          if (!token) throw new Error('DataOps Task Center credential is not configured')
          const upstream = await fetch(
            resolveBase() + '/api/tasks/' + encodeURIComponent(taskId)
              + '/attachments/' + encodeURIComponent(attachmentId) + '/download',
            { headers: { authorization: `Bearer ${token}` } },
          )
          if (!upstream.ok) {
            const text = await upstream.text()
            throw new Error(text || `Attachment download failed (${upstream.status})`)
          }
          const buffer = Buffer.from(await upstream.arrayBuffer())
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
            'content-length': String(buffer.length),
            'cache-control': 'private, no-store',
          })
          response.end(buffer)
          return
        }
        if (request.method === 'GET' && route === 'items') {
          writeJson(response, 200, absoluteApprovalLinks(await client(taskListPath(url.search))))
          return
        }
        if (request.method === 'GET' && route === 'generic') {
          writeJson(response, 200, await client(genericListPath(url.search)))
          return
        }
        if (request.method === 'POST' && route === 'ai-accept') {
          const body = await readJsonBody(request) as { id?: unknown; prompt?: unknown } | undefined
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!id) throw new Error('ai-accept requires a task id')
          const task = id.startsWith('approval:')
            ? await client(`/items/${encodeURIComponent(id)}`)
            : id.startsWith('task:')
              ? await client(`/generic/${encodeURIComponent(id.slice(5))}`)
              : null
          if (task === null) throw new Error('ai-accept requires an approval:<id> or task:<uuid> id')
          const card = (task as { item?: { title?: string; source?: { label?: string }; sourceType?: string } }).item
          const title = card?.title ?? id
          const sessionId = `task-bus-${crypto.randomUUID()}`
          await host.sessionController.create({
            sessionId,
            ...(process.env.DATAOPS_AI_WORKSPACE_MOUNT_PATH === undefined
              ? {}
              : { cwd: process.env.DATAOPS_AI_WORKSPACE_MOUNT_PATH }),
          })
          const resolved = await host.sessionController.resolveAgent(sessionId)
          const agent = 'agent' in resolved ? resolved.agent : undefined
          if (agent === undefined) throw new Error('无法为任务绑定 AI 会话')
          const prompt = String(body?.prompt ?? '')
            || `这是 DataOps 任务「${title}」（${id}），来源：${card?.source?.label ?? card?.sourceType ?? 'Task Center'}。请先阅读任务上下文，整理材料并给出办理建议；不要替审批人通过、驳回或提交审批。`
          agent.followup(createUserMessage({
            source: { kind: 'task-bus', taskId: id } as never,
            content: [{ type: 'text', text: prompt }],
          }))
          writeJson(response, 201, { sessionId, taskId: id })
          return
        }
        const transition = /^generic\/([^/]+)\/transition$/u.exec(route)
        if (request.method === 'POST' && transition !== null) {
          writeJson(
            response,
            200,
            await client(`/generic/${encodeURIComponent(transition[1]!)}/transition`, 'POST', await readJsonBody(request)),
          )
          return
        }
        if (request.method === 'POST' && route === 'generic') {
          writeJson(response, 201, await client('/generic', 'POST', await readJsonBody(request)))
          return
        }
        const detail = /^generic\/([^/]+)$/u.exec(route)
        if (request.method === 'GET' && detail !== null) {
          writeJson(response, 200, await client(`/generic/${encodeURIComponent(detail[1]!)}`))
          return
        }
        const approval = /^items\/([^/]+)$/u.exec(route)
        if (request.method === 'GET' && approval !== null) {
          writeJson(response, 200, absoluteApprovalLinks(await client(`/items/${encodeURIComponent(decodeURIComponent(approval[1]!))}`)))
          return
        }
        writeJson(response, 404, { error: 'Unknown Task Bus route' })
      } catch (error) {
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'task-bus: browser API')

  ctx.effect(() => host.tools.register(tool(
    'task_center_list',
    'List DataOps Task Center cards visible to the current workspace user, including approval tasks and generic Task Bus tasks. Approval cards are read-only projections of DataOps tasks.',
    {
      status: { type: 'string', enum: ['all', 'pending', 'done'] },
      scope: { type: 'string', enum: ['mine', 'created', 'all'] },
      limit: { type: 'number' },
    },
    async (args) => {
      const status = typeof args.status === 'string' ? args.status : 'all'
      const scope = typeof args.scope === 'string' ? args.scope : 'mine'
      void scope
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20
      const result = absoluteApprovalLinks(await client('/overview')) as { items?: Array<{ status?: string }> }
      const items = (result.items ?? []).filter((item) => {
        if (status === 'pending') return item.status !== 'completed' && item.status !== 'cancelled'
        if (status === 'done') return item.status === 'completed' || item.status === 'cancelled'
        return true
      }).slice(0, limit)
      return { ...result, items, total: items.length }
    },
  )), 'task-bus: list tool')

  ctx.effect(() => host.tools.register(tool(
    'task_center_get',
    'Read one Task Center card by its stable id. Use approval:<id> for a DataOps approval task or task:<uuid> for a generic Task Bus task.',
    { id: { type: 'string', required: true } },
    async (args) => {
      const id = String(args.id ?? '')
      if (id.startsWith('approval:')) return client(`/items/${encodeURIComponent(id)}`)
      if (id.startsWith('task:')) return client(`/generic/${encodeURIComponent(id.slice(5))}`)
      throw new Error('Task Center id must start with approval: or task:')
    },
  )), 'task-bus: get tool')

  ctx.effect(() => host.tools.register(tool(
    'task_center_create',
    [
      'Create a generic Task Center card ONLY when the user explicitly asks you to create a task/card in this turn.',
      'Never call this tool proactively, speculatively, as a side effect of another request, or merely because work could be tracked.',
      'If the user did not explicitly ask for a new card, do not call it; ask for confirmation instead.',
      'This never creates or mutates a DataOps approval task.',
    ].join(' '),
    {
      title: { type: 'string', required: true },
      description: { type: 'string' },
      source_type: { type: 'string' },
      source_id: { type: 'string' },
      assignee_user_id: { type: 'string' },
      priority: { type: 'string' },
      user_requested: {
        type: 'boolean',
        required: true,
        description: 'Must be true only when the user explicitly requested creation of this card in the current turn.',
      },
    },
    async (args) => {
      if (args.user_requested !== true) {
        throw new Error('task_center_create requires an explicit user request; do not create Task Center cards proactively')
      }
      return client('/generic', 'POST', {
        title: String(args.title ?? ''),
        description: typeof args.description === 'string' ? args.description : undefined,
        sourceType: typeof args.source_type === 'string' ? args.source_type : 'agent',
        sourceId: typeof args.source_id === 'string' ? args.source_id : undefined,
        assigneeUserId: typeof args.assignee_user_id === 'string' ? args.assignee_user_id : undefined,
        priority: typeof args.priority === 'string' ? args.priority : undefined,
      })
    },
  )), 'task-bus: create tool')

  ctx.effect(() => host.tools.register(tool(
    'task_center_transition',
    'Advance a generic Task Bus task. Approval tasks must be handled through the existing DataOps approval UI and APIs; this tool refuses approval ids.',
    {
      id: { type: 'string', required: true },
      action: {
        type: 'string',
        required: true,
        enum: ['accept', 'start', 'submit', 'complete', 'cancel', 'block', 'unblock'],
      },
      comment: { type: 'string' },
    },
    async (args) => {
      const id = String(args.id ?? '')
      if (!id.startsWith('task:')) throw new Error('Only generic task:<uuid> cards can be transitioned here')
      return client(`/generic/${encodeURIComponent(id.slice(5))}/transition`, 'POST', {
        action: String(args.action ?? ''),
        comment: typeof args.comment === 'string' ? args.comment : undefined,
      })
    },
  )), 'task-bus: transition tool')
}