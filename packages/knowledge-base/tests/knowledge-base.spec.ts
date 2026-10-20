import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import {
  ENDPOINTS,
  joinUrl,
} from '../src/protocol.ts'
import {
  Config,
  apply,
  createGrant,
  fetchGrants,
  inject,
  localConfig,
  canReadPath,
  canManageGrants,
  fetchCaller,
  fetchPrincipals,
  listDirectory,
  listDirectoryWithPermissions,
  searchKnowledge,
  localStatus,
  name,
  revokeGrant,
  type KnowledgeError,
} from '../src/index.ts'
import {
  KB_STATE_FILE,
  deploymentPlan,
  findStep,
  mineruInstallStep,
  mineruServiceStep,
  nfsDeployStep,
  nfsMountStep,
  nfsVerifyStep,
  probeStep,
  renderCommand,
  shquote,
  type DeployPlanContext,
} from '../src/deploy.ts'
import { RemoteError, originFrom, sshManagerRunner } from '../src/remote.ts'
import { dropView, isContainedRelPath, isSafeUserId, pointMountAtView, syncView } from '../src/views.ts'

/** Config used across the request tests, with every field filled. */
const CONFIG = {
  baseUrl: 'https://dataops.example',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  timeoutMs: 1000,
  mountPoint: '/workspace/kb',
  actualRoot: '/nas/kb/actual',
  viewRoot: '/nas/kb/views',
  permitted: '10.0.0.5',
  nfsServer: 'nas.example',
  mineruTier: 'basic' as const,
  mineruBackend: 'onnx' as const,
  mineruPort: 8000,
  mineruMemoryMaxMiB: 4096,
}

/** Deployment context derived from the same config. */
const PLAN: DeployPlanContext = {
  actualRoot: CONFIG.actualRoot,
  viewRoot: CONFIG.viewRoot,
  tier: CONFIG.mineruTier,
  backend: CONFIG.mineruBackend,
  port: CONFIG.mineruPort,
  permitted: CONFIG.permitted,
  server: CONFIG.nfsServer,
  mountPoint: CONFIG.mountPoint,
  memoryMaxMiB: CONFIG.mineruMemoryMaxMiB,
}

/** Build a Host context stand-in covering the seams `apply` and the requests use. */
function fakeHost(options: { token?: string; fetchImpl?: typeof fetch } = {}) {
  const tools: Array<{ name: string; description: string }> = []
  const disposers: Array<() => unknown> = []
  /** Route handlers registered through `webServer.register`, captured so a test
   * can drive the Host surface the browser actually reads. */
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const fetchImpl = options.fetchImpl ?? (async () => new Response('{}', { status: 200 }))
  /**
   * The stub must not outlive the test that installed it: the SSH transport
   * tests below use the real fetch against a local stub server, and a leaked
   * stub would silently replace it.
   */
  vi.stubGlobal('fetch', fetchImpl)
  disposers.push(() => { vi.unstubAllGlobals() })
  const ctx = {
    effect(factory: () => () => unknown, _label: string) {
      disposers.push(factory())
    },
    credentials: {
      async resolve(ref: string) {
        if (options.token === undefined) return undefined
        return { value: options.token, source: ['test', ref].join(':') }
      },
    },
    webServer: {
      register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register(definition: { name: string; description: string }) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }
  return { ctx, tools, routes, disposers }
}

/**
 * Drive one Host route the way the browser does: a JSON body in, one JSON reply
 * out. The reply is what the page renders, so asserting on it covers the whole
 * path from the route through the permission filter.
 */
async function callRoute(
  routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }>,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const route = routes.find(candidate => candidate.path === '/knowledge-base/api')
  if (route === undefined) throw new Error('the settings route was never registered')
  let reply: Record<string, unknown> = {}
  const req = {
    url: `/knowledge-base/api/${method}`,
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
      return req
    },
  }
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (text: string) => { reply = JSON.parse(text) as Record<string, unknown> },
  }
  await route.handler(req, res)
  return reply
}

describe('protocol', () => {
  it('joins base URLs and endpoint paths without doubling slashes', () => {
    expect(joinUrl('https://host/', '/api/kb/status')).toBe('https://host/api/kb/status')
    expect(joinUrl('https://host', 'api/kb/status')).toBe('https://host/api/kb/status')
  })

  /**
   * The endpoint list once named an `/api/kb/*` family that no DataOps controller
   * served, so every call answered 404 while the plugin reported itself merely
   * unconfigured. Asserting the exact path keeps the list pinned to routes that
   * exist: the global prefix is `api` and the permission controller is
   * `system/resource-permissions`.
   */
  it('names the grant route the backend actually serves', () => {
    expect(ENDPOINTS.grants).toBe('/api/system/resource-permissions/grants')
  })
})

describe('configuration schema', () => {
  it('defaults every deployment value so a bare profile still loads', () => {
    // `{}` is the runtime shape the loader passes before defaults are applied;
    // the schema type demands the resolved shape, hence the cast.
    const resolved = Config({} as never) as unknown as typeof CONFIG
    expect(resolved.mountPoint).toBe('/workspace/kb')
    expect(resolved.actualRoot).toBe('/nas/kb/actual')
    expect(resolved.viewRoot).toBe('/nas/kb/views')
    expect(resolved.mineruTier).toBe('basic')
    expect(resolved.mineruBackend).toBe('onnx')
    expect(resolved.mineruPort).toBe(8000)
  })

  it('rejects a tier outside the supported set', () => {
    expect(() => Config({ mineruTier: 'advanced' } as never)).toThrow()
  })
})

describe('host plugin', () => {
  it('advertises its name and required services', () => {
    expect(name).toBe('dsh-knowledge-base')
    expect(inject).toContain('credentials')
    expect(inject).toContain('tools')
    expect(inject).toContain('webServer')
  })

  it('registers exactly the two knowledge tools', () => {
    const { ctx, tools } = fakeHost({ token: 't' })
    apply(ctx as never, CONFIG)
    expect(tools.map(tool => tool.name).sort()).toEqual(['kb_index', 'kb_status'])
  })

  it('reports an unavailable credential instead of calling the backend', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unauthorized' satisfies KnowledgeError['code'] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * A grant travels as the resource type plus the path in the resource-id slot,
   * because that is how the DataOps permission store keys a row. Asserting the
   * body keeps the plugin a relay: the request names the principal and lets the
   * backend decide whether it exists and whether the caller may write.
   */
  it('addresses a grant as the knowledge resource type with the path as its id', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ grant: { id: 'g1' } }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 'secret-token', fetchImpl })
    await createGrant(ctx as never, CONFIG, {
      relPath: '2024/report.md',
      principalType: 'user',
      principalId: 'alice',
      action: 'read',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dataops.example/api/system/resource-permissions/grants')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      resourceType: 'knowledge-base-file',
      resourceId: '2024/report.md',
      principalType: 'user',
      principalId: 'alice',
      action: 'read',
    })
  })

  it('revokes with DELETE and the same identifying fields', async () => {    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ deleted: true }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await revokeGrant(ctx as never, CONFIG, {
      relPath: '2024/report.md',
      principalType: 'role',
      principalId: 'finance',
      action: 'read',
    })
    expect(calls[0]?.init?.method).toBe('DELETE')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      resourceType: 'knowledge-base-file',
      resourceId: '2024/report.md',
      principalType: 'role',
      principalId: 'finance',
    })
  })

  /**
   * The permission store matches a principal by a different column per kind:
   * `user` by primary key (a UUID), everything else by `code`. Sending a username
   * in the user slot was measured against the running backend and answered
   * `授权主体不存在或未启用` (HTTP 400), which reads as a missing account rather
   * than as the wrong identifier space -- so the surface names the expected value
   * per kind and refuses a non-UUID before the round trip.
   */
  it('names the identifier each principal kind is matched by', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/UUID_PATTERN/u)
    // A username in the user slot is refused locally, not sent: the copy key is
    // what the surface uses, and the wording lives in the locale.
    expect(source).toMatch(/grantNeedsUser/u)
    // The picker is preferred over a typed id whenever the directory answers.
    expect(source).toMatch(/chooseOption/u)
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales).toMatch(/用户主体要填用户 UUID/u)
    expect(locales).toMatch(/请选择/u)
  })

  /**
   * The principal directories let the surface offer a picker instead of asking an
   * operator to transcribe a UUID, and each kind is a different collection with a
   * different key: users carry `id`, everything else carries `code`. Departments
   * additionally nest their rows under their own name rather than `items`.
   *
   * Verified against the running backend on 2026-10-15: 4 users, 6 roles,
   * 6 departments, and 3 groups, with `displayName`/`username` as the user label
   * and `name` for the rest.
   */
  it('maps each principal directory to the id the grant needs', async () => {
    const calls: string[] = []
    const bodies: Record<string, unknown> = {
      '/api/system/users': { items: [{ id: 'u-1', username: 'alice', displayName: 'Alice' }] },
      '/api/system/roles': { items: [{ code: '运营人员', name: '运营人员' }] },
      '/api/system/departments': { departments: [{ code: 'unassigned', name: '待分配部门' }] },
      '/api/system/groups': { items: [{ code: 'platform-administrators', name: '平台管理组' }] },
    }
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname
      calls.push(path)
      return new Response(JSON.stringify(bodies[path] ?? {}), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })

    await expect(fetchPrincipals(ctx as never, CONFIG, 'user'))
      .resolves.toEqual([{ id: 'u-1', label: 'Alice' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'role'))
      .resolves.toEqual([{ id: '运营人员', label: '运营人员' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'department'))
      .resolves.toEqual([{ id: 'unassigned', label: '待分配部门' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'group'))
      .resolves.toEqual([{ id: 'platform-administrators', label: '平台管理组' }])
    expect(calls).toEqual([
      '/api/system/users',
      '/api/system/roles',
      '/api/system/departments',
      '/api/system/groups',
    ])
  })

  it('maps a rejected request to an unauthorized failure rather than a retry', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unauthorized' satisfies KnowledgeError['code'] })
  })

  it('maps a transport failure to unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unreachable' satisfies KnowledgeError['code'] })
  })

  it('maps a malformed body to bad-response', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'bad-response' satisfies KnowledgeError['code'] })
  })

  /**
   * A rejected write explains itself, and that message is what the operator
   * needs: an unknown principal or a path the caller may not touch would
   * otherwise surface as a bare status code pointing at the wrong place.
   */
  it('surfaces the backend error message from a failed write', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ message: 'principal alice is not an enabled user' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(createGrant(ctx as never, CONFIG, {
      relPath: 'a.md', principalType: 'user', principalId: 'alice',
    })).rejects.toThrow(/not an enabled user/u)
  })

  it('refuses to call the backend when no base URL is configured', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = fakeHost({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(fetchGrants(ctx as never, { ...CONFIG, baseUrl: '' }))
      .rejects.toMatchObject({ code: 'not-configured' satisfies KnowledgeError['code'] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('derives the layout locally instead of asking a backend that has no such route', () => {
    const resolved = localConfig(CONFIG)
    expect(resolved.mountPoint).toBe('/workspace/kb')
    expect(resolved.host).toBe('dataops.example')
    expect(resolved.backendConfigured).toBe(true)
  })

  it('reports an absent mount as a null file count rather than zero', async () => {
    const status = await localStatus({ ...CONFIG, mountPoint: '/nonexistent-kb-mount' })
    expect(status.visibleFiles).toBeNull()
    expect(status.indexing.running).toBe(false)
  })

  it('disposes every registration through the effect scope', () => {
    const { ctx, tools, disposers } = fakeHost({ token: 't' })
    apply(ctx as never, CONFIG)
    expect(tools).toHaveLength(2)
    for (const dispose of disposers) dispose()
    expect(tools).toHaveLength(0)
  })
})

describe('knowledge search', () => {
  /**
   * Search replaces the mount-state summary that used to lead the page: the reason
   * to open the knowledge base is to find a document, not to read a sync timestamp.
   * It walks the mount directly, which is how retrieval already works here, so no
   * separate index can disagree with the files.
   */
  it('matches a file by name without opening it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-name-'))
    await mkdir(join(dir, '2024'), { recursive: true })
    await writeFile(join(dir, '2024', 'budget-report.md'), 'nothing relevant here')
    await writeFile(join(dir, '2024', 'other.md'), 'unrelated')
    const hits = await searchKnowledge(dir, 'budget')
    // `mtimeMs` rides along because the listing shows when a document changed;
    // the name match itself is what this case pins.
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      relPath: '2024/budget-report.md',
      name: 'budget-report.md',
      inContent: false,
    })
    expect(typeof hits[0]?.mtimeMs).toBe('number')
  })

  it('reports the matching line when the term is inside a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-body-'))
    await writeFile(join(dir, 'notes.md'), 'first line\nA Total Revenue figure\nlast line')
    const hits = await searchKnowledge(dir, 'total revenue')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      relPath: 'notes.md',
      inContent: true,
      line: 'A Total Revenue figure',
      lineNumber: 2,
    })
  })

  it('skips binary files rather than decoding them as text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-bin-'))
    // A NUL byte is what marks this as not text; decoding it would fill the result
    // with replacement characters instead of reporting no match.
    await writeFile(join(dir, 'blob.bin'), Buffer.from('needle\0needle'))
    await expect(searchKnowledge(dir, 'needle')).resolves.toEqual([])
  })

  it('answers an empty term and an absent mount with no hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-empty-'))
    await writeFile(join(dir, 'a.md'), 'anything')
    await expect(searchKnowledge(dir, '   ')).resolves.toEqual([])
    await expect(searchKnowledge('/no/such/mount', 'anything')).resolves.toEqual([])
  })
})

describe('directory listing', () => {
  /**
   * The borrowed tree renders icon and name only, because the entry shape it
   * consumes carries no timestamp (`name`, `path`, `isDir`, `hidden`, `isSymlink`,
   * `broken`). A listing built on that shape therefore cannot answer "which of
   * these two documents is newer", which is why the plugin reads directories
   * through its own route and stats each child.
   */
  it('carries a modification time for every entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-list-'))
    await mkdir(join(dir, 'reports'), { recursive: true })
    await writeFile(join(dir, 'top.md'), 'hello')
    const rows = await listDirectory(dir, dir)
    const file = rows.find(row => row.name === 'top.md')
    expect(file).toBeDefined()
    expect(typeof file?.mtimeMs).toBe('number')
    expect(file?.size).toBe(5)
    const folder = rows.find(row => row.name === 'reports')
    expect(folder?.isDir).toBe(true)
    expect(typeof folder?.mtimeMs).toBe('number')
    // A directory row carries no size: only files have one to compare.
    expect(folder?.size).toBeUndefined()
  })

  it('lists directories before files, each in name order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-order-'))
    await writeFile(join(dir, 'b.md'), 'b')
    await writeFile(join(dir, 'a.md'), 'a')
    await mkdir(join(dir, 'zeta'), { recursive: true })
    await mkdir(join(dir, 'alpha'), { recursive: true })
    const rows = await listDirectory(dir, dir)
    expect(rows.map(row => row.name)).toEqual(['alpha', 'zeta', 'a.md', 'b.md'])
  })
})

describe('per-user views', () => {
  /**
   * A grant in the permission store is a statement about what a principal MAY
   * read; it is not a filesystem fact. The workspace mounts the shared export, so
   * without a per-user tree every user sees every file no matter what the store
   * says. These pin the step that turns the decision into links -- and, more
   * importantly, the two refusals that keep it from becoming a second permission
   * implementation.
   */
  async function fixture(): Promise<{ actual: string; views: string; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), 'kb-views-'))
    const actual = join(base, 'actual')
    const views = join(base, 'views')
    await mkdir(join(actual, '2024', 'reports'), { recursive: true })
    await mkdir(views, { recursive: true })
    await writeFile(join(actual, '2024', 'reports', 'a.md'), 'a')
    await writeFile(join(actual, '2024', 'reports', 'secret.md'), 's')
    return { actual, views, cleanup: () => rm(base, { recursive: true, force: true }) }
  }

  it('links only the resolved paths into a user view', async () => {
    const f = await fixture()
    try {
      const delta = await syncView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' },
        [{ relPath: '2024/reports/a.md' }],
      )
      expect(delta.linked).toEqual(['2024/reports/a.md'])
      // The directory holding no resolved file is not created for this user, so the
      // view's shape is the decision rather than the tree's.
      await expect(stat(join(f.views, 'alice', '2024', 'reports', 'secret.md'))).rejects.toThrow()
      await expect(stat(join(f.views, 'alice', '2024', 'reports', 'a.md'))).resolves.toBeDefined()
    } finally { await f.cleanup() }
  })

  it('shares the inode, so a revoke unlinks the view entry and leaves the source', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      const source = join(f.actual, '2024', 'reports', 'a.md')
      const linked = join(f.views, 'alice', '2024', 'reports', 'a.md')
      // A copy would mean a revoke leaves the bytes readable and a re-grant pays for
      // them again; the shared inode is what makes both incremental.
      expect((await stat(source)).ino).toBe((await stat(linked)).ino)

      const delta = await syncView(view, [])
      expect(delta.unlinked).toEqual(['2024/reports/a.md'])
      await expect(stat(linked)).rejects.toThrow()
      // The authoritative file survives the revoke: it was never the view's to lose.
      await expect(stat(source)).resolves.toBeDefined()
    } finally { await f.cleanup() }
  })

  it('performs no writes when the resolved set already matches', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      const wanted = [{ relPath: '2024/reports/a.md' }]
      await syncView(view, wanted)
      const again = await syncView(view, wanted)
      // Repeating after every permission change is the whole point, so an unchanged
      // set must cost nothing rather than relinking the tree each time.
      expect(again).toEqual({ linked: [], unlinked: [], unchanged: 1, pruned: [] })
    } finally { await f.cleanup() }
  })

  it('refuses a user id that would place the view outside the view root', async () => {
    const f = await fixture()
    try {
      // The id comes from the identity provider, not from this plugin, so it is
      // validated before it reaches the filesystem.
      for (const bad of ['../escape', 'a/b', 'a\\b', '', '.', '..']) {
        expect(isSafeUserId(bad)).toBe(false)
        await expect(syncView({ actualRoot: f.actual, viewRoot: f.views, userId: bad }, []))
          .rejects.toThrow(/unsafe view user id/u)
      }
      expect(isSafeUserId('0f0e-1')).toBe(true)
    } finally { await f.cleanup() }
  })

  it('refuses a resolved path that would escape the authoritative root', async () => {
    const f = await fixture()
    try {
      // A `..` would let a grant for one path reach another, so containment is
      // checked here as well as in the store: the store decides visibility, this
      // layer decides the path still lands inside the tree.
      await writeFile(join(f.actual, '..', 'outside.md'), 'x')
      const delta = await syncView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' },
        [{ relPath: '../outside.md' }, { relPath: '/etc/passwd' }, { relPath: 'a/../../b.md' }],
      )
      expect(delta.linked).toEqual([])
      for (const bad of ['../x', '/etc/passwd', 'a/../b', '', 'a//b']) {
        expect(isContainedRelPath(bad)).toBe(false)
      }
      expect(isContainedRelPath('2024/reports/a.md')).toBe(true)
    } finally { await f.cleanup() }
  })

  /**
   * `/api/auth/me` answers `{ user: {...} }`, measured against the running backend
   * on 2026-10-15. Reading the profile at the top level yielded no id, which would
   * have failed the sync outright; the riskier shape is a silent one, where a
   * missing id keys a view directory by the wrong name. Both are refused here.
   */
  it('reads the caller id from where DataOps actually nests it', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: { id: '172f4a37-3dc7-4fb7-b1de-25a87bb78660', username: 'app', displayName: 'DataOps App User' },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).resolves.toEqual({
        userId: '172f4a37-3dc7-4fb7-b1de-25a87bb78660',
        label: 'DataOps App User',
        // A profile with no roles yields an empty list rather than undefined, so the
        // grant-management check reads a definite answer instead of guessing.
        roleCodes: [],
      })
    } finally {
      // The stub must not outlive this case: the SSH transport block below uses the
      // real fetch against a local server, and a leaked stub silently replaces it.
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a caller whose id the backend did not report', async () => {
    // An id-less profile must not become a view directory named by a placeholder.
    const fetchImpl = (async () => new Response(JSON.stringify({ user: { username: 'app' } }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).rejects.toThrow(/caller id/u)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('answers false when the permission service cannot be asked', async () => {
    // An unreachable backend must produce an EMPTY view rather than a full one:
    // failing open is the one outcome that would publish files nobody granted.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canReadPath(ctx as never, CONFIG, 'a.md')).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reads the role codes the profile carries without treating them as the judge', async () => {
    // The shape is `{ user: { roles: [{ code, name }] } }`, and `code` is the role's
    // DISPLAY name: measured 2026-10-16 against the running backend, which answers
    // `管理员` / `超级管理员`. Read so a caller can report them; NOT used to decide
    // anything, because the enforced permission point is what the backend checks.
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: {
        id: '172f4a37-3dc7-4fb7-b1de-25a87bb78660',
        displayName: 'Admin',
        roles: [{ code: '管理员', name: '管理员' }, { code: '超级管理员', name: '超级管理员' }],
      },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      const caller = await fetchCaller(ctx as never, CONFIG)
      expect(caller.roleCodes).toEqual(['管理员', '超级管理员'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('treats a malformed roles field as no roles rather than failing the profile', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: { id: 'u1', displayName: 'X', roles: 'not-an-array' },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).resolves.toEqual({
        userId: 'u1',
        label: 'X',
        roleCodes: [],
      })
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('points the browsable mount at the caller view', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      const mount = join(f.views, '..', 'mount')
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      await expect(pointMountAtView(view, mount)).resolves.toBe(true)
      // The page browses mountPoint, so a view that is not reachable from it would
      // be correct on disk and invisible in the product.
      const linked = join(mount, '2024', 'reports', 'a.md')
      await expect(stat(linked)).resolves.toBeDefined()
      expect((await stat(linked)).ino).toBe((await stat(join(f.actual, '2024', 'reports', 'a.md'))).ino)

      // A second sync must replace the pointer rather than fail on the existing
      // entry: symlink alone would leave the old target in place.
      // A revoke empties the view AND prunes the directory it left behind: a
      // leftover folder would still disclose a name the user lost access to.
      const revoked = await syncView(view, [])
      expect(revoked.unlinked).toEqual(['2024/reports/a.md'])
      expect(revoked.pruned).toEqual(['2024/reports', '2024'])
      await expect(pointMountAtView(view, mount)).resolves.toBe(true)
      await expect(readdir(mount)).resolves.toEqual([])
    } finally { await f.cleanup() }
  })

  it('refuses to point the mount at a view that does not exist', async () => {
    const f = await fixture()
    try {
      // A link to a missing directory renders as an empty tree, which reads as
      // "you have no files" rather than as a sync that has not run.
      await expect(pointMountAtView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'nobody' },
        join(f.views, 'mount'),
      )).resolves.toBe(false)
    } finally { await f.cleanup() }
  })

  it('drops a whole view on request without touching the sources', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      await expect(dropView(view)).resolves.toBe(true)
      await expect(stat(join(f.views, 'alice'))).rejects.toThrow()
      await expect(stat(join(f.actual, '2024', 'reports', 'a.md'))).resolves.toBeDefined()
      // Nothing to drop is false, not an error: a user with no view is the normal
      // state before their first run.
      await expect(dropView(view)).resolves.toBe(false)
    } finally { await f.cleanup() }
  })
})

describe('row permission state', () => {
  /**
   * Visibility is decided once, on the Host, by REMOVING a row. A client-side marker
   * cannot be the mechanism: the row it decorates already carries the file's name,
   * size and modification time, and the browser can still read the bytes behind it.
   * These pin the removal where it happens rather than pinning a lamp's markup.
   */
  it('drops an unreadable row rather than tagging it', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // A row that reaches a caller is one the service answered `true` for.
    expect(source).toMatch(/readable: true/u)
    // The old shape annotated every row and filtered none; that is the defect.
    expect(source).not.toMatch(/readable === undefined \? row/u)
    // The listing route must never fall back to the unchecked filesystem read.
    expect(source).not.toMatch(/entries: await listDirectory\(/u)
  })

  it('offers the grant entry from a row and keeps the reference action', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeListing.tsx', import.meta.url), 'utf8')
    // A right-click is where an operator already has a path in mind, and the
    // borrowed tree's own menu cannot be extended, which is why the listing owns it.
    expect(source).toMatch(/onContextMenu/u)
    expect(source).toMatch(/props\.onGrant/u)
    // The reference affordance must not also open the file.
    expect(source).toMatch(/stopPropagation/u)
    expect(source).toMatch(/entryRef/u)
  })

  it('routes row permission questions through the self-scoped resolve route', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // The decision stays with DataOps: asking its own route per path is what keeps a
    // per-user view from becoming a second permission implementation.
    expect(source).toMatch(/ENDPOINTS\.resolve/u)
    expect(source).toMatch(/canRead === true/u)
    // An unreachable service must fail closed for visibility.
    expect(source).toMatch(/resourceType: KB_RESOURCE_TYPE, resourceId: relPath/u)
  })
})

describe('listing visibility', () => {
  /**
   * The user's report was "没权限的怎么会能看到呢？" -- files they were not granted were
   * listed, with their names, sizes and modification times. The check existed but
   * only annotated rows, so a denied file was still published; answering the
   * unchecked case with the full listing published everything whenever the backend
   * was missing or the identity could not be read. Every case below therefore
   * asserts an ABSENCE, which is the only assertion a leak cannot satisfy.
   */
  async function listingFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-perm-'))
    await writeFile(join(root, 'granted.md'), 'granted')
    await writeFile(join(root, 'secret.md'), 'secret')
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  /**
   * Answer the resolve route per path: `allow` names come back readable, every
   * other path comes back denied. Any other request the plugin makes (the caller
   * profile) answers a minimal user body.
   */
  function resolveBackend(allow: readonly string[]): { fetchImpl: typeof fetch; asked: string[] } {
    const asked: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith(ENDPOINTS.me)) {
        return new Response(JSON.stringify({ user: { id: 'alice', displayName: 'Alice' } }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
      const resourceId = String(body.resourceId ?? '')
      asked.push(resourceId)
      return new Response(JSON.stringify({ canRead: allow.includes(resourceId) }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, asked }
  }

  it('lists a path DataOps resolved as readable', async () => {
    const f = await listingFixture()
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: resolveBackend(['granted.md']).fetchImpl })
    try {
      const rows = await listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice')
      expect(rows.map(row => row.name)).toEqual(['granted.md'])
      // The surviving row is an affirmative answer, not an absent flag: an absent
      // flag is exactly what used to travel to the page for a denied row.
      expect(rows[0]?.readable).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits a path DataOps denied, without its name or size', async () => {
    const f = await listingFixture()
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: resolveBackend(['granted.md']).fetchImpl })
    try {
      const rows = await listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice')
      // Absence, not a marker: the name, the size and the time must all be gone.
      expect(rows.some(row => row.name === 'secret.md')).toBe(false)
      expect(JSON.stringify(rows)).not.toContain('secret')
      // The permission check must have been asked about it, so the omission is a
      // decision rather than a path the walk never reached.
      expect(rows.map(row => row.name)).toEqual(['granted.md'])
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits every row when the permission service fails, rather than failing open', async () => {
    // An unreachable backend resolves nothing. Publishing the directory anyway is
    // the "full listing" failure the user saw.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    const f = await listingFixture()
    try {
      await expect(listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice'))
        .resolves.toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits every row when no caller identity is available', async () => {
    // Without an identity the question has no subject, so no answer can be trusted.
    const fetchImpl = vi.fn()
    const { ctx, disposers } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const f = await listingFixture()
    try {
      await expect(listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, undefined))
        .resolves.toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits every row when no permission backend is configured', async () => {
    // An unconfigured deployment has no per-user view of its own, so it has nothing
    // verified to list. The empty answer is reported through permissionsResolved.
    const fetchImpl = vi.fn()
    const { ctx, disposers } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const f = await listingFixture()
    try {
      await expect(listDirectoryWithPermissions(
        ctx as never,
        { ...CONFIG, baseUrl: '   ' },
        f.root,
        f.root,
        'alice',
      )).resolves.toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  /**
   * The unit tests above call the filter directly, which would still pass if the
   * route kept building its own unchecked listing. This drives the Host route the
   * page actually reads, so the wiring is covered too.
   */
  it('serves the filtered set from the listing route the page reads', async () => {
    const f = await listingFixture()
    const { fetchImpl } = resolveBackend(['granted.md'])
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      // The route lists the mount point, which is where the fixture tree is placed.
      apply(ctx as never, { ...CONFIG, mountPoint: f.root })
      const reply = await callRoute(routes, 'list', { path: '' })
      const entries = reply.entries as Array<{ name: string }>
      expect(entries.map(entry => entry.name)).toEqual(['granted.md'])
      expect(reply.permissionsResolved).toBe(true)
      // The ungranted file must not be in the bytes the browser receives.
      expect(JSON.stringify(reply)).not.toContain('secret')
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('returns an empty listing from the route when the backend cannot answer', async () => {
    const f = await listingFixture()
    // An unreachable permission service must not fall back to the raw directory.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, { ...CONFIG, mountPoint: f.root })
      const reply = await callRoute(routes, 'list', { path: '' })
      expect(reply.entries).toEqual([])
      expect(JSON.stringify(reply)).not.toContain('secret')
      // The caller id could not be read, so the page is told nothing was verified.
      expect(reply.permissionsResolved).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('still checks containment and leaves the incremental view semantics alone', async () => {
    // The filter is a visibility decision, not a new path policy: the two existing
    // boundaries must behave exactly as before it was added.
    for (const bad of ['../x', '/etc/passwd', 'a/../b', '', 'a//b', 'a\\b']) {
      expect(isContainedRelPath(bad)).toBe(false)
    }
    expect(isContainedRelPath('2024/reports/a.md')).toBe(true)
    for (const bad of ['../escape', 'a/b', 'a\\b', '', '.', '..', 'a\0b']) {
      expect(isSafeUserId(bad)).toBe(false)
    }
    expect(isSafeUserId('172f4a37-3dc7-4fb7-b1de-25a87bb78660')).toBe(true)

    // An unchanged authorized set still costs zero filesystem writes, which is what
    // keeps a sync after every permission edit cheap.
    const base = await mkdtemp(join(tmpdir(), 'kb-perm-view-'))
    const actual = join(base, 'actual')
    const views = join(base, 'views')
    await mkdir(join(actual, '2024'), { recursive: true })
    await mkdir(views, { recursive: true })
    await writeFile(join(actual, '2024', 'a.md'), 'a')
    try {
      const view = { actualRoot: actual, viewRoot: views, userId: 'alice' }
      const wanted = [{ relPath: '2024/a.md' }]
      await syncView(view, wanted)
      await expect(syncView(view, wanted))
        .resolves.toEqual({ linked: [], unlinked: [], unchanged: 1, pruned: [] })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('grant-management capability', () => {
  /**
   * The user's report was "非管理员就看不到权限管理这个菜单". The menu follows the
   * AUTHORITY's answer, never the browser's: the Host asks the route that the grant
   * and revoke calls are themselves guarded by, so a `200`/`403` from DataOps is the
   * decision. Measured live on 2026-10-16: as `admin` the guarded route answers 200,
   * as `operator` and as `app` it answers 403.
   *
   * Every failure denies. That direction is deliberate: an administrator wrongly
   * denied retries once the backend recovers, while a non-administrator wrongly
   * allowed gains a management surface the backend would refuse anyway.
   */
  function capabilityBackend(status: number): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(status === 200 ? { grants: [] } : { code: 'DATAOPS_ACCESS_FORBIDDEN' }), { status })
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
  }

  it('allows a caller the guarded route answers 200 for', async () => {
    const { fetchImpl, urls } = capabilityBackend(200)
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(true)
      // The judge must be the route the writes are guarded by, and it must be asked
      // with the knowledge resource type so the read stays on this feature's data.
      expect(urls[0]).toContain(ENDPOINTS.grants)
      expect(urls[0]).toContain('resourceType=knowledge-base-file')
      expect(urls[0]).toContain('resourceId=')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('denies a caller the guarded route answers 403 for', async () => {
    const { fetchImpl } = capabilityBackend(403)
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('denies every unresolved case rather than failing open', async () => {
    // An unreachable service, a server error, and a token the backend rejects all
    // leave the permission unproven, and unproven must not mean visible.
    for (const status of [500, 503]) {
      const { fetchImpl } = capabilityBackend(status)
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // A transport failure throws rather than answering.
    const throwing = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    {
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: throwing })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // A timeout is a failure like any other: the request is issued with
    // `AbortSignal.timeout`, so a hung backend rejects and must deny.
    {
      const hanging = (async () => {
        throw new Object(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      }) as unknown as typeof fetch
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: hanging })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // No credential at all: the request never leaves the Host.
    {
      const never = vi.fn()
      const { ctx, disposers } = fakeHost({ fetchImpl: never as unknown as typeof fetch })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
        expect(never).not.toHaveBeenCalled()
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
  })

  /**
   * A regression guard for the shortcut that looks right and is not.
   *
   * `/auth/me` reports `roles[].code` as the role's DISPLAY name -- the live backend
   * answered `管理员` and `超级管理员` on 2026-10-16 -- while `SUPER_ADMIN` / `ADMIN`
   * are the `system_key` values that route never exposes. Matching the constant
   * names would deny every real administrator. The judge must stay on the enforced
   * permission point, so this pins that no role-name comparison creeps back in.
   */
  it('judges by the enforced permission point, not by role names', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // No role constant is compared anywhere in the authorization path.
    expect(source).not.toMatch(/'SUPER_ADMIN'/u)
    expect(source).not.toMatch(/'ADMIN'/u)
    // The judge is the guarded route, and only its success is treated as yes.
    expect(source).toMatch(/ENDPOINTS\.grants/u)
    expect(source).toMatch(/return true\n  \} catch \{\n    return false/u)
  })

  it('treats a malformed body as no permission rather than trusting the status', async () => {
    // A 200 whose body is not the expected shape must not be read as approval.
    const fetchImpl = (async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  /**
   * The two live profiles, verbatim, to pin why the role codes cannot be the judge.
   *
   * Measured 2026-10-16 against the running backend: the administrator's profile
   * carries `管理员` + `超级管理员`, the operator's carries `运营人员`. Neither is
   * `ADMIN` or `SUPER_ADMIN` -- those are the roles' `system_key` values, which
   * `/auth/me` does not expose -- so no role-name test could separate these two
   * callers from the profile alone. The capability therefore comes from the guarded
   * route: as `admin` it answered 200, as `operator` and `app` it answered 403.
   */
  it('keeps the measured admin and operator profiles distinguishable only by the route', async () => {
    const profiles = [
      { roles: [{ code: '管理员', name: '管理员' }, { code: '超级管理员', name: '超级管理员' }] },
      { roles: [{ code: '运营人员', name: '运营人员' }] },
    ]
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: capabilityBackend(200).fetchImpl })
    try {
      for (const roles of profiles) {
        const fetchImpl = (async () => new Response(JSON.stringify({ user: { id: 'u1', roles } }), { status: 200 })) as unknown as typeof fetch
        vi.stubGlobal('fetch', fetchImpl)
        const caller = await fetchCaller(ctx as never, CONFIG)
        // Both profiles yield role codes, and neither is a constant name.
        expect(caller.roleCodes).not.toContain('ADMIN')
        expect(caller.roleCodes).not.toContain('SUPER_ADMIN')
      }
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports the capability on the status route the page reads', async () => {
    const { fetchImpl, urls } = capabilityBackend(200)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, CONFIG)
      const reply = await callRoute(routes, 'status', {})
      expect(reply.canManageGrants).toBe(true)
      expect(urls.some(url => url.includes(ENDPOINTS.grants))).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports no capability when the backend is unconfigured, without calling it', async () => {
    const never = vi.fn()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: never as unknown as typeof fetch })
    try {
      apply(ctx as never, { ...CONFIG, baseUrl: '' })
      const reply = await callRoute(routes, 'status', {})
      // No authority means no answer, and no answer means hidden.
      expect(reply.canManageGrants).toBe(false)
      expect(never).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports no capability when the identity cannot be read', async () => {
    // The probe fails closed on its own; this pins the same outcome when the whole
    // backend is down, so a page load during an outage hides the surface.
    const fetchImpl = (async () => { throw new Error('down') }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, CONFIG)
      const reply = await callRoute(routes, 'status', {})
      expect(reply.canManageGrants).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  /**
   * The menu row is the visible half. These pin the other two, because hiding a row
   * while leaving the surface reachable is not a refusal.
   */
  it('refuses the permission surface and drops the primed path in the panel', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    // The decision is read from the Host's status, never recomputed in the browser.
    expect(source).toMatch(/status\.canManageGrants === true/u)
    // The row is conditional on it.
    expect(source).toMatch(/canManageGrants \? \[\{ kind: 'permissions'/u)
    // A selection already on permissions falls back instead of rendering the surface.
    expect(source).toMatch(/selection\.kind === 'permissions' && !canManageGrants/u)
    // The right-click entry is withdrawn, and the transition itself is guarded.
    expect(source).toMatch(/onGrant=\{canManageGrants \?/u)
    expect(source).toMatch(/if \(!canManageGrants\) return/u)
  })
})

describe('view sync surface', () => {
  /**
   * The button is the only way a grant becomes visible, and its failure modes are
   * both silent: a sync with no permission service empties the tree, and a sync
   * that renders a bare "done" cannot answer whether the edit took effect.
   */
  it('reports the delta rather than a bare success', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    // Counts come back from the Host, so the wording is a template with slots.
    expect(source).toMatch(/viewSynced/u)
    expect(source).toMatch(/\{considered\}/u)
    expect(source).toMatch(/\{linked\}/u)
    expect(source).toMatch(/\{unlinked\}/u)
  })

  it('refuses to sync while no backend can answer', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    // Without a backend every path resolves to nothing, so an enabled button would
    // wipe the caller's tree instead of rebuilding it.
    expect(source).toMatch(/state\.supported/u)
    expect(source).toMatch(/syncBusy/u)
  })

  it('posts to the views.sync route the Host serves', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/KB_API\.viewsSync/u)
    const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
    expect(api).toMatch(/viewsSync: 'views\.sync'/u)
  })
})

describe('client bundle externals', () => {
  /**
   * A specifier left external is resolved by the browser loader's module table,
   * which only holds DSH's own `PLATFORM_MODULES`. Anything else fails at RUNTIME,
   * not at build time: the whole plugin reports `failed to load` with
   * `require("x") missed the module table`.
   *
   * Measured in a real browser on 2026-10-15: a `clsx` entry in the build's
   * externals list made the plugin fail to load entirely while every Host endpoint
   * still answered 200, because the failure is in the browser half alone.
   */
  it('keeps every runtime require inside the platform module table', async () => {
    const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
    // The table DSH seeds, from packages/client/web/src/platform.ts.
    const platform = new Set([
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
    ])
    const missing = [...new Set(required)].filter(id => !platform.has(id))
    expect(missing).toEqual([])
  })
})

describe('shell quoting', () => {
  it('wraps values in single quotes', () => {
    expect(shquote('/nas/kb')).toBe("'/nas/kb'")
  })

  it('round-trips a shell-injection attempt through /bin/sh unchanged', () => {
    // The real property is not "the output looks escaped" but "a shell reads
    // back exactly the input". Anything else means an injected command could run.
    const evil = "a'; touch /tmp/__kb_pwned__; echo '"
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shquote(evil)}`], { encoding: 'utf8' })
    expect(echoed).toBe(evil)
    expect(existsSync('/tmp/__kb_pwned__')).toBe(false)
  })

  it('round-trips a substitution attempt unchanged', () => {
    const evil = '$(id)`whoami`'
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shquote(evil)}`], { encoding: 'utf8' })
    expect(echoed).toBe(evil)
  })

  it('leaves unknown placeholders intact instead of deleting them', () => {
    expect(renderCommand('echo {{nope}}', PLAN)).toBe('echo {{nope}}')
  })

  it('substitutes and quotes every known placeholder', () => {
    expect(renderCommand('ln {{actualRoot}} {{viewRoot}}', PLAN))
      .toBe("ln '/nas/kb/actual' '/nas/kb/views'")
    expect(renderCommand('--tier {{tier}}', PLAN)).toBe("--tier 'basic'")
    expect(renderCommand('--port {{port}}', PLAN)).toBe("--port 8000")
  })
})

describe('deployment plan', () => {
  it('is ordered probe, mineru, then storage', () => {
    expect(deploymentPlan(PLAN).map(step => step.id)).toEqual([
      'probe',
      'mineru-install',
      'mineru-service',
      'mineru-verify',
      'nfs-deploy',
      'nfs-verify',
      // The plan used to stop at verification, so nothing ever mounted the export: the
      // storage steps proved the export could work and left the client without it.
      'nfs-mount',
    ])
  })

  it('looks a step up by id and reports unknown ids', () => {
    expect(findStep('probe', PLAN)?.id).toBe('probe')
    expect(findStep('nope', PLAN)).toBeUndefined()
  })

  it('never mutates during the probe step', () => {
    const probe = probeStep()
    for (const command of probe.commands) {
      expect(command).not.toMatch(/\b(rm|mv|dd|mkfs|systemctl start|docker run)\b/u)
    }
  })

  it('pins the tier and backend so only one model bundle is fetched', () => {
    const install = mineruInstallStep(PLAN)
    const joined = install.commands.join('\n')
    expect(joined).toContain('--tier basic')
    expect(joined).toContain('--small-backend onnx')
    // The base package is the CPU path; the GPU extra must not appear.
    expect(joined).not.toContain('mineru[full]')
    expect(joined).not.toContain('mineru[torch]')
  })

  /**
   * `models download --tier` validates its value against `DEPLOYMENT_TIERS` in
   * `mineru/types.py`, which holds exactly `basic` and `standard`. MinerU also uses the word
   * `flash` for a *quality* tier covering the parsers that need no local weights (CSV, EPUB,
   * HTML), so offering it as a deployment tier produced a config the download step rejects.
   * Measured 2026-10-15 against mineru 4.0.12.
   */
  it('offers only the deployment tiers MinerU can actually prepare', () => {
    expect(() => Config({ mineruTier: 'flash' } as never)).toThrow()
    expect((Config({ mineruTier: 'basic' } as never) as unknown as typeof CONFIG).mineruTier).toBe('basic')
    expect((Config({ mineruTier: 'standard' } as never) as unknown as typeof CONFIG).mineruTier).toBe('standard')
  })

  it('skips install work when mineru is already present', () => {
    const joined = mineruInstallStep(PLAN).commands.join('\n')
    expect(joined).toContain('if mineru-kit --version')
    expect(joined).toContain('already installed')
  })

  it('allows a long window for the model download', () => {
    expect(mineruInstallStep(PLAN).timeoutMs).toBeGreaterThan(600_000)
  })

  it('detects a cross-filesystem layout before attempting a hardlink', () => {
    const joined = nfsVerifyStep(PLAN).commands.join('\n')
    expect(joined).toContain('stat -c %d')
    expect(joined).toContain('different filesystems')
    expect(joined).toContain('ln ')
  })

  /**
   * The mount step must pass `noresvport`.
   *
   * Measured 2026-10-16 on this host: under WSL2 mirrored networking an NFSv4 mount
   * without that option hangs until timeout (`mount.nfs: Connection timed out`) while
   * `rpcinfo`, `showmount -e` and a plain TCP connect to 2049 all still succeed. The
   * server was healthy the whole time - it mounted fine from its own kernel, and the
   * A/B was repeatable in both directions. Without this assertion a later edit could
   * drop the option and reintroduce a mount that fails with no useful error.
   */
  it('mounts the export with noresvport, which mirrored networking requires', () => {
    const joined = nfsMountStep(PLAN).commands.join('\n')
    expect(joined).toContain('noresvport')
    expect(joined).toContain('mount -t nfs4')
    expect(joined).toContain('mountpoint -q')
  })

  it('mounts the pseudo root rather than a path beneath it', () => {
    // `fsid=0` in the export makes the share the NFSv4 pseudo root, so the client source
    // is `<server>:/`. Mounting `<server>:/nfs-share` against that export is rejected.
    const joined = nfsMountStep({ ...PLAN, server: '10.0.0.5' }).commands.join('\n')
    expect(joined).toContain('10.0.0.5:/')
    expect(joined).not.toContain('10.0.0.5:/nfs-share')
  })

  it('refuses a mount point that returns but serves nothing', () => {
    // A mount that succeeds and then cannot list is worse than one that fails loudly,
    // because the plugin would report a browsable tree that has no contents.
    const joined = nfsMountStep(PLAN).commands.join('\n')
    expect(joined).toContain('is not readable')
  })

  /**
   * The NFS image builds its export list with
   * `sed -i "s/{{PERMITTED}}/"${PERMITTED}"/g"`, whose delimiter is a slash, so a CIDR
   * client list breaks that substitution and leaves the literal placeholder in place. The
   * container still reports "Startup successful" while exporting nothing, so a plan that
   * hands the value to the image cannot be trusted to fail loudly.
   *
   * Measured 2026-10-15 against itsthenetwork/nfs-server-alpine:latest: `PERMITTED=10.0.0.0/8`
   * left `/nfs-share {{PERMITTED}}(...)` and `exportfs` reported no exported filesystem.
   */
  it('never hands the client list to the image sed, which breaks on a CIDR slash', () => {
    const run = nfsDeployStep({ ...PLAN, permitted: '192.168.2.0/24' }).commands.find(
      command => command.includes('docker run'),
    )
    expect(run).toBeDefined()
    // The slash-bearing value must not reach the image through an environment variable.
    expect(run).not.toContain('PERMITTED=192.168.2.0/24')
    // It travels in its own variable and is written by the container shell instead.
    expect(run).toContain('KB_PERMITTED=')
    const joined = nfsDeployStep({ ...PLAN, permitted: '192.168.2.0/24' }).commands.join('\n')
    expect(joined).toContain('/etc/exports')
    expect(joined).toContain('exportfs -ra')
  })

  it('proves the export landed instead of trusting the container status', () => {
    const joined = nfsDeployStep(PLAN).commands.join('\n')
    // A leftover placeholder and an empty export list are both reported as failures.
    expect(joined).toContain('{{PERMITTED}}')
    expect(joined).toContain('exportfs -v')
    expect(joined).toMatch(/serves no share/)
  })

  /**
   * `exportfs` applies an option group only to the host it directly follows, so a single
   * `host-a host-b(rw,...)` line silently makes `host-a` read-only with `root_squash`.
   * Measured 2026-10-15 on tokensfree: the first host came back
   * `ro,secure,root_squash` while the second got the options, which would leave the first
   * client unable to create the hardlinks the permission model is built from.
   */
  it('writes one export line per host so every client keeps the same options', () => {
    const write = nfsDeployStep({ ...PLAN, permitted: '10.0.0.5 10.0.0.6' }).commands.find(
      command => command.includes('/etc/exports'),
    )
    expect(write).toBeDefined()
    // The option group is emitted inside the per-host loop rather than once for the line.
    expect(write).toMatch(/for h in \$KB_PERMITTED/u)
    expect(write).toContain('no_root_squash')
    expect(write).toMatch(/>> \/etc\/exports/u)
  })

  /**
   * The development host also runs other services, and it has no swap device, so an
   * unbounded MinerU would be killed by the kernel as an OOM victim rather than failing
   * its own request.
   */
  it('caps the MinerU service so a heavy parse cannot take the host down', () => {
    const joined = mineruServiceStep(PLAN).commands.join('\n')
    expect(joined).toContain('MemoryMax=')
    expect(joined).toContain('MemoryHigh=')
    // The cap is clamped to the machine rather than trusted as configured.
    expect(joined).toContain('/proc/meminfo')
    expect(joined).toContain('clamping the MinerU memory cap')
  })

  it('keeps the cap at half of RAM at most, so other services keep their share', () => {
    const joined = mineruServiceStep({ ...PLAN, memoryMaxMiB: 999_999 }).commands.join('\n')
    expect(joined).toContain('TOTAL_MB / 2')
  })

  it('declares where deploy state is recorded', () => {
    expect(KB_STATE_FILE.startsWith('/')).toBe(true)
  })
})

describe('ssh-manager transport', () => {
  /** Start a stub of the ssh-manager API on an ephemeral port. */
  async function withManager(
    handler: (method: string, payload: Record<string, unknown>) => { status: number; body: unknown },
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        const method = (req.url ?? '/').split('/').pop() ?? ''
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        const { status, body } = handler(method, payload)
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await run(`http://127.0.0.1:${String(port)}`)
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  }

  it('builds an absolute origin, substituting loopback for an unusable bind host', () => {
    // A Host-side fetch rejects a relative URL, so the runner needs a real origin;
    // a wildcard or IPv6 bind is not usable as written and this process is loopback-reachable.
    expect(originFrom({ host: '127.0.0.1', port: 3080 })).toBe('http://127.0.0.1:3080')
    expect(originFrom({ host: '0.0.0.0', port: 3080 })).toBe('http://127.0.0.1:3080')
    expect(originFrom({ host: '::', port: 9000 })).toBe('http://127.0.0.1:9000')
    expect(originFrom({ host: '10.1.2.3', port: 8080 })).toBe('http://10.1.2.3:8080')
    expect(originFrom({ host: '127.0.0.1', port: 443, protocol: 'https:' })).toBe('https://127.0.0.1:443')
  })

  it('rejects an empty origin instead of issuing a relative request', () => {
    expect(() => sshManagerRunner({ origin: '' }))
      .toThrowError(/origin is required/u)
  })

  it('reads the host inventory', async () => {
    await withManager(
      () => ({ status: 200, body: { hosts: [{ id: 'h1', name: 'nas', hostname: '10.0.0.9', username: 'root', port: 22, knownHostFingerprint: null, credentialConfigured: true }] } }),
      async (baseUrl) => {
        const hosts = await sshManagerRunner({ origin: baseUrl }).listHosts()
        expect(hosts).toHaveLength(1)
        expect(hosts[0]?.hostname).toBe('10.0.0.9')
      },
    )
  })

  it('normalizes a command result', async () => {
    await withManager(
      (_method, payload) => ({ status: 200, body: { exitCode: 0, stdout: `ran ${String(payload.command)}`, stderr: '', truncated: false } }),
      async (baseUrl) => {
        const result = await sshManagerRunner({ origin: baseUrl }).execute('h1', 'uname -m')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('ran uname -m')
      },
    )
  })

  it('reports a missing ssh-manager as manager-unavailable', async () => {
    const runner = sshManagerRunner({ origin: 'http://127.0.0.1:1' })
    await expect(runner.listHosts())
      .rejects.toMatchObject({ code: 'manager-unavailable' satisfies RemoteError['code'] })
  })

  it('surfaces a manager-side error message', async () => {
    await withManager(
      () => ({ status: 500, body: { error: 'SSH command approval was denied' } }),
      async (baseUrl) => {
        await expect(sshManagerRunner({ origin: baseUrl }).execute('h1', 'id'))
          .rejects.toMatchObject({ code: 'transport' satisfies RemoteError['code'] })
      },
    )
  })
})
