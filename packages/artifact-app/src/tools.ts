/**
 * The nine model tools that drive cockpit artifacts.
 *
 * They are deliberately thin: every authorization and data decision stays on the
 * DataOps API, and the tools only shape a small JSON answer for the model. HTML is
 * read from the workspace, validated against the template contract, and published
 * through the same endpoint the browser uses.
 *
 * @module tools
 */

import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { packTemplateDir } from './client/pack.ts'
import type { Context } from '@deepseek-ai/cordis'
import { ArtifactApi, type GrantInput } from './api.ts'
import type { Config } from './config.ts'
import { assertCockpitHtml } from './templates.ts'
import type { OpenCockpitHub } from './open-hub.ts'

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
const toolJson = <T,>(value: T): Record<string, ToolJson> => value as unknown as Record<string, ToolJson>
const open = { type: 'object', additionalProperties: true } as const
const textOutput = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/** Everything the tools need from the plugin instance. */
export interface ToolDeps {
  ctx: Context
  api: ArtifactApi
  hub: OpenCockpitHub
  config: Config
}

/** Resolve a tool-supplied HTML path inside the configured workspace root. */
const resolveHtmlPath = (config: Config, htmlPath: string): string => {
  const root = resolve(config.workspaceRoot)
  const target = resolve(root, htmlPath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('html_path 必须位于工作区内：' + config.workspaceRoot)
  }
  return target
}

/** Read the cockpit HTML a publish call names. */
const readCockpitHtml = async (config: Config, htmlPath: string): Promise<string> => {
  const target = resolveHtmlPath(config, htmlPath)
  const html = await readFile(target, 'utf8')
  assertCockpitHtml(html, config.htmlMaxBytes)
  return html
}

/** Shape one app row for a tool answer. */
const appSummary = (app: { id: string; name: string; description?: string | null; catalog?: string | null; status: string; currentVersion: number; publishedVersion: number; refreshIntervalSeconds?: number; keepConnection?: boolean; canManage?: boolean; updatedAt: string }) => ({
  id: app.id,
  name: app.name,
  description: app.description ?? null,
  catalog: app.catalog ?? null,
  status: app.status,
  currentVersion: app.currentVersion,
  publishedVersion: app.publishedVersion,
  refreshIntervalSeconds: app.refreshIntervalSeconds ?? null,
  keepConnection: app.keepConnection ?? false,
  canManage: app.canManage ?? false,
  updatedAt: app.updatedAt,
})

/**
 * Register the cockpit tools on one plugin instance.
 * @param deps - API client, SSE hub and host config.
 */
export function registerCockpitTools(deps: ToolDeps): void {
  const { ctx, api, hub, config } = deps

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'artifact_template_list',
    description: 'List the published cockpit templates (id, name, catalog, slots, question). Call this before writing cockpit HTML; pick a template instead of writing a layout from scratch.',
    parameters: {},
    output: { schema: open, render: textOutput },
    execute: async () => {
      const rows = await api.listTemplates()
      return toolJson({
        ok: true,
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          catalog: row.catalog ?? null,
          slots: row.contract?.slots ?? [],
          question: row.contract?.question ?? null,
          version: row.currentVersion ?? 1,
          updatedAt: row.updatedAt ?? null,
        })),
      })
    },
  })), 'artifact-app: template list tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'artifact_template_publish',
    description:
      'Publish a cockpit template from a directory in the workspace. The directory must contain template.json '
      + '(id/name/catalog/slots/question), template.html, and an optional assets/ folder. Reference assets in the HTML '
      + 'as asset://<logical-name> where <logical-name> is the file name without extension. The server validates the '
      + 'archive (path traversal, size, extension whitelist, SVG scripts) before storing it.',
    parameters: {
      directory: { type: 'string', required: true, description: 'Workspace-relative directory holding the template package.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { directory: string }) => {
      const dir = args.directory.trim()
      if (dir === '') throw new Error('directory 不能为空')
      const zip = await packTemplateDir(dir)
      const result = await api.publishTemplatePackage(zip.toString('base64'))
      return toolJson({
        ok: true,
        templateId: result.templateId,
        version: result.version,
        assets: result.assets,
        bytes: zip.byteLength,
        hint: '模板已发布。现在可以用 artifact_app_create 或 artifact_app_publish 引用 template_id 建应用。',
      })
    },
  })), 'artifact-app: template publish tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'artifact_template_get',
    description: 'Read one cockpit template: metadata, required slots, and its full HTML skeleton. Fill only the data-slot regions; never rewrite the artifactApp runtime or the required markers.',
    parameters: {
      template_id: { type: 'string', required: true, description: 'Template id from artifact_template_list.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { template_id: string }) => {
      const [meta, body] = await Promise.all([api.getTemplate(args.template_id), api.getTemplateHtml(args.template_id)])
      return toolJson({
        ok: true,
        id: meta.id,
        name: meta.name,
        description: meta.description ?? null,
        catalog: meta.catalog ?? null,
        slots: meta.contract?.slots ?? [],
        question: meta.contract?.question ?? null,
        version: body.version,
        html: body.html,
      })
    },
  })), 'artifact-app: template get tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_list',
    description: 'List cockpit apps the current user can see, newest first. Use it to find an existing cockpit before publishing a new one.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive name/description filter.' },
      catalog: { type: 'string', description: 'Catalog (folder) filter.' },
      status: { type: 'string', description: 'DRAFT or PUBLISHED.' },
      limit: { type: 'number', description: 'Maximum rows, default 20, max 50.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { query?: string; catalog?: string; status?: string; limit?: number }) => {
      const pageSize = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 20)))
      const page = await api.listApps({ q: args.query, catalog: args.catalog, status: args.status, page: 1, pageSize })
      return toolJson({ ok: true, total: page.total, items: page.items.map(appSummary) })
    },
  })), 'artifact-app: cockpit list tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_get',
    description: 'Read one cockpit by id: metadata, grants visibility, and optionally its published HTML.',
    parameters: {
      cockpit_id: { type: 'string', required: true },
      include_html: { type: 'boolean', description: 'Include the HTML the viewer would render.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { cockpit_id: string; include_html?: boolean }) => {
      const app = await api.getApp(args.cockpit_id)
      const answer: Record<string, unknown> = { ok: true, cockpit: appSummary(app) }
      if (args.include_html === true) {
        const body = await api.getAppHtml(app.id)
        answer.html = body.html
        answer.version = body.version
      }
      return toolJson(answer)
    },
  })), 'artifact-app: cockpit get tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_publish',
    description: 'Publish a cockpit from a workspace HTML file. Without artifact_id it creates and publishes a new cockpit; with artifact_id it publishes a new version. Validates the artifactApp markers and size first. Call only after the user explicitly confirms publishing.',
    parameters: {
      html_path: { type: 'string', required: true, description: 'Workspace path, e.g. /workspace/artifact-apps/sales.html or artifact-apps/sales.html.' },
      artifact_id: { type: 'string', description: 'Existing cockpit id; omit to create a new one.' },
      name: { type: 'string', description: 'Cockpit name; defaults to the existing name or the file name.' },
      description: { type: 'string' },
      catalog: { type: 'string' },
      template_id: { type: 'string' },
      template_version: { type: 'string' },
      refresh_interval_seconds: { type: 'number', description: 'Polling interval for the runtime, 5..86400.' },
      keep_connection: { type: 'boolean', description: 'Keep the viewer connected instead of timing out.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: {
      html_path: string
      artifact_id?: string
      name?: string
      description?: string
      catalog?: string
      template_id?: string
      template_version?: string
      refresh_interval_seconds?: number
      keep_connection?: boolean
    }) => {
      const html = await readCockpitHtml(config, args.html_path)
      const published = await api.publish({
        ...(args.artifact_id === undefined ? {} : { artifactId: args.artifact_id }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.catalog === undefined ? {} : { catalog: args.catalog }),
        ...(args.template_id === undefined ? {} : { templateId: args.template_id }),
        ...(args.template_version === undefined ? {} : { templateVersion: args.template_version }),
        html,
      })
      const metadata: Record<string, unknown> = {}
      if (args.refresh_interval_seconds !== undefined) metadata.refreshIntervalSeconds = Math.max(5, Math.min(86_400, Math.trunc(args.refresh_interval_seconds)))
      if (args.keep_connection !== undefined) metadata.keepConnection = args.keep_connection
      if (Object.keys(metadata).length > 0) {
        await api.patchApp(published.id, metadata as { refreshIntervalSeconds?: number; keepConnection?: boolean })
      }
      const app = await api.getApp(published.id)
      hub.broadcastUpdated({ cockpitId: published.id, nonce: randomUUID() })
      return toolJson({
        ok: true,
        id: published.id,
        version: published.version,
        publishedVersion: published.publishedVersion,
        created: published.created,
        name: app.name,
        refreshIntervalSeconds: args.refresh_interval_seconds ?? app.refreshIntervalSeconds ?? null,
        keepConnection: args.keep_connection ?? app.keepConnection ?? false,
      })
    },
  })), 'artifact-app: cockpit publish tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_open',
    description: 'Open a cockpit viewer in the right sidebar. Navigation only: it grants nothing and changes no data.',
    parameters: {
      cockpit_id: { type: 'string', required: true },
      mode: { type: 'string', description: 'focus (default) or detail.' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { cockpit_id: string; mode?: string }) => {
      const app = await api.getApp(args.cockpit_id)
      const mode = args.mode === 'detail' ? 'detail' : 'focus'
      const event = hub.broadcastOpen({ cockpitId: app.id, cockpitName: app.name, mode, nonce: randomUUID() })
      return toolJson({ ok: true, opened: true, subscribers: hub.size(), requestId: event.requestId, cockpitId: app.id })
    },
  })), 'artifact-app: cockpit open tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_update',
    description: 'Update cockpit metadata only (name, description, catalog, refresh interval, keep-connection). Never touches HTML; publish a file for content changes.',
    parameters: {
      cockpit_id: { type: 'string', required: true },
      name: { type: 'string' },
      description: { type: 'string' },
      catalog: { type: 'string' },
      refresh_interval_seconds: { type: 'number' },
      keep_connection: { type: 'boolean' },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: {
      cockpit_id: string
      name?: string
      description?: string
      catalog?: string
      refresh_interval_seconds?: number
      keep_connection?: boolean
    }) => {
      const patch: Record<string, unknown> = {}
      if (args.name !== undefined) patch.name = args.name
      if (args.description !== undefined) patch.description = args.description
      if (args.catalog !== undefined) patch.catalog = args.catalog
      if (args.refresh_interval_seconds !== undefined) patch.refreshIntervalSeconds = Math.max(5, Math.min(86_400, Math.trunc(args.refresh_interval_seconds)))
      if (args.keep_connection !== undefined) patch.keepConnection = args.keep_connection
      if (Object.keys(patch).length === 0) throw new Error('cockpit_update 至少需要一个要修改的字段')
      await api.patchApp(args.cockpit_id, patch)
      hub.broadcastUpdated({ cockpitId: args.cockpit_id, nonce: randomUUID() })
      return toolJson({ ok: true, cockpit: appSummary(await api.getApp(args.cockpit_id)) })
    },
  })), 'artifact-app: cockpit update tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_delete',
    description: 'Soft-delete one cockpit after explicit user approval. Deletion is reversible only by an administrator.',
    parameters: {
      cockpit_id: { type: 'string', required: true },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { cockpit_id: string }, exec: ToolRunContext) => {
      if (exec.agent === undefined) throw new Error('cockpit_delete requires an initiating agent')
      const app = await api.getApp(args.cockpit_id)
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: 'cockpit_delete',
        callId: exec.callId,
        signal: exec.signal,
        reason: '删除驾驶舱「' + app.name + '」（' + app.id + '）',
      })
      if (outcome !== 'allowed-once') throw new Error('删除未获批准：' + outcome)
      await api.deleteApp(app.id)
      return toolJson({ ok: true, deleted: app.id, name: app.name })
    },
  })), 'artifact-app: cockpit delete tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cockpit_grant',
    description: 'Replace one cockpit\'s grants. Only call when the user names the principals and their access; never share automatically.',
    parameters: {
      cockpit_id: { type: 'string', required: true },
      grants: {
        type: 'array',
        required: true,
        description: 'Full desired grant list; it replaces the current grants.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            principal_type: { type: 'string', enum: ['USER', 'ROLE', 'DEPARTMENT'], required: true },
            principal_id: { type: 'string', required: true },
            action: { type: 'string', enum: ['READ', 'MANAGE'], required: true },
          },
        },
      },
    },
    output: { schema: open, render: textOutput },
    execute: async (args: { cockpit_id: string; grants: Array<{ principal_type: string; principal_id: string; action: string }> }) => {
      const grants: GrantInput[] = args.grants.map((grant) => {
        const principalType = grant.principal_type.toUpperCase()
        const action = grant.action.toUpperCase()
        if (principalType !== 'USER' && principalType !== 'ROLE' && principalType !== 'DEPARTMENT') {
          throw new Error('principal_type 必须是 USER / ROLE / DEPARTMENT')
        }
        if (action !== 'READ' && action !== 'MANAGE') throw new Error('action 必须是 READ / MANAGE')
        return { principalType, principalId: grant.principal_id, action }
      })
      const result = await api.putGrants(args.cockpit_id, grants)
      return toolJson({ ok: true, ownerId: result.ownerId, grants: result.grants })
    },
  })), 'artifact-app: cockpit grant tool')
}