export const SSH_SECRET = 'ssh-vault-secret-system-test'
export const API_SECRET = 'api-bearer-secret-system-test'

const sshState = {
  clusters: [{ id: 'cluster-prod', name: 'Production edge', description: 'Public edge fleet', tags: ['edge'], hostIds: ['host-edge'] }],
  hosts: [
    {
      id: 'host-edge',
      name: 'Edge gateway',
      description: 'Primary production gateway',
      tags: ['production', 'gateway'],
      clusterId: 'cluster-prod',
      environment: 'production',
      hostname: 'edge.internal.example',
      port: 2222,
      username: 'deploy',
      authKind: 'private-key',
      credentialId: SSH_SECRET,
      credentialConfigured: true,
      jumpHostId: null,
      knownHostFingerprint: 'SHA256:system-test-fingerprint',
      keepAliveSeconds: 30,
    },
    {
      id: 'host-dev',
      name: 'Development worker',
      description: 'Unclustered build worker',
      tags: ['development', 'worker'],
      clusterId: null,
      environment: 'development',
      hostname: 'worker.internal.example',
      port: 22,
      username: 'builder',
      authKind: 'password',
      credentialId: null,
      credentialConfigured: false,
      jumpHostId: null,
      knownHostFingerprint: null,
      keepAliveSeconds: 30,
    },
  ],
}

const apiRequest = {
  id: 'request-profile',
  collectionId: 'collection-users',
  name: 'Get profile',
  description: 'Fetch the current user profile',
  method: 'GET',
  url: 'https://api.example.test/users/{{userId}}',
  query: [{ key: 'verbose', value: 'true', enabled: true }],
  headers: [
    { key: 'accept', value: 'application/json', enabled: true },
    { key: 'authorization', value: 'Bearer ' + API_SECRET, enabled: true },
  ],
  auth: { kind: 'bearer', credentialId: API_SECRET, options: {} },
  body: { kind: 'none', content: '' },
  environmentId: 'environment-local',
}

const apiState = {
  workspaces: [{ id: 'workspace-main', name: 'Platform APIs', description: 'System-test workspace', collectionIds: ['collection-users'], environmentIds: ['environment-local'] }],
  collections: [{ id: 'collection-users', workspaceId: 'workspace-main', parentId: null, name: 'Users', description: 'User endpoints', tags: ['identity'], requestIds: ['request-profile'] }],
  environments: [{ id: 'environment-local', workspaceId: 'workspace-main', name: 'Local mock', variables: [{ key: 'userId', value: '42', credentialId: null, enabled: true, secret: false }] }],
  requests: [apiRequest],
  history: [],
}

const terminal = {
  id: 'terminal-edge',
  hostId: 'host-edge',
  title: 'Edge gateway',
  cwd: '/srv/app',
  connectedAt: 1_700_000_000_000,
  state: 'connected',
  exited: false,
}

const response = {
  id: 'response-profile',
  requestId: 'request-profile',
  status: 200,
  statusText: 'OK',
  durationMs: 37,
  sizeBytes: 45,
  headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
  body: JSON.stringify({ id: 42, name: 'System Test User' }, null, 2),
  bodyTruncated: false,
  receivedAt: 1_700_000_000_100,
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function methodOf(request) {
  return new URL(request.url()).pathname.split('/').at(-1)
}

export async function installWorkbenchRoutes(page) {
  const calls = { ssh: [], api: [], terminal: [] }

  await page.route('**/integrations/dataops/managed-auth', route => route.fulfill({ status: 200, json: {} }))

  await page.route('**/dsh-ssh-manager/api/**', async route => {
    const request = route.request()
    const method = methodOf(request)
    const payload = request.postDataJSON() ?? {}
    calls.ssh.push({ method, payload })
    if (method === 'state') return route.fulfill({ json: clone(sshState) })
    if (method === 'terminals.list' || method === 'forwards.list') return route.fulfill({ json: [] })
    if (method === 'terminals.open') return route.fulfill({ json: { terminal: clone(terminal), terminals: [clone(terminal)] } })
    if (method === 'terminals.close') return route.fulfill({ json: [] })
    return route.fulfill({ status: 500, json: { error: 'Unexpected SSH system-test method: ' + method } })
  })

  await page.route('**/dsh-api-client/api/**', async route => {
    const request = route.request()
    const method = methodOf(request)
    const payload = request.postDataJSON() ?? {}
    calls.api.push({ method, payload })
    if (method === 'state') return route.fulfill({ json: clone(apiState) })
    if (method === 'requests.save') return route.fulfill({ json: clone(apiState) })
    if (method === 'requests.execute') {
      const state = clone(apiState)
      state.history = [clone(response)]
      return route.fulfill({ json: { response: clone(response), state } })
    }
    return route.fulfill({ status: 500, json: { error: 'Unexpected API system-test method: ' + method } })
  })

  await page.routeWebSocket('**/dsh-ssh-manager/terminal?**', socket => {
    socket.onMessage(message => {
      const value = JSON.parse(String(message))
      calls.terminal.push(value)
      if (value.type === 'input') socket.send(JSON.stringify({ type: 'data', data: value.data }))
    })
    socket.send(JSON.stringify({ type: 'data', data: 'connected to Edge gateway\r\n$ ' }))
    socket.send(JSON.stringify({ type: 'snapshot', value: terminal }))
  })

  return calls
}

export function responseBody() {
  return response.body
}
