import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The agent path is the whole point of the plugin, and it spans three pieces that each
 * fail silently on their own: the workspace never learns its own id (`whoami`), a room
 * session is built without being persisted (`create`), and the agent is looked up instead
 * of resolved (`resolveAgent`). None of them reports anything when wrong — the room just
 * never answers. These assertions pin the contracts that make a turn start.
 */
const HOST = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const BACKEND = readFileSync(new URL('../src/backend.ts', import.meta.url), 'utf8')
const CONTEXT = readFileSync(new URL('../src/context.ts', import.meta.url), 'utf8')
const IDENTITY = readFileSync(new URL('../src/identity.ts', import.meta.url), 'utf8')

describe('the workspace identifies itself', () => {
  it('unwraps the account envelope the server sends', () => {
    // `/api/auth/me` answers `{ user: { id } }`. Reading the id from the top level returns
    // undefined for every call, so `selfId` never resolves, "the sender is me" never
    // holds, and no turn ever starts — with nothing in the logs to say why.
    expect(BACKEND).toContain('me.user?.id')
  })
})

describe('a room session is created through the controller', () => {
  it('does not build a session from the registry alone', () => {
    // `sessions.create()` returns an in-memory handle that was never persisted. An agent
    // resolved onto it fails with SessionPersistenceNotFoundError, and the room is silent.
    expect(CONTEXT).not.toContain('create(id: string')
    expect(HOST).not.toMatch(/ctx\.sessions\.create\(/u)
  })

  it('creates the session with cwd and no workspace, so the room is not a workspace row', () => {
    // A room is a single conversation. Registering a workspace per room put an entry in the
    // Workspace list for every room — folders that never hold anything else, and entries that
    // outlived the rooms that created them.
    //
    // The directory is still the room's agent scope, so it is made first and passed as `cwd`.
    // That is not the same as "a session nothing can open": `uiWorkspace.openSession` retains
    // the Session by id and never consults workspace membership, so the room opens as before.
    // The session lands in the shell's "Ungrouped" bucket, which is where sessions that belong
    // to no workspace are meant to go.
    expect(HOST).toMatch(/await mkdir\(directory, \{ recursive: true \}\)/u)
    expect(HOST).toMatch(/cwd: directory,/u)
  })

  it('never passes both workspaceId and cwd', () => {
    // The controller refuses the pair outright ("session.create accepts workspaceId or
    // cwd, not both"). A room now passes only `cwd`.
    const call = HOST.slice(HOST.indexOf('await this.ctx.sessionController.create({'))
    const block = call.slice(0, call.indexOf('})'))
    expect(block).toContain('cwd:')
    expect(block).not.toContain('workspaceId:')
  })

  it('derives a per-room directory when the room named none', () => {
    // Sharing the workspace root would put every room inside the operator's own workspace,
    // and two rooms would then share one directory scope by accident.
    expect(IDENTITY).toContain('ROOMS_DIRECTORY')
    expect(IDENTITY).toMatch(/resolveRoomDirectory/u)
  })
})

describe('the agent is resolved onto the session', () => {
  it('reads the result as the union it is', () => {
    // The result is `{ agent }` or `{ error }`, not an `ok` discriminant. Testing an `ok`
    // field that never exists reads as a failure on every call, and the room stays silent.
    expect(HOST).toContain("'agent' in resolved")
    expect(HOST).not.toContain('resolved.ok')
  })

  it('resolves when no live agent is bound yet', () => {
    // The first message arrives before any agent exists on the room session, so the live
    // lookup is expected to miss and the resolve is what binds one.
    const wake = HOST.slice(HOST.indexOf('const deliverToAgent'))
    expect(wake).toMatch(/agents\.get\([\s\S]{0,400}resolveAgent/u)
  })
})

describe('房间会话的模型选择', () => {
  it('建会话后安装房间自己的模型，而不是靠部署默认', () => {
    // 会话的 modelSelection 才是决定跑哪个 provider 的东西，preset 不决定它。房间若不装自己
    // 的选择就落到部署默认；默认 provider 的凭证被拒时，房间能建会话、turn 能起，却在一次
    // 鉴权失败上收尾——读起来像这个插件的缺陷。选择必须在第一个 turn 之前装上。
    expect(HOST).toContain('sessionController.selectModel')
    const create = HOST.indexOf('sessionController.create(')
    const select = HOST.indexOf('sessionController.selectModel(')
    expect(create).toBeGreaterThan(0)
    expect(select).toBeGreaterThan(create)
  })

  it('模型是一个 provider+model 的对，缺一半就不装', () => {
    // 只有 provider 没有 model（或相反）不构成可走的路由。装一半等于把会话送回默认，
    // 而又让人以为房间已经指定过了。
    expect(HOST).toMatch(/room\.modelProvider !== undefined && room\.model !== undefined/u)
  })

  it('房间摘要带出模型，否则容器无从知道该装什么', () => {
    expect(BACKEND).toMatch(/readonly modelProvider: string \| null/u)
    expect(BACKEND).toMatch(/readonly model: string \| null/u)
  })
})

describe('房间消息只能由官方路径写进会话', () => {
  it('插件不自己 append surface，避免抢在 system/message 之前', () => {
    // 官方在 turn 里按固定顺序写 surface：先 `system/message`（agent-loop:1061），
    // 再 `user/message`（agent-loop:1072）。日志的第一个 surface 节点必须是那个受保护的
    // system/message —— 存储读取器一旦发现 surface 非空而 protectedHead 未设，就整份拒绝
    // （session-format-v3-to-v4:599「system/message requires a protected first surface head」）。
    //
    // 插件曾经自己 append 一遍，于是 user/message 成了第一个 surface 节点，房间点进去
    // 一律报「历史加载失败」。`followup` 本来就承诺「把这条消息变成它自己 turn 的唯一
    // ordinary message」，所以那次 append 既是多余的、也是有害的。
    expect(HOST).not.toMatch(/\.append\([^)]*surfaceOp/u)
    expect(HOST).not.toContain('DynamicSessionAppend')
  })

  it('走官方两条通道，由 driver 写 surface', () => {
    // `followup` 会唤醒 driver 跑 turn（该回复），`inject` 只把消息放进上下文
    //（不唤醒、不回复）。两条都由官方 driver 在 turn 内按正确顺序写 surface。
    expect(HOST).toContain('agent.followup(')
    expect(HOST).toContain('agent.inject(')
  })

  it('未被 @ 的消息仍然进入会话，只是不触发回复', () => {
    // 只有被 @ 的消息才进会话，那就不是群聊了 —— agent 必须能读到它周围说的话。
    // 官方 `inject` 的契约正是「queue model-facing context … without waking the driver」。
    expect(HOST).toMatch(/if \(wake\) agent\.followup\(prompt\)\s*\n\s*else agent\.inject\(prompt\)/u)
  })

  it('投递收到的是本条消息，而不是回读会话的最后一条事件', () => {
    // 回读会拿到 driver 上次提交的内容：turn 结束后是 assistant 的回复，不是触发它的那条
    // 用户消息。所以 prompt 必须由 deliver 传进来。
    // `withSpeakerPrefix` 重写的是**信封**（`{ type, data }`），而两条官方通道收的是信封里
    // 的 message（`UserMessage`：顶层有 role/id/content/source）。传信封会被
    // `isUserMessageData` 判否并**静默丢弃** —— 后端有记录、会话里什么都没有。
    expect(HOST).toMatch(/const message = \(local as \{ data\?: unknown \}\)\.data/u)
    expect(HOST).toMatch(/deliverToAgent\(roomId, message, true\)/u)
    expect(HOST).toMatch(/deliverToAgent\(roomId, message, false\)/u)
    expect(HOST).not.toContain('deliverToAgent(roomId, local')
    expect(HOST).not.toContain('lastRoomEvent(runtime.session, roomId)')
  })
})
