import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildConnectorView,
  readConnectorState,
  writeConnectorState,
  type DataOpsConnectorState,
} from '../src/connector-state.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function path(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dataops-connector-'))
  temporary.push(directory)
  return join(directory, 'connector-state.json')
}

const ADMIN_SCOPE = {
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['skill:capability:read'],
  canReview: true,
}

describe('DataOps connector catalogue', () => {
  it('defaults to disabled and persists enabled/capability state', async () => {
    const file = await path()
    expect(await readConnectorState(file)).toEqual({ enabled: false, capabilities: {} })
    const next: DataOpsConnectorState = { enabled: true, capabilities: { 'skill.plaza': false } }
    await writeConnectorState(next, file)
    expect(await readConnectorState(file)).toEqual(next)
  })

  it('omits capabilities the current scope cannot use', () => {
    const user = buildConnectorView({ roleCodes: ['应用人员'], permissions: [] }, { enabled: true, capabilities: {} })
    expect(user.capabilities.map(row => row.id)).toEqual(['data.query'])
    const admin = buildConnectorView(ADMIN_SCOPE, { enabled: true, capabilities: {} })
    expect(admin.capabilities.map(row => row.id)).toEqual(['skill.plaza', 'review.queue', 'data.query'])
  })

  it('reserves the API documentation capability for the super administrator', () => {
    const superAdmin = buildConnectorView({ roleCodes: ['超级管理员'], permissions: [] }, { enabled: true, capabilities: {} })
    expect(superAdmin.capabilities.map(row => row.id)).toContain('api.docs')
    expect(buildConnectorView(ADMIN_SCOPE, { enabled: true, capabilities: {} }).capabilities.map(row => row.id))
      .not.toContain('api.docs')
  })

  it('returns no capabilities when no scope is known', () => {
    expect(buildConnectorView(undefined, { enabled: true, capabilities: {} }).capabilities).toEqual([])
  })
})
