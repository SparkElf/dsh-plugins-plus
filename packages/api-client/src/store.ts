import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type { ApiAuthSecretInput, ApiClientState, ApiCollection, ApiEnvironment, ApiEnvironmentVariable, ApiRequest, ApiResponse, ApiWorkspace } from './types.ts'

interface StoredData extends ApiClientState { version: 1 }

export class ApiClientStore {
  private readonly dataFile: string
  private readonly vault: WorkbenchVault
  private data: StoredData | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: { dataFile?: string; vault?: WorkbenchVault } = {}) {
    this.dataFile = options.dataFile ?? join(homedir(), '.dsh', 'api-client.json')
    this.vault = options.vault ?? new WorkbenchVault()
  }

  private async load(): Promise<StoredData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    this.data = existsSync(this.dataFile)
      ? JSON.parse(await readFile(this.dataFile, 'utf8')) as StoredData
      : { version: 1, workspaces: [], collections: [], environments: [], requests: [], history: [] }
    if (this.data.version !== 1) throw new Error('Unsupported API Client data format')
    return this.data
  }

  private async persist(): Promise<void> {
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  async state(): Promise<ApiClientState> {
    await this.mutations
    const data = await this.load()
    return {
      workspaces: data.workspaces.map(item => ({ ...item, collectionIds: [...item.collectionIds], environmentIds: [...item.environmentIds] })),
      collections: data.collections.map(item => ({ ...item, tags: [...item.tags], requestIds: [...item.requestIds] })),
      environments: data.environments.map(item => ({ ...item, variables: item.variables.map(variable => ({ ...variable, value: variable.secret ? null : variable.value })) })),
      requests: data.requests.map(item => ({ ...item, query: item.query.map(value => ({ ...value })), headers: item.headers.map(value => ({ ...value })), auth: { ...item.auth, options: { ...item.auth.options } }, body: { ...item.body } })),
      history: data.history.map(item => ({ ...item, headers: item.headers.map(value => ({ ...value })) })),
    }
  }

  async saveWorkspace(input: ApiWorkspace): Promise<ApiWorkspace> {
    return this.enqueue(async () => {
      const data = await this.load()
      const workspace: ApiWorkspace = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), collectionIds: [...new Set(input.collectionIds)], environmentIds: [...new Set(input.environmentIds)] }
      if (workspace.name === '') throw new Error('API workspace name is required')
      const index = data.workspaces.findIndex(item => item.id === workspace.id)
      if (index === -1) data.workspaces.push(workspace)
      else data.workspaces[index] = workspace
      await this.persist()
      return workspace
    })
  }

  async saveCollection(input: ApiCollection): Promise<ApiCollection> {
    return this.enqueue(async () => {
      const data = await this.load()
      if (!data.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error('API workspace not found: ' + input.workspaceId)
      if (input.parentId !== null && !data.collections.some(collection => collection.id === input.parentId && collection.workspaceId === input.workspaceId)) throw new Error('API parent collection not found: ' + input.parentId)
      const collection: ApiCollection = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], requestIds: [...new Set(input.requestIds)] }
      if (collection.name === '') throw new Error('API collection name is required')
      const index = data.collections.findIndex(item => item.id === collection.id)
      if (index === -1) data.collections.push(collection)
      else data.collections[index] = collection
      data.workspaces = data.workspaces.map(workspace => workspace.id === collection.workspaceId ? { ...workspace, collectionIds: [...new Set([...workspace.collectionIds, collection.id])] } : workspace)
      await this.persist()
      return collection
    })
  }

  async saveEnvironment(input: ApiEnvironment): Promise<ApiEnvironment> {
    return this.enqueue(async () => {
      const data = await this.load()
      if (!data.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error('API workspace not found: ' + input.workspaceId)
      const id = input.id === '' ? randomUUID() : input.id
      const variables: ApiEnvironmentVariable[] = []
      for (const variable of input.variables) {
        const key = variable.key.trim()
        if (key === '') continue
        const credentialId = variable.secret ? variable.credentialId ?? id + ':' + key : null
        if (variable.secret && variable.value !== null && variable.value !== '') await this.vault.set('api-environment', credentialId as string, { value: variable.value })
        if (!variable.secret && variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
        variables.push({ ...variable, key, value: variable.secret ? null : variable.value, credentialId })
      }
      const environment: ApiEnvironment = { ...input, id, name: input.name.trim(), variables }
      if (environment.name === '') throw new Error('API environment name is required')
      const index = data.environments.findIndex(item => item.id === id)
      if (index === -1) data.environments.push(environment)
      else data.environments[index] = environment
      data.workspaces = data.workspaces.map(workspace => workspace.id === environment.workspaceId ? { ...workspace, environmentIds: [...new Set([...workspace.environmentIds, environment.id])] } : workspace)
      await this.persist()
      return environment
    })
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const environment = data.environments.find(item => item.id === environmentId)
      if (environment === undefined) return
      for (const variable of environment.variables) if (variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
      data.environments = data.environments.filter(item => item.id !== environmentId)
      data.workspaces = data.workspaces.map(workspace => ({ ...workspace, environmentIds: workspace.environmentIds.filter(id => id !== environmentId) }))
      data.requests = data.requests.map(request => request.environmentId === environmentId ? { ...request, environmentId: null } : request)
      await this.persist()
    })
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const ids = new Set([collectionId])
      let changed = true
      while (changed) { changed = false; for (const collection of data.collections) if (collection.parentId !== null && ids.has(collection.parentId) && !ids.has(collection.id)) { ids.add(collection.id); changed = true } }
      const requests = data.requests.filter(request => ids.has(request.collectionId))
      for (const request of requests) if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      const requestIds = new Set(requests.map(request => request.id))
      data.requests = data.requests.filter(request => !requestIds.has(request.id))
      data.history = data.history.filter(response => !requestIds.has(response.requestId))
      data.collections = data.collections.filter(collection => !ids.has(collection.id)).map(collection => ({ ...collection, requestIds: collection.requestIds.filter(id => !requestIds.has(id)) }))
      data.workspaces = data.workspaces.map(workspace => ({ ...workspace, collectionIds: workspace.collectionIds.filter(id => !ids.has(id)) }))
      await this.persist()
    })
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const collectionIds = new Set(data.collections.filter(collection => collection.workspaceId === workspaceId).map(collection => collection.id))
      const environments = data.environments.filter(environment => environment.workspaceId === workspaceId)
      const requests = data.requests.filter(request => collectionIds.has(request.collectionId))
      for (const environment of environments) for (const variable of environment.variables) if (variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
      for (const request of requests) if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      const requestIds = new Set(requests.map(request => request.id))
      data.workspaces = data.workspaces.filter(workspace => workspace.id !== workspaceId)
      data.collections = data.collections.filter(collection => !collectionIds.has(collection.id))
      data.environments = data.environments.filter(environment => environment.workspaceId !== workspaceId)
      data.requests = data.requests.filter(request => !requestIds.has(request.id))
      data.history = data.history.filter(response => !requestIds.has(response.requestId))
      await this.persist()
    })
  }

  async saveRequest(input: ApiRequest, authSecret?: ApiAuthSecretInput): Promise<ApiRequest> {
    return this.enqueue(async () => {
      const data = await this.load()
      const collection = data.collections.find(item => item.id === input.collectionId)
      if (collection === undefined) throw new Error('API collection not found: ' + input.collectionId)
      if (input.environmentId !== null && !data.environments.some(environment => environment.id === input.environmentId && environment.workspaceId === collection.workspaceId)) throw new Error('API environment not found: ' + input.environmentId)
      const id = input.id === '' ? randomUUID() : input.id
      const credentialId = input.auth.kind === 'none' || input.auth.kind === 'inherit' ? null : input.auth.credentialId ?? id
      if (authSecret !== undefined && Object.values(authSecret).some(value => value !== undefined && value !== '')) await this.vault.set('api-auth', credentialId as string, authSecret as Record<string, unknown>)
      const request: ApiRequest = { ...input, id, name: input.name.trim(), url: input.url.trim(), query: input.query.map(value => ({ ...value })), headers: input.headers.map(value => ({ ...value })), auth: { ...input.auth, credentialId, options: { ...input.auth.options } }, body: { ...input.body } }
      if (request.name === '' || request.url === '') throw new Error('API request name and URL are required')
      const index = data.requests.findIndex(item => item.id === id)
      if (index === -1) data.requests.push(request)
      else data.requests[index] = request
      data.collections = data.collections.map(item => item.id === request.collectionId ? { ...item, requestIds: [...new Set([...item.requestIds, request.id])] } : item)
      await this.persist()
      return request
    })
  }

  async deleteRequest(requestId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const request = data.requests.find(item => item.id === requestId)
      if (request === undefined) return
      data.requests = data.requests.filter(item => item.id !== requestId)
      data.collections = data.collections.map(collection => ({ ...collection, requestIds: collection.requestIds.filter(id => id !== requestId) }))
      data.history = data.history.filter(response => response.requestId !== requestId)
      if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      await this.persist()
    })
  }

  async request(requestId: string): Promise<ApiRequest> {
    const request = (await this.state()).requests.find(item => item.id === requestId)
    if (request === undefined) throw new Error('API request not found: ' + requestId)
    return request
  }

  async environmentValues(environmentId: string | null): Promise<Record<string, string>> {
    if (environmentId === null) return {}
    const environment = (await this.state()).environments.find(item => item.id === environmentId)
    if (environment === undefined) throw new Error('API environment not found: ' + environmentId)
    const values: Record<string, string> = {}
    for (const variable of environment.variables) {
      if (!variable.enabled) continue
      if (!variable.secret) values[variable.key] = variable.value ?? ''
      else if (variable.credentialId !== null) values[variable.key] = (await this.vault.get<{ value: string }>('api-environment', variable.credentialId))?.value ?? ''
    }
    return values
  }

  async authSecret(request: ApiRequest): Promise<ApiAuthSecretInput | undefined> {
    return request.auth.credentialId === null ? undefined : this.vault.get<ApiAuthSecretInput & Record<string, unknown>>('api-auth', request.auth.credentialId)
  }

  async addHistory(response: ApiResponse): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      data.history = [response, ...data.history.filter(item => item.id !== response.id)].slice(0, 100)
      await this.persist()
    })
  }
}
