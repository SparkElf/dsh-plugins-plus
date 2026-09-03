import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  VscAdd,
  VscClose,
  VscCloud,
  VscCloudDownload,
  VscCloudUpload,
  VscCode,
  VscComment,
  VscEdit,
  VscFolder,
  VscHistory,
  VscJson,
  VscPlay,
  VscSave,
  VscSearch,
  VscTrash,
  VscSymbolVariable,
} from 'react-icons/vsc'
import type {
  ApiAuthKind,
  ApiAuthSecretInput,
  ApiBodyKind,
  ApiClientState,
  ApiCollection,
  ApiEnvironment,
  ApiKeyValue,
  ApiMethod,
  ApiMultipartPart,
  ApiRequest,
  ApiResponse,
  ApiWorkspace,
} from '../types.ts'
import { apiClientCall, type ApiExchangeFormat, type ExecuteResult, type ExportResult, type ImportResult, loadApiState } from './api.ts'
import { ActionMenu, Select, type SelectOption } from './Dropdown.tsx'
import { cloneRequest, formatResponseBody, readMultipartParts, requestFingerprint, responseCookies, responseForRequest, writeMultipartParts } from './model.ts'
import css from './ApiClient.module.css'

interface ConversationInput { state: { getSnapshot(): { draft: string } }; setDraft(text: string): void }
interface ClientServices { sessions: { scope(sessionId: string): Context | undefined }; conversation: { input: { for(scope: Context): ConversationInput } } }
type EditorTab = 'params' | 'headers' | 'auth' | 'body'
type ResponseTab = 'pretty' | 'raw' | 'headers' | 'cookies' | 'history'
type NarrowView = 'explorer' | 'request' | 'response'
type CreateKind = 'workspace' | 'collection' | 'environment'
interface RequestDraftTab {
  key: string
  draft: ApiRequest
  savedFingerprint: string | null
  authSecret: ApiAuthSecretInput
  selectedResponseId: string | null
}

const EMPTY: ApiClientState = { workspaces: [], collections: [], environments: [], requests: [], history: [] }
const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const METHOD_OPTIONS: SelectOption<ApiMethod>[] = METHODS.map(value => ({ value, label: value }))
const AUTH_OPTIONS: SelectOption<ApiAuthKind>[] = [
  { value: 'none', label: 'No auth' },
  { value: 'inherit', label: 'Inherit auth' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api-key', label: 'API key' },
  { value: 'oauth2', label: 'OAuth 2.0 token' },
]
const BODY_OPTIONS: SelectOption<ApiBodyKind>[] = [
  { value: 'none', label: 'none' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'form', label: 'x-www-form-urlencoded' },
  { value: 'multipart', label: 'form-data' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'binary', label: 'Binary (Base64)' },
]
const LOCATION_OPTIONS = [{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query' }]
const PART_OPTIONS = [{ value: 'text', label: 'Text' }, { value: 'file', label: 'File' }]

function emptyRequest(collectionId: string): ApiRequest {
  return { id: '', collectionId, name: 'New request', description: '', method: 'GET', url: 'https://', query: [], headers: [], auth: { kind: 'none', credentialId: null, options: {} }, body: { kind: 'none', content: '' }, environmentId: null }
}
function emptyRow(): ApiKeyValue { return { key: '', value: '', enabled: true } }
function isDirty(tab: RequestDraftTab): boolean { return tab.savedFingerprint === null || tab.savedFingerprint !== requestFingerprint(tab.draft) }

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" className={css.iconButton} title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}

function KeyValues({ values, onChange, valueLabel = 'Value' }: { values: ApiKeyValue[]; onChange(values: ApiKeyValue[]): void; valueLabel?: string }) {
  return <div className={css.keyValues}>
    <div className={css.tableHead}><span /><span>Key</span><span>{valueLabel}</span><span /></div>
    {values.map((item, index) => <div className={css.keyRow} key={index}>
      <input aria-label={'Enable row ' + (index + 1).toString()} type="checkbox" checked={item.enabled} onChange={event => { const next = [...values]; next[index] = { ...item, enabled: event.target.checked }; onChange(next) }} />
      <input aria-label={'Key ' + (index + 1).toString()} placeholder="Key" value={item.key} onChange={event => { const next = [...values]; next[index] = { ...item, key: event.target.value }; onChange(next) }} />
      <input aria-label={valueLabel + ' ' + (index + 1).toString()} placeholder={valueLabel} value={item.value} onChange={event => { const next = [...values]; next[index] = { ...item, value: event.target.value }; onChange(next) }} />
      <IconButton label="Delete row" onClick={() => { onChange(values.filter((_, row) => row !== index)) }}><VscTrash /></IconButton>
    </div>)}
    <button type="button" className={css.addRow} onClick={() => { onChange([...values, emptyRow()]) }}><VscAdd />Add row</button>
  </div>
}

function MultipartEditor({ content, onChange }: { content: string; onChange(content: string): void }) {
  const parts = readMultipartParts(content)
  const update = (index: number, patch: Partial<ApiMultipartPart>): void => { const next = [...parts]; next[index] = { ...next[index] as ApiMultipartPart, ...patch }; onChange(writeMultipartParts(next)) }
  return <div className={css.keyValues}>
    <div className={[css.tableHead, css.multipartHead].join(' ')}><span /><span>Name</span><span>Value</span><span>Type</span><span /></div>
    {parts.map((part, index) => <div className={[css.keyRow, css.multipartRow].join(' ')} key={index}>
      <input aria-label={'Enable part ' + (index + 1).toString()} type="checkbox" checked={part.enabled} onChange={event => { update(index, { enabled: event.target.checked }) }} />
      <input aria-label={'Part name ' + (index + 1).toString()} placeholder="Part name" value={part.key} onChange={event => { update(index, { key: event.target.value }) }} />
      <input aria-label={'Part value ' + (index + 1).toString()} placeholder={part.type === 'file' ? 'Text or base64 file data' : 'Value'} value={part.value} onChange={event => { update(index, { value: event.target.value }) }} />
      <Select label={'Part type ' + (index + 1).toString()} value={part.type} options={PART_OPTIONS} onChange={type => { update(index, { type: type as ApiMultipartPart['type'] }) }} />
      <IconButton label="Delete part" onClick={() => { onChange(writeMultipartParts(parts.filter((_, row) => row !== index))) }}><VscTrash /></IconButton>
    </div>)}
    <button type="button" className={css.addRow} onClick={() => { onChange(writeMultipartParts([...parts, { key: '', value: '', enabled: true, type: 'text' }])) }}><VscAdd />Add part</button>
  </div>
}

function ResponseViewer({ response, history, tab, onTab, onHistory }: { response: ApiResponse | null; history: ApiResponse[]; tab: ResponseTab; onTab(tab: ResponseTab): void; onHistory(id: string): void }) {
  const cookies = response === null ? [] : responseCookies(response)
  return <section className={css.responsePane} aria-label="Response">
    <header className={css.responseHeader}>
      <strong>Response</strong>
      {response !== null && <div className={css.responseMetrics}><span data-status={response.status}>{response.status} {response.statusText}</span><span>{response.durationMs} ms</span><span>{response.sizeBytes.toLocaleString()} B</span>{response.bodyTruncated && <span>Truncated</span>}</div>}
    </header>
    <nav className={css.tabs} aria-label="Response views">
      {(['pretty', 'raw', 'headers', 'cookies', 'history'] as ResponseTab[]).map(value => <button type="button" data-active={tab === value} key={value} onClick={() => { onTab(value) }}>{value}{value === 'history' && history.length > 0 ? ' (' + history.length.toString() + ')' : ''}</button>)}
    </nav>
    <div className={css.responseContent}>
      {tab !== 'history' && response === null && <div className={css.empty}>Send a request to view its response</div>}
      {response !== null && tab === 'pretty' && <pre className={css.code}>{formatResponseBody(response.body)}</pre>}
      {response !== null && tab === 'raw' && <pre className={css.code}>{response.body}</pre>}
      {response !== null && tab === 'headers' && <div className={css.responseTable}>{response.headers.map((header, index) => <div key={index}><strong>{header.key}</strong><span>{header.value}</span></div>)}</div>}
      {response !== null && tab === 'cookies' && (cookies.length === 0 ? <div className={css.empty}>No response cookies</div> : <div className={css.responseTable}>{cookies.map((cookie, index) => <div key={index}><strong>{cookie.name}</strong><span>{cookie.value}</span><small>{cookie.attributes}</small></div>)}</div>)}
      {tab === 'history' && <div className={css.history}>{history.length === 0 ? <div className={css.empty}>No request history</div> : history.map(item => <button type="button" key={item.id} data-selected={item.id === response?.id} onClick={() => { onHistory(item.id) }}><strong>{item.status}</strong><span>{new Date(item.receivedAt).toLocaleString()}</span><span>{item.durationMs} ms</span><span>{item.sizeBytes.toLocaleString()} B</span></button>)}</div>}
    </div>
  </section>
}

export function ApiClient({ ctx, sessionId, visible }: { ctx: Context; sessionId: string; visible: boolean }) {
  const [state, setState] = useState(EMPTY)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null)
  const [requestTabs, setRequestTabs] = useState<RequestDraftTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  const [editorTab, setEditorTab] = useState<EditorTab>('params')
  const [responseTab, setResponseTab] = useState<ResponseTab>('pretty')
  const [narrowView, setNarrowView] = useState<NarrowView>('explorer')
  const [search, setSearch] = useState('')
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [createName, setCreateName] = useState('')
  const [editResourceId, setEditResourceId] = useState<string | null>(null)
  const [environmentKey, setEnvironmentKey] = useState('baseUrl')
  const [environmentValue, setEnvironmentValue] = useState('')
  const [environmentSecret, setEnvironmentSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const importInput = useRef<HTMLInputElement | null>(null)
  const newTabId = useRef(0)

  const workspace = state.workspaces.find(item => item.id === workspaceId) ?? state.workspaces[0] ?? null
  const collections = state.collections.filter(item => item.workspaceId === workspace?.id)
  const environments = state.environments.filter(item => item.workspaceId === workspace?.id)
  const activeTab = requestTabs.find(item => item.key === activeTabKey) ?? null
  const draft = activeTab?.draft ?? null
  const activeAuthSecret = activeTab?.authSecret ?? {}
  const requests = useMemo(() => {
    const ids = new Set(collections.flatMap(item => item.requestIds))
    const needle = search.trim().toLowerCase()
    return state.requests.filter(item => ids.has(item.id) && (needle === '' || [item.name, item.url, item.description].some(value => value.toLowerCase().includes(needle))))
  }, [collections, search, state.requests])
  const response = responseForRequest(state.history, draft?.id, activeTab?.selectedResponseId ?? null)
  const requestHistory = state.history.filter(item => item.requestId === draft?.id)

  const updateActiveTab = (update: (tab: RequestDraftTab) => RequestDraftTab): void => { if (activeTabKey !== null) setRequestTabs(items => items.map(item => item.key === activeTabKey ? update(item) : item)) }
  const updateDraft = (update: (draft: ApiRequest) => ApiRequest): void => { updateActiveTab(item => ({ ...item, draft: update(item.draft) })) }
  const updateAuthSecret = (value: ApiAuthSecretInput): void => { updateActiveTab(item => ({ ...item, authSecret: value })) }

  const refresh = async (): Promise<void> => {
    try {
      const next = await loadApiState()
      setState(next)
      setWorkspaceId(current => current ?? next.workspaces[0]?.id ?? null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  useEffect(() => { if (visible) void refresh() }, [visible])

  const activateRequest = (request: ApiRequest): void => {
    const existing = requestTabs.find(item => item.draft.id === request.id)
    if (existing !== undefined) setActiveTabKey(existing.key)
    else {
      const next: RequestDraftTab = { key: request.id, draft: cloneRequest(request), savedFingerprint: requestFingerprint(request), authSecret: {}, selectedResponseId: null }
      setRequestTabs(items => [...items, next])
      setActiveTabKey(next.key)
    }
    setActiveEnvironmentId(request.environmentId)
    setEditorTab('params')
    setNarrowView('request')
  }
  const createRequest = (collectionId: string): void => {
    const request = emptyRequest(collectionId)
    const key = 'new-' + (++newTabId.current).toString()
    setRequestTabs(items => [...items, { key, draft: request, savedFingerprint: null, authSecret: {}, selectedResponseId: null }])
    setActiveTabKey(key)
    setEditorTab('params')
    setNarrowView('request')
  }
  const closeRequestTab = (key: string): void => {
    const index = requestTabs.findIndex(item => item.key === key)
    const next = requestTabs.filter(item => item.key !== key)
    setRequestTabs(next)
    if (activeTabKey === key) setActiveTabKey(next[Math.min(index, next.length - 1)]?.key ?? null)
  }
  const save = async (): Promise<ApiRequest | null> => {
    if (activeTab === null) return null
    try {
      const next = await apiClientCall<ApiClientState>('requests.save', { request: activeTab.draft, authSecret: activeAuthSecret })
      const saved = next.requests.find(item => item.id === activeTab.draft.id) ?? [...next.requests].reverse().find(item => item.collectionId === activeTab.draft.collectionId && item.name === activeTab.draft.name) ?? null
      setState(next)
      if (saved !== null) setRequestTabs(items => items.map(item => item.key === activeTab.key ? { ...item, draft: cloneRequest(saved), savedFingerprint: requestFingerprint(saved), authSecret: {} } : item))
      setError(null)
      return saved
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return null }
  }
  const send = async (): Promise<void> => {
    setSending(true)
    try {
      const request = await save()
      if (request === null) return
      const result = await apiClientCall<ExecuteResult>('requests.execute', { requestId: request.id })
      setState(result.state)
      updateActiveTab(item => ({ ...item, selectedResponseId: result.response.id }))
      setResponseTab('pretty')
      setNarrowView('response')
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setSending(false) }
  }
  const sendToConversation = (): void => {
    if (draft === null) return
    const scope = (ctx as unknown as ClientServices).sessions.scope(sessionId)
    if (scope === undefined) return
    const input = (ctx as unknown as ClientServices).conversation.input.for(scope)
    const collection = state.collections.find(item => item.id === draft.collectionId)
    const reference = 'API request reference:' + String.fromCharCode(10) + JSON.stringify({ id: draft.id || null, workspace: workspace?.name ?? null, collection: collection?.name ?? null, name: draft.name, description: draft.description, method: draft.method, url: draft.url, query: draft.query.filter(item => item.enabled), headers: draft.headers.filter(item => item.enabled).map(item => ({ ...item, value: item.key.toLowerCase() === 'authorization' ? '[redacted]' : item.value })), auth: { kind: draft.auth.kind, options: draft.auth.options }, body: draft.body, environment: environments.find(item => item.id === draft.environmentId)?.name ?? null }, null, 2)
    const current = input.state.getSnapshot().draft
    input.setDraft(current === '' ? reference : current + String.fromCharCode(10, 10) + reference)
  }

  const beginResource = (kind: CreateKind, id: string | null = null): void => {
    setCreateKind(kind)
    setEditResourceId(id)
    if (kind === 'workspace') setCreateName(state.workspaces.find(item => item.id === id)?.name ?? '')
    else if (kind === 'collection') setCreateName(state.collections.find(item => item.id === id)?.name ?? '')
    else {
      const environment = state.environments.find(item => item.id === id)
      const variable = environment?.variables[0]
      setCreateName(environment?.name ?? '')
      setEnvironmentKey(variable?.key ?? 'baseUrl')
      setEnvironmentValue(variable?.value ?? '')
      setEnvironmentSecret(variable?.secret ?? false)
    }
  }
  const deleteResource = async (kind: CreateKind, id: string): Promise<void> => {
    try {
      const next = await apiClientCall<ApiClientState>(kind + 's.delete', { [kind + 'Id']: id })
      setState(next)
      if (kind === 'workspace') {
        setWorkspaceId(next.workspaces[0]?.id ?? null)
        setRequestTabs([])
        setActiveTabKey(null)
      } else {
        setRequestTabs(items => items.filter(item => item.draft.id === '' || next.requests.some(request => request.id === item.draft.id)).map(item => kind === 'environment' && item.draft.environmentId === id ? { ...item, draft: { ...item.draft, environmentId: null } } : item))
      }
      if (kind === 'environment' && activeEnvironmentId === id) setActiveEnvironmentId(null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const deleteRequest = async (): Promise<void> => {
    if (draft?.id === undefined || draft.id === '') { if (activeTab !== null) closeRequestTab(activeTab.key); return }
    try {
      const next = await apiClientCall<ApiClientState>('requests.delete', { requestId: draft.id })
      setState(next)
      if (activeTab !== null) closeRequestTab(activeTab.key)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const exportWorkspace = async (format: ApiExchangeFormat): Promise<void> => {
    if (workspace === null) return
    try {
      const result = await apiClientCall<ExportResult>('workspaces.export', { workspaceId: workspace.id, format })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.document, null, 2)], { type: result.mimeType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.fileName
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const importWorkspace = async (file: File): Promise<void> => {
    try {
      const document = JSON.parse(await file.text()) as unknown
      const format: ApiExchangeFormat = typeof document === 'object' && document !== null && 'openapi' in document ? 'openapi' : 'postman'
      const result = await apiClientCall<ImportResult>('workspaces.import', { format, document })
      setState(result.state)
      setWorkspaceId(result.workspaceId)
      setRequestTabs([])
      setActiveTabKey(null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { if (importInput.current !== null) importInput.current.value = '' }
  }
  const create = async (): Promise<void> => {
    if (createKind === null || createName.trim() === '') return
    try {
      let next: ApiClientState
      if (createKind === 'workspace') {
        const existing = state.workspaces.find(item => item.id === editResourceId)
        next = await apiClientCall('workspaces.save', { workspace: { id: editResourceId ?? '', name: createName, description: existing?.description ?? '', collectionIds: existing?.collectionIds ?? [], environmentIds: existing?.environmentIds ?? [] } satisfies ApiWorkspace })
      } else if (createKind === 'collection') {
        if (workspace === null) throw new Error('Create a workspace first')
        const existing = state.collections.find(item => item.id === editResourceId)
        next = await apiClientCall('collections.save', { collection: { id: editResourceId ?? '', workspaceId: workspace.id, parentId: existing?.parentId ?? null, name: createName, description: existing?.description ?? '', tags: existing?.tags ?? [], requestIds: existing?.requestIds ?? [] } satisfies ApiCollection })
      } else {
        if (workspace === null) throw new Error('Create a workspace first')
        const existing = state.environments.find(item => item.id === editResourceId)
        const first = environmentKey.trim() === '' ? [] : [{ key: environmentKey, value: environmentValue, credentialId: existing?.variables[0]?.credentialId ?? null, enabled: true, secret: environmentSecret }]
        next = await apiClientCall('environments.save', { environment: { id: editResourceId ?? '', workspaceId: workspace.id, name: createName, variables: [...first, ...(existing?.variables.slice(1) ?? [])] } satisfies ApiEnvironment })
      }
      setState(next)
      if (createKind === 'workspace') setWorkspaceId(editResourceId ?? next.workspaces.at(-1)?.id ?? null)
      setCreateKind(null)
      setEditResourceId(null)
      setCreateName('')
      setEnvironmentValue('')
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }

  const workspaceOptions = state.workspaces.map(item => ({ value: item.id, label: item.name }))
  const environmentOptions = [{ value: '', label: 'No environment' }, ...environments.map(item => ({ value: item.id, label: item.name, description: item.variables.length.toString() + ' variables' }))]
  const selectedEnvironmentId = draft?.environmentId ?? activeEnvironmentId ?? ''

  return <div className={css.root} data-dsh-api-client data-narrow-view={narrowView}>
    <header className={css.projectHeader}>
      <div className={css.brand}><VscCloud aria-hidden="true" /><span>API Client</span></div>
      <Select className={css.workspaceSelect} searchable label="Workspace" value={workspace?.id ?? ''} options={workspaceOptions} placeholder="Select workspace" onChange={value => { setWorkspaceId(value); setActiveEnvironmentId(null); setRequestTabs([]); setActiveTabKey(null); setNarrowView('explorer') }} />
      <span className={css.headerDivider} />
      <VscSymbolVariable className={css.headerIcon} aria-hidden="true" />
      <Select className={css.environmentSelect} searchable label="Environment" value={selectedEnvironmentId} options={environmentOptions} onChange={value => { const environmentId = value || null; setActiveEnvironmentId(environmentId); if (draft !== null) updateDraft(item => ({ ...item, environmentId })) }} />
      <ActionMenu label="Environment actions" items={[
        { id: 'new-environment', label: 'New environment', icon: <VscAdd />, disabled: workspace === null, onSelect: () => { beginResource('environment') } },
        { id: 'edit-environment', label: 'Edit environment', icon: <VscEdit />, disabled: selectedEnvironmentId === '', onSelect: () => { if (selectedEnvironmentId !== '') beginResource('environment', selectedEnvironmentId) } },
        { id: 'delete-environment', label: 'Delete environment', icon: <VscTrash />, danger: true, disabled: selectedEnvironmentId === '', onSelect: () => { if (selectedEnvironmentId !== '') void deleteResource('environment', selectedEnvironmentId) } },
      ]} />
      <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void importWorkspace(file) }} />
      <ActionMenu label="Project actions" items={[
        { id: 'new-workspace', label: 'New workspace', icon: <VscAdd />, onSelect: () => { beginResource('workspace') } },
        { id: 'edit-workspace', label: 'Rename workspace', icon: <VscEdit />, disabled: workspace === null, onSelect: () => { if (workspace !== null) beginResource('workspace', workspace.id) } },
        { id: 'delete-workspace', label: 'Delete workspace', icon: <VscTrash />, danger: true, disabled: workspace === null, onSelect: () => { if (workspace !== null) void deleteResource('workspace', workspace.id) } },
        { id: 'import', label: 'Import Postman / OpenAPI', icon: <VscCloudUpload />, separator: true, onSelect: () => { importInput.current?.click() } },
        { id: 'export-postman', label: 'Export as Postman', icon: <VscJson />, disabled: workspace === null, onSelect: () => { void exportWorkspace('postman') } },
        { id: 'export-openapi', label: 'Export as OpenAPI', icon: <VscCode />, disabled: workspace === null, onSelect: () => { void exportWorkspace('openapi') } },
      ]} />
    </header>
    <nav className={css.modeSwitch} aria-label="Workbench panel">
      {(['explorer', 'request', 'response'] as NarrowView[]).map(value => <button type="button" key={value} data-active={narrowView === value} disabled={value !== 'explorer' && draft === null} onClick={() => { setNarrowView(value) }}>{value}</button>)}
    </nav>
    {error !== null && <div className={css.error} role="alert"><span>{error}</span><IconButton label="Dismiss error" onClick={() => { setError(null) }}><VscClose /></IconButton></div>}
    <div className={css.content}>
      <aside className={css.inventory} aria-label="Collections and requests">
        <header className={css.explorerHeader}><strong>Collections</strong><IconButton label="Add collection" disabled={workspace === null} onClick={() => { beginResource('collection') }}><VscAdd /></IconButton></header>
        <label className={css.search}><VscSearch aria-hidden="true" /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder="Search requests" aria-label="Search requests" /></label>
        <div className={css.tree}>
          {workspace === null && <div className={css.emptyAside}>Create or import a workspace</div>}
          {workspace !== null && collections.length === 0 && <div className={css.emptyAside}>No collections</div>}
          {collections.map(collection => <section key={collection.id}>
            <div className={css.collection}><VscFolder aria-hidden="true" /><strong>{collection.name}</strong><span>{requests.filter(request => request.collectionId === collection.id).length}</span><ActionMenu label={collection.name + ' actions'} items={[
              { id: 'add-request', label: 'New request', icon: <VscAdd />, onSelect: () => { createRequest(collection.id) } },
              { id: 'rename-collection', label: 'Rename collection', icon: <VscEdit />, onSelect: () => { beginResource('collection', collection.id) } },
              { id: 'delete-collection', label: 'Delete collection', icon: <VscTrash />, danger: true, separator: true, onSelect: () => { void deleteResource('collection', collection.id) } },
            ]} /></div>
            {requests.filter(request => request.collectionId === collection.id).map(request => <button type="button" className={css.requestRow} data-selected={request.id === draft?.id} key={request.id} onClick={() => { activateRequest(request) }}><b data-method={request.method}>{request.method}</b><span><strong>{request.name}</strong><small>{request.url || 'No URL'}</small></span></button>)}
          </section>)}
        </div>
      </aside>
      <main className={css.workbench}>
        <nav className={css.requestTabs} aria-label="Open requests">
          {requestTabs.length === 0 && <span>No open requests</span>}
          {requestTabs.map(item => <div key={item.key} data-active={item.key === activeTabKey}><button type="button" title={item.draft.name} onClick={() => { setActiveTabKey(item.key); setNarrowView('request') }}><b data-method={item.draft.method}>{item.draft.method}</b><span>{item.draft.name || 'Untitled'}</span>{isDirty(item) && <i aria-label="Unsaved changes" />}</button><IconButton label={'Close ' + (item.draft.name || 'request')} onClick={() => { closeRequestTab(item.key) }}><VscClose /></IconButton></div>)}
        </nav>
        {draft === null ? <div className={css.empty}>Select a request from the explorer</div> : <div className={css.split}>
          <section className={css.requestPane} aria-label="Request editor">
            <div className={css.requestBar}>
              <Select className={css.methodSelect} label="HTTP method" value={draft.method} options={METHOD_OPTIONS} onChange={method => { updateDraft(item => ({ ...item, method })) }} renderValue={option => <b data-method={option?.value}>{option?.label}</b>} />
              <input className={css.urlInput} aria-label="Request URL" value={draft.url} onChange={event => { updateDraft(item => ({ ...item, url: event.target.value })) }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send() }} placeholder="https://api.example.com/resource" />
              <IconButton label="Save request" onClick={() => { void save() }}><VscSave /></IconButton>
              <IconButton label="Send to conversation" onClick={sendToConversation}><VscComment /></IconButton>
              <button type="button" className={css.send} disabled={sending} onClick={() => { void send() }}><VscPlay aria-hidden="true" /><span>{sending ? 'Sending' : 'Send'}</span></button>
            </div>
            <div className={css.requestMeta}>
              <input aria-label="Request name" value={draft.name} onChange={event => { updateDraft(item => ({ ...item, name: event.target.value })) }} placeholder="Request name" />
              <span className={css.collectionPath}><VscFolder aria-hidden="true" />{state.collections.find(item => item.id === draft.collectionId)?.name ?? 'Unknown collection'}</span>
              <ActionMenu label="Request actions" items={[{ id: 'delete-request', label: draft.id === '' ? 'Discard request' : 'Delete request', icon: <VscTrash />, danger: true, onSelect: () => { void deleteRequest() } }]} />
            </div>
            <nav className={css.tabs} aria-label="Request editor tabs">
              {(['params', 'headers', 'auth', 'body'] as EditorTab[]).map(value => <button type="button" data-active={editorTab === value} key={value} onClick={() => { setEditorTab(value) }}>{value}{value === 'params' && draft.query.length > 0 ? ' (' + draft.query.length.toString() + ')' : value === 'headers' && draft.headers.length > 0 ? ' (' + draft.headers.length.toString() + ')' : ''}</button>)}
            </nav>
            <div className={css.editorContent}>
              {editorTab === 'params' && <KeyValues values={draft.query} onChange={query => { updateDraft(item => ({ ...item, query })) }} />}
              {editorTab === 'headers' && <KeyValues values={draft.headers} onChange={headers => { updateDraft(item => ({ ...item, headers })) }} />}
              {editorTab === 'auth' && <div className={css.authEditor}>
                <label><span>Auth type</span><Select label="Authorization type" value={draft.auth.kind} options={AUTH_OPTIONS} onChange={kind => { updateDraft(item => ({ ...item, auth: { kind, credentialId: item.auth.credentialId, options: {} } })); updateAuthSecret({}) }} /></label>
                {draft.auth.kind === 'basic' && <><label><span>Username</span><input value={activeAuthSecret.username ?? ''} onChange={event => { updateAuthSecret({ ...activeAuthSecret, username: event.target.value }) }} /></label><label><span>Password</span><input type="password" autoComplete="new-password" value={activeAuthSecret.password ?? ''} onChange={event => { updateAuthSecret({ ...activeAuthSecret, password: event.target.value }) }} placeholder={draft.auth.credentialId ? 'Leave blank to keep current' : ''} /></label></>}
                {(draft.auth.kind === 'bearer' || draft.auth.kind === 'oauth2') && <label><span>Token</span><input type="password" autoComplete="new-password" value={activeAuthSecret.token ?? ''} onChange={event => { updateAuthSecret({ token: event.target.value }) }} placeholder={draft.auth.credentialId ? 'Leave blank to keep current' : ''} /></label>}
                {draft.auth.kind === 'api-key' && <><label><span>Key name</span><input value={draft.auth.options.name ?? ''} onChange={event => { updateDraft(item => ({ ...item, auth: { ...item.auth, options: { ...item.auth.options, name: event.target.value } } })) }} /></label><label><span>Location</span><Select label="API key location" value={draft.auth.options.location ?? 'header'} options={LOCATION_OPTIONS} onChange={location => { updateDraft(item => ({ ...item, auth: { ...item.auth, options: { ...item.auth.options, location } } })) }} /></label><label><span>Value</span><input type="password" autoComplete="new-password" value={activeAuthSecret.key ?? ''} onChange={event => { updateAuthSecret({ key: event.target.value }) }} placeholder={draft.auth.credentialId ? 'Leave blank to keep current' : ''} /></label></>}
                {(draft.auth.kind === 'none' || draft.auth.kind === 'inherit') && <p className={css.hint}>{draft.auth.kind === 'inherit' ? 'Authorization is inherited from the imported collection definition.' : 'This request will be sent without authorization.'}</p>}
              </div>}
              {editorTab === 'body' && <div className={css.bodyEditor}>
                <Select className={css.bodyType} label="Request body type" value={draft.body.kind} options={BODY_OPTIONS} onChange={kind => { updateDraft(item => ({ ...item, body: { ...item.body, kind } })) }} />
                {draft.body.kind === 'none' ? <div className={css.empty}>This request has no body</div> : draft.body.kind === 'multipart' ? <MultipartEditor content={draft.body.content} onChange={bodyContent => { updateDraft(item => ({ ...item, body: { ...item.body, content: bodyContent } })) }} /> : <textarea aria-label="Request body" spellCheck={false} value={draft.body.content} onChange={event => { updateDraft(item => ({ ...item, body: { ...item.body, content: event.target.value } })) }} />}
              </div>}
            </div>
          </section>
          <div className={css.splitter} aria-hidden="true" />
          <ResponseViewer response={response} history={requestHistory} tab={responseTab} onTab={setResponseTab} onHistory={id => { updateActiveTab(item => ({ ...item, selectedResponseId: id })); setResponseTab('pretty') }} />
        </div>}
      </main>
    </div>
    {createKind !== null && <div className={css.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) setCreateKind(null) }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label={(editResourceId === null ? 'Create ' : 'Edit ') + createKind}>
      <header><strong>{editResourceId === null ? 'Create' : 'Edit'} {createKind}</strong><IconButton label="Close" onClick={() => { setCreateKind(null) }}><VscClose /></IconButton></header>
      <label><span>Name</span><input autoFocus value={createName} onChange={event => { setCreateName(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void create() }} /></label>
      {createKind === 'environment' && <><label><span>Variable key</span><input value={environmentKey} onChange={event => { setEnvironmentKey(event.target.value) }} /></label><label><span>Variable value</span><input type={environmentSecret ? 'password' : 'text'} value={environmentValue} onChange={event => { setEnvironmentValue(event.target.value) }} /></label><label className={css.check}><input type="checkbox" checked={environmentSecret} onChange={event => { setEnvironmentSecret(event.target.checked) }} /><span>Store as secret</span></label></>}
      <footer><button type="button" onClick={() => { setCreateKind(null) }}>Cancel</button><button type="button" className={css.primary} disabled={createName.trim() === ''} onClick={() => { void create() }}>{editResourceId === null ? 'Create' : 'Save'}</button></footer>
    </div></div>}
  </div>
}
