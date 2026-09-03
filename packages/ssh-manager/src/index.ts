import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SshContext } from './context.ts'
import { SshManagerStore } from './store.ts'
import { testSshHost } from './transport.ts'
import type { SshCluster, SshCommandRequest, SshCredentialInput, SshHost } from './types.ts'

export * from './types.ts'
export { SshManagerStore } from './store.ts'
export { fingerprintFromHash, sshConnectConfig, testSshHost } from './transport.ts'
export const name = 'ssh-manager'
export const inject = ['webServer', 'tools']

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
function toolJson<T>(value: T): Record<string, ToolJson> { return value as unknown as Record<string, ToolJson> }

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function publicHost(host: SshHost): Record<string, ToolJson> {
  const { credentialId: _credentialId, ...metadata } = host
  return metadata as unknown as Record<string, ToolJson>
}

/** Register persistent host inventory APIs and sanitized model tools. */
export function apply(ctx: SshContext): void {
  const store = new SshManagerStore()
  const logger = ctx.logger as unknown as { error(...args: unknown[]): void }
  const methods: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    state: () => store.state(),
    'clusters.save': async payload => { await store.saveCluster(payload.cluster as SshCluster); return store.state() },
    'clusters.delete': async payload => { await store.deleteCluster(String(payload.clusterId)); return store.state() },
    'hosts.save': async payload => { await store.saveHost(payload.host as SshHost, payload.credential as SshCredentialInput | undefined); return store.state() },
    'hosts.delete': async payload => { await store.deleteHost(String(payload.hostId)); return store.state() },
    'hosts.get': async payload => publicHost(await store.host(String(payload.hostId))),
    'hosts.test': async payload => testSshHost(store, String(payload.hostId)),
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-ssh-manager/api', handler: async (req, res) => {
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/dsh-ssh-manager/api/'.length)
    try {
      const handler = methods[method]
      if (handler === undefined) throw new Error('Unknown SSH Manager API method: ' + method)
      writeJson(res, 200, await handler(await readBody(req)))
    } catch (error) {
      logger.error('[dsh-ssh-manager] API request failed', error)
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  } }), 'dsh-ssh-manager: HTTP API')

  const open = { type: 'object', additionalProperties: true } as const
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_list_hosts', description: 'List configured SSH hosts and clusters. Returns non-secret metadata only.', parameters: {}, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async () => { const state = await store.state(); return toolJson({ clusters: state.clusters, hosts: state.hosts.map(publicHost) }) } })), 'dsh-ssh-manager: list hosts tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_get_host', description: 'Read one SSH host by id. Credentials are never returned.', parameters: { host_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id: string }) => publicHost(await store.host(args.host_id)) })), 'dsh-ssh-manager: get host tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_prepare_command', description: 'Prepare but do not execute a guarded SSH command request for explicit user review.', parameters: { host_ids: { type: 'array', items: { type: 'string' }, required: true }, command: { type: 'string', required: true }, timeout_ms: { type: 'number' } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_ids: string[]; command: string; timeout_ms?: number }) => { for (const id of args.host_ids) await store.host(id); const request: SshCommandRequest = { hostIds: args.host_ids, command: args.command, timeoutMs: args.timeout_ms ?? 60_000, confirmation: 'always' }; return toolJson({ request, executable: false, reason: 'Explicit user approval is required before remote execution.' }) } })), 'dsh-ssh-manager: prepare command tool')
}
