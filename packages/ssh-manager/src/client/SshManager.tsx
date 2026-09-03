import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  VscAdd,
  VscArrowUp,
  VscChevronDown,
  VscChevronRight,
  VscClose,
  VscCloudDownload,
  VscCloudUpload,
  VscComment,
  VscDebugDisconnect,
  VscEdit,
  VscFile,
  VscFiles,
  VscFolder,
  VscFolderOpened,
  VscInfo,
  VscKey,
  VscKebabVertical,
  VscLayoutSidebarLeft,
  VscPlug,
  VscPulse,
  VscRefresh,
  VscRemoteExplorer,
  VscSearch,
  VscServerEnvironment,
  VscTerminal,
  VscTrash,
} from 'react-icons/vsc'
import type {
  SshCluster,
  SshCredentialInput,
  SshEnvironment,
  SshFileDownload,
  SshFileListing,
  SshHost,
  SshManagerState,
  SshPortForward,
  SshPortForwardRequest,
  SshTerminalSession,
} from '../types.ts'
import { loadSshState, sshApi } from './api.ts'
import { formatBytes, joinedPath, parentPath, pathBreadcrumbs } from './model.ts'
import { Select, type SelectOption } from './Select.tsx'
import { useT, type TranslationKey } from './i18n.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import css from './SshManager.module.css'

interface ConversationInput { state: { getSnapshot(): { draft: string } }; setDraft(text: string): void }
interface ClientServices { sessions: { scope(sessionId: string): Context | undefined }; conversation: { input: { for(scope: Context): ConversationInput } } }
type WorkspaceView = 'hosts' | 'terminal' | 'files' | 'tunnels'
type InventoryContextMenu =
  | { kind: 'host'; id: string; x: number; y: number }
  | { kind: 'cluster'; id: string; x: number; y: number }

const EMPTY: SshManagerState = { clusters: [], hosts: [] }
const ENVIRONMENTS: SshEnvironment[] = ['development', 'testing', 'staging', 'production', 'other']
const ENVIRONMENT_LABELS: Record<SshEnvironment, TranslationKey> = {
  development: 'environment.development',
  testing: 'environment.testing',
  staging: 'environment.staging',
  production: 'environment.production',
  other: 'environment.other',
}
const AUTH_OPTION_KEYS: Array<{ value: SshHost['authKind']; label: TranslationKey; description: TranslationKey }> = [
  { value: 'password', label: 'auth.password', description: 'auth.passwordDescription' },
  { value: 'private-key', label: 'auth.privateKey', description: 'auth.privateKeyDescription' },
  { value: 'agent', label: 'auth.agent', description: 'auth.agentDescription' },
]
const DIRECTION_OPTION_KEYS: Array<{ value: SshPortForwardRequest['direction']; label: TranslationKey; description: TranslationKey }> = [
  { value: 'local', label: 'tunnels.local', description: 'tunnels.localDescription' },
  { value: 'remote', label: 'tunnels.remote', description: 'tunnels.remoteDescription' },
]
const VIEW_ITEMS: Array<{ id: WorkspaceView; label: TranslationKey; icon: typeof VscTerminal }> = [
  { id: 'hosts', label: 'view.hosts', icon: VscServerEnvironment },
  { id: 'terminal', label: 'view.terminal', icon: VscTerminal },
  { id: 'files', label: 'view.files', icon: VscFiles },
  { id: 'tunnels', label: 'view.tunnels', icon: VscPlug },
]
const TERMINAL_STATE_LABELS: Record<SshTerminalSession['state'], TranslationKey> = {
  connecting: 'terminal.state.connecting',
  connected: 'terminal.state.connected',
  disconnected: 'terminal.state.disconnected',
  failed: 'terminal.state.failed',
}
const FORWARD_STATE_LABELS: Record<SshPortForward['state'], TranslationKey> = {
  active: 'tunnels.state.active',
  disconnected: 'tunnels.state.disconnected',
  failed: 'tunnels.state.failed',
}

function emptyHost(): SshHost {
  return { id: '', name: '', description: '', tags: [], clusterId: null, environment: 'development', hostname: '', port: 22, username: '', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: null, keepAliveSeconds: 30 }
}

function emptyForward(hostId: string): SshPortForwardRequest {
  return { hostId, direction: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 80 }
}

function encodeFile(buffer: ArrayBuffer): string {
  const data = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={css.iconButton} title={label} aria-label={label} {...props}>{children}</button>
}

export function SshManager({ ctx, sessionId, visible }: { ctx: Context; sessionId: string; visible: boolean }) {
  const t = useT()
  const [state, setState] = useState(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [hostForm, setHostForm] = useState<SshHost | null>(null)
  const [credential, setCredential] = useState<SshCredentialInput>({})
  const [clusterForm, setClusterForm] = useState<SshCluster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<SshTerminalSession[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [view, setView] = useState<WorkspaceView>('hosts')
  const [inventoryOpen, setInventoryOpen] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [filePath, setFilePath] = useState('.')
  const [files, setFiles] = useState<SshFileListing | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [forwards, setForwards] = useState<SshPortForward[]>([])
  const [forwardForm, setForwardForm] = useState<SshPortForwardRequest | null>(null)
  const [contextMenu, setContextMenu] = useState<InventoryContextMenu | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const uploadInput = useRef<HTMLInputElement | null>(null)

  const selected = state.hosts.find(host => host.id === selectedId) ?? null
  const activeTerminal = terminals.find(terminal => terminal.id === activeTerminalId) ?? null
  const filtered = useMemo(() => {
    const value = search.trim().toLowerCase()
    return value === '' ? state.hosts : state.hosts.filter(host => [host.name, host.hostname, host.description, ...host.tags].some(field => field.toLowerCase().includes(value)))
  }, [search, state.hosts])
  const groups = useMemo(() => [...state.clusters.map(cluster => ({ cluster, hosts: filtered.filter(host => host.clusterId === cluster.id) })), { cluster: null, hosts: filtered.filter(host => host.clusterId === null) }], [filtered, state.clusters])
  const hostForwards = selected === null ? [] : forwards.filter(forward => forward.hostId === selected.id)
  const environmentOptions = useMemo<SelectOption[]>(() => ENVIRONMENTS.map(value => ({ value, label: t(ENVIRONMENT_LABELS[value]) })), [t])
  const authOptions = useMemo<SelectOption[]>(() => AUTH_OPTION_KEYS.map(option => ({ value: option.value, label: t(option.label), description: t(option.description) })), [t])
  const directionOptions = useMemo<SelectOption[]>(() => DIRECTION_OPTION_KEYS.map(option => ({ value: option.value, label: t(option.label), description: t(option.description) })), [t])
  const clusterOptions = useMemo<SelectOption[]>(() => [{ value: '', label: t('inventory.unclustered') }, ...state.clusters.map(cluster => ({ value: cluster.id, label: cluster.name }))], [state.clusters, t])
  const jumpHostOptions = useMemo<SelectOption[]>(() => [{ value: '', label: t('host.none') }, ...state.hosts.filter(host => host.id !== hostForm?.id).map(host => ({ value: host.id, label: host.name, description: host.username + '@' + host.hostname }))], [hostForm?.id, state.hosts, t])

  const report = (failure: unknown): void => { setError(failure instanceof Error ? failure.message : String(failure)) }
  const beginHost = (clusterId: string | null = null): void => {
    setHostForm({ ...emptyHost(), clusterId })
    setCredential({})
    setContextMenu(null)
  }
  const beginCluster = (cluster: SshCluster = { id: '', name: '', description: '', tags: [], hostIds: [] }): void => {
    setClusterForm({ ...cluster, tags: [...cluster.tags], hostIds: [...cluster.hostIds] })
    setContextMenu(null)
  }
  const deleteHost = async (hostId: string): Promise<void> => {
    try {
      const next = await sshApi<SshManagerState>('hosts.delete', { hostId })
      setState(next)
      setSelectedId(current => current === hostId ? next.hosts[0]?.id ?? null : current)
      setContextMenu(null)
      setError(null)
    } catch (failure) { report(failure) }
  }
  const deleteCluster = async (clusterId: string): Promise<void> => {
    try {
      setState(await sshApi<SshManagerState>('clusters.delete', { clusterId }))
      setContextMenu(null)
      setError(null)
    } catch (failure) { report(failure) }
  }
  const openContextMenu = (kind: InventoryContextMenu['kind'], id: string, x: number, y: number): void => {
    const width = 190
    const height = kind === 'host' ? 164 : 100
    setContextMenu({
      kind,
      id,
      x: Math.max(6, Math.min(x, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
    } as InventoryContextMenu)
  }
  const showPointerContextMenu = (event: ReactMouseEvent<HTMLElement>, kind: InventoryContextMenu['kind'], id: string): void => {
    event.preventDefault()
    event.stopPropagation()
    if (kind === 'host') setSelectedId(id)
    openContextMenu(kind, id, event.clientX, event.clientY)
  }
  const showKeyboardContextMenu = (event: ReactKeyboardEvent<HTMLElement>, kind: InventoryContextMenu['kind'], id: string): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    if (kind === 'host') setSelectedId(id)
    openContextMenu(kind, id, rect.left + Math.min(rect.width - 12, 150), rect.top + 24)
  }
  const refresh = async (): Promise<void> => {
    try {
      const [nextState, nextTerminals, nextForwards] = await Promise.all([
        loadSshState(),
        sshApi<SshTerminalSession[]>('terminals.list', { sessionId }),
        sshApi<SshPortForward[]>('forwards.list', { sessionId }),
      ])
      setState(nextState)
      setSelectedId(current => current ?? nextState.hosts[0]?.id ?? null)
      setTerminals(nextTerminals)
      setActiveTerminalId(current => current ?? nextTerminals.at(-1)?.id ?? null)
      setForwards(nextForwards)
      setError(null)
    } catch (failure) { report(failure) }
  }

  useEffect(() => { if (visible) void refresh() }, [visible, sessionId])
  useEffect(() => {
    setFiles(null)
    setFilePath('.')
    setConnectionStatus(null)
    setForwardForm(selectedId === null ? null : emptyForward(selectedId))
  }, [selectedId])
  useEffect(() => {
    if (contextMenu === null) return
    requestAnimationFrame(() => { contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() })
    const close = (event: MouseEvent): void => {
      if (contextMenuRef.current?.contains(event.target as Node) !== true) setContextMenu(null)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null) }
    const blur = (): void => { setContextMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', blur)
    }
  }, [contextMenu])

  const chooseView = (next: WorkspaceView): void => {
    setView(next)
    if (next === 'hosts') setInventoryOpen(true)
    else setInventoryOpen(false)
    if (next === 'files' && selected !== null && files === null) void browse(selected)
  }

  const saveHost = async (): Promise<void> => {
    if (hostForm === null) return
    try {
      const next = await sshApi<SshManagerState>('hosts.save', { host: hostForm, credential })
      setState(next)
      setSelectedId(next.hosts.find(host => host.id === hostForm.id || host.name === hostForm.name)?.id ?? null)
      setHostForm(null)
      setCredential({})
      setError(null)
    } catch (failure) { report(failure) }
  }

  const saveCluster = async (): Promise<void> => {
    if (clusterForm === null) return
    try { setState(await sshApi('clusters.save', { cluster: clusterForm })); setClusterForm(null); setError(null) } catch (failure) { report(failure) }
  }

  const sendToConversation = (host: SshHost): void => {
    const scope = (ctx as unknown as ClientServices).sessions.scope(sessionId)
    if (scope === undefined) return
    const input = (ctx as unknown as ClientServices).conversation.input.for(scope)
    const cluster = state.clusters.find(item => item.id === host.clusterId)
    const reference = [t('conversation.hostReference'), JSON.stringify({ id: host.id, name: host.name, description: host.description, tags: host.tags, cluster: cluster?.name ?? null, environment: host.environment, hostname: host.hostname, port: host.port, username: host.username, authKind: host.authKind, credentialConfigured: host.credentialConfigured, jumpHost: state.hosts.find(item => item.id === host.jumpHostId)?.name ?? null, knownHostFingerprint: host.knownHostFingerprint }, null, 2)].join('\n')
    const current = input.state.getSnapshot().draft
    input.setDraft(current === '' ? reference : current + '\n\n' + reference)
  }

  const testConnection = async (host: SshHost): Promise<void> => {
    try {
      setConnectionStatus(t('host.connectionTesting'))
      const result = await sshApi<{ latencyMs: number; fingerprint: string }>('hosts.test', { hostId: host.id })
      setConnectionStatus(t('host.connectionConnected', { latency: result.latencyMs, fingerprint: result.fingerprint }))
      setError(null)
    } catch (failure) { setConnectionStatus(null); report(failure) }
  }

  const openTerminal = async (host: SshHost): Promise<void> => {
    try {
      const result = await sshApi<{ terminal: SshTerminalSession; terminals: SshTerminalSession[] }>('terminals.open', { sessionId, hostId: host.id, cols: 80, rows: 24 })
      setTerminals(result.terminals)
      setActiveTerminalId(result.terminal.id)
      setView('terminal')
      setError(null)
    } catch (failure) { report(failure) }
  }

  const reconnectTerminal = async (terminalId: string): Promise<void> => {
    try {
      const result = await sshApi<{ terminal: SshTerminalSession; terminals: SshTerminalSession[] }>('terminals.reconnect', { sessionId, terminalId, cols: 80, rows: 24 })
      setTerminals(result.terminals)
      setActiveTerminalId(result.terminal.id)
      setError(null)
    } catch (failure) { report(failure) }
  }

  const closeTerminal = async (terminalId: string): Promise<void> => {
    try {
      const next = await sshApi<SshTerminalSession[]>('terminals.close', { sessionId, terminalId })
      setTerminals(next)
      setActiveTerminalId(current => current === terminalId ? next.at(-1)?.id ?? null : current)
    } catch (failure) { report(failure) }
  }

  const updateTerminal = (value: SshTerminalSession): void => { setTerminals(current => current.map(terminal => terminal.id === value.id ? value : terminal)) }

  const browse = async (host: SshHost, path = filePath): Promise<void> => {
    try {
      setFileBusy(true)
      const result = await sshApi<SshFileListing>('sftp.list', { hostId: host.id, path })
      setFiles(result)
      setFilePath(result.path)
      setError(null)
    } catch (failure) { report(failure) } finally { setFileBusy(false) }
  }

  const download = async (host: SshHost, path: string): Promise<void> => {
    try {
      setFileBusy(true)
      const result = await sshApi<SshFileDownload>('sftp.download', { hostId: host.id, path })
      const binary = atob(result.data)
      const data = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
      const url = URL.createObjectURL(new Blob([data]))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.name
      anchor.click()
      URL.revokeObjectURL(url)
      setError(null)
    } catch (failure) { report(failure) } finally { setFileBusy(false) }
  }

  const upload = async (host: SshHost, file: File): Promise<void> => {
    try {
      setFileBusy(true)
      const path = joinedPath(filePath, file.name)
      await sshApi('sftp.upload', { hostId: host.id, path, data: encodeFile(await file.arrayBuffer()) })
      await browse(host, filePath)
      setError(null)
    } catch (failure) { report(failure) } finally {
      setFileBusy(false)
      if (uploadInput.current !== null) uploadInput.current.value = ''
    }
  }

  const openForward = async (): Promise<void> => {
    if (forwardForm === null) return
    try {
      const result = await sshApi<{ forward: SshPortForward; forwards: SshPortForward[] }>('forwards.open', { sessionId, forward: forwardForm })
      setForwards(result.forwards)
      setForwardForm(emptyForward(forwardForm.hostId))
      setError(null)
    } catch (failure) { report(failure) }
  }

  const reconnectForward = async (forwardId: string): Promise<void> => {
    try {
      const result = await sshApi<{ forward: SshPortForward; forwards: SshPortForward[] }>('forwards.reconnect', { sessionId, forwardId })
      setForwards(result.forwards)
      setError(null)
    } catch (failure) { report(failure) }
  }

  const closeForward = async (forwardId: string): Promise<void> => {
    try { setForwards(await sshApi<SshPortForward[]>('forwards.close', { sessionId, forwardId })); setError(null) } catch (failure) { report(failure) }
  }

  const toggleGroup = (key: string): void => {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderContextMenu = () => {
    if (contextMenu === null) return null
    const host = contextMenu.kind === 'host' ? state.hosts.find(item => item.id === contextMenu.id) : undefined
    const cluster = contextMenu.kind === 'cluster' ? state.clusters.find(item => item.id === contextMenu.id) : undefined
    if (host === undefined && cluster === undefined) return null
    const label = host === undefined
      ? t('inventory.clusterActions', { name: cluster?.name ?? '' })
      : t('inventory.hostActions', { name: host.name })
    return createPortal(<div
      ref={contextMenuRef}
      className={css.contextMenu}
      role="menu"
      aria-label={label}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onContextMenu={event => { event.preventDefault() }}
      onKeyDown={event => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown') { event.preventDefault(); items[(current + 1) % items.length]?.focus() }
        else if (event.key === 'ArrowUp') { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
        else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
        else if (event.key === 'Escape') { event.preventDefault(); setContextMenu(null) }
      }}
    >
      {host !== undefined ? <>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void openTerminal(host) }}><VscTerminal /><span>{t('host.openTerminal')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void testConnection(host) }}><VscPulse /><span>{t('host.testConnection')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); sendToConversation(host) }}><VscComment /><span>{t('host.sendToConversation')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); setHostForm({ ...host }); setCredential({}) }}><VscEdit /><span>{t('host.edit')}</span></button>
        <button type="button" role="menuitem" data-separator="true" data-danger="true" onClick={() => { void deleteHost(host.id) }}><VscTrash /><span>{t('host.delete')}</span></button>
      </> : <>
        <button type="button" role="menuitem" onClick={() => { beginHost(cluster?.id ?? null) }}><VscAdd /><span>{t('inventory.addHostToCluster')}</span></button>
        <button type="button" role="menuitem" onClick={() => { if (cluster !== undefined) beginCluster(cluster) }}><VscEdit /><span>{t('inventory.editCluster')}</span></button>
        <button type="button" role="menuitem" data-separator="true" data-danger="true" onClick={() => { if (cluster !== undefined) void deleteCluster(cluster.id) }}><VscTrash /><span>{t('inventory.deleteClusterAction')}</span></button>
      </>}
    </div>, document.body)
  }

  const renderInventory = () => <aside className={css.inventory} aria-label={t('inventory.label')} data-overlay={view !== 'hosts'}>
    <header className={css.inventoryHeader}>
      <span title={t('inventory.label')}>{filtered.length}</span>
      <IconButton label={t('inventory.addCluster')} onClick={() => { beginCluster() }}><VscFolder /></IconButton>
      <IconButton label={t('inventory.addHost')} onClick={() => { beginHost() }}><VscAdd /></IconButton>
      {view !== 'hosts' && <IconButton label={t('inventory.close')} onClick={() => { setInventoryOpen(false) }}><VscClose /></IconButton>}
    </header>
    <label className={css.search}><VscSearch aria-hidden="true" /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder={t('inventory.search')} aria-label={t('inventory.search')} /></label>
    <div className={css.tree}>
      {groups.map(group => {
        const key = group.cluster?.id ?? 'unclustered'
        if (group.hosts.length === 0 && group.cluster === null) return null
        const collapsed = collapsedGroups.has(key)
        return <section key={key}>
          <div className={css.group}>
            <button
              type="button"
              className={css.groupToggle}
              aria-expanded={!collapsed}
              onClick={() => { toggleGroup(key) }}
              onContextMenu={group.cluster === null ? undefined : event => { showPointerContextMenu(event, 'cluster', group.cluster?.id ?? '') }}
              onKeyDown={group.cluster === null ? undefined : event => { showKeyboardContextMenu(event, 'cluster', group.cluster?.id ?? '') }}
            >
              {collapsed ? <VscChevronRight /> : <VscChevronDown />}
              {collapsed ? <VscFolder /> : <VscFolderOpened />}
              <span>{group.cluster?.name ?? t('inventory.unclustered')}</span>
              <small>{group.hosts.length}</small>
            </button>
            {group.cluster !== null && <IconButton
              label={t('inventory.clusterActions', { name: group.cluster.name })}
              aria-haspopup="menu"
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                openContextMenu('cluster', group.cluster?.id ?? '', rect.right, rect.bottom)
              }}
            ><VscKebabVertical /></IconButton>}
          </div>
          {!collapsed && group.hosts.map(host => <button
            type="button"
            className={css.hostRow}
            data-selected={host.id === selectedId}
            key={host.id}
            onClick={() => { setSelectedId(host.id) }}
            onDoubleClick={() => { void openTerminal(host) }}
            onContextMenu={event => { showPointerContextMenu(event, 'host', host.id) }}
            onKeyDown={event => { showKeyboardContextMenu(event, 'host', host.id) }}
          >
            <VscServerEnvironment aria-hidden="true" />
            <span><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small></span>
            <i data-ready={host.credentialConfigured} title={t(host.credentialConfigured ? 'inventory.credentialConfigured' : 'inventory.credentialMissing')} />
          </button>)}
        </section>
      })}
      {filtered.length === 0 && <div className={css.emptySmall}>{t('inventory.empty')}</div>}
    </div>
  </aside>

  const renderHostHeader = (title: string) => <header className={css.workHeader}>
    <div className={css.workTitle}><VscServerEnvironment /><span><strong>{title}</strong><small>{selected === null ? t('host.chooseFromExplorer') : selected.username + '@' + selected.hostname + ':' + selected.port.toString()}</small></span></div>
    {selected !== null && <div className={css.workActions}>
      <IconButton label={t('host.openTerminal')} onClick={() => { void openTerminal(selected) }}><VscTerminal /></IconButton>
      <IconButton label={t('host.testConnection')} onClick={() => { void testConnection(selected) }}><VscPulse /></IconButton>
      <IconButton label={t('host.sendToConversation')} onClick={() => { sendToConversation(selected) }}><VscComment /></IconButton>
      <IconButton label={t('host.edit')} onClick={() => { setHostForm({ ...selected }); setCredential({}) }}><VscEdit /></IconButton>
      <IconButton label={t('host.delete')} onClick={() => { void deleteHost(selected.id) }}><VscTrash /></IconButton>
    </div>}
  </header>

  const renderOverview = () => <section className={css.workView} aria-label={t('host.overviewLabel')}>
    {renderHostHeader(selected?.name ?? t('host.overviewTitle'))}
    {selected === null ? <div className={css.empty}><VscServerEnvironment /><strong>{t('host.select')}</strong><span>{t('host.selectDescription')}</span></div> : <div className={css.scrollBody}>
      {connectionStatus !== null && <div className={css.connectionStatus}><VscPulse />{connectionStatus}</div>}
      <dl className={css.hostFacts}>
        <div><dt>{t('host.address')}</dt><dd>{selected.hostname}:{selected.port}</dd></div>
        <div><dt>{t('host.user')}</dt><dd>{selected.username}</dd></div>
        <div><dt>{t('host.environment')}</dt><dd><span className={css.environment} data-environment={selected.environment}>{t(ENVIRONMENT_LABELS[selected.environment])}</span></dd></div>
        <div><dt>{t('host.cluster')}</dt><dd>{state.clusters.find(cluster => cluster.id === selected.clusterId)?.name ?? t('inventory.unclustered')}</dd></div>
        <div><dt>{t('host.authentication')}</dt><dd><VscKey />{t(selected.authKind === 'password' ? 'auth.password' : selected.authKind === 'private-key' ? 'auth.privateKey' : 'auth.agent')} · {t(selected.credentialConfigured ? 'host.configured' : 'host.notConfigured')}</dd></div>
        <div><dt>{t('host.jumpHost')}</dt><dd>{state.hosts.find(host => host.id === selected.jumpHostId)?.name ?? t('host.none')}</dd></div>
        <div><dt>{t('host.keepalive')}</dt><dd>{selected.keepAliveSeconds === 0 ? t('host.disabled') : t('host.seconds', { count: selected.keepAliveSeconds })}</dd></div>
        <div><dt>{t('host.fingerprint')}</dt><dd>{selected.knownHostFingerprint ?? t('host.notPinned')}</dd></div>
      </dl>
      <div className={css.description}><strong>{t('host.description')}</strong><p>{selected.description || t('host.noDescription')}</p>{selected.tags.length > 0 && <div className={css.tags}>{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</div>
    </div>}
  </section>

  const renderTerminal = () => <section className={css.terminalWorkspace} aria-label={t('terminal.workspace')}>
    <header className={css.terminalBar}>
      <div className={css.terminalTabs} role="tablist" aria-label={t('terminal.sessions')}>
        {terminals.map(terminal => <div className={css.terminalTab} data-active={terminal.id === activeTerminalId} key={terminal.id}>
          <button type="button" role="tab" aria-selected={terminal.id === activeTerminalId} onClick={() => { setActiveTerminalId(terminal.id) }}><VscTerminal /><span>{terminal.title}</span><i data-state={terminal.state} /></button>
          <IconButton label={t('terminal.closeNamed', { name: terminal.title })} onClick={() => { void closeTerminal(terminal.id) }}><VscClose /></IconButton>
        </div>)}
      </div>
      <div className={css.terminalActions}>
        <IconButton label={t('terminal.new')} disabled={selected === null} onClick={() => { if (selected !== null) void openTerminal(selected) }}><VscAdd /></IconButton>
        <IconButton label={t('terminal.reconnect')} disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void reconnectTerminal(activeTerminal.id) }}><VscRefresh /></IconButton>
        <IconButton label={t('terminal.closeActive')} disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void closeTerminal(activeTerminal.id) }}><VscDebugDisconnect /></IconButton>
      </div>
    </header>
    <div className={css.terminalStage}>
      {terminals.map(terminal => <TerminalPane key={terminal.id} sessionId={sessionId} terminal={terminal} active={terminal.id === activeTerminalId} onSnapshot={updateTerminal} />)}
      {activeTerminal === null && <div className={css.empty}><VscTerminal /><strong>{t('terminal.empty')}</strong><span>{selected === null ? t('terminal.selectHost') : t('terminal.openOn', { name: selected.name })}</span>{selected !== null && <button type="button" className={css.primary} onClick={() => { void openTerminal(selected) }}><VscAdd />{t('terminal.new')}</button>}</div>}
    </div>
    <footer className={css.statusBar}>
      <span><i data-state={activeTerminal?.state ?? 'disconnected'} />{activeTerminal?.state ?? 'No session'}</span>
      <span>{activeTerminal?.cwd ?? 'Working directory unavailable'}</span>
      <span className={css.spacer} />
      <span>{terminals.length} session{terminals.length === 1 ? '' : 's'}</span>
      {selected !== null && <span>{selected.name}</span>}
    </footer>
  </section>

  const renderFiles = () => <section className={css.workView} aria-label={t('files.label')}>
    {renderHostHeader(t('view.files'))}
    {selected === null ? <div className={css.empty}><VscFiles /><strong>{t('host.select')}</strong><span>{t('files.selectDescription')}</span></div> : <div className={css.fileWorkbench}>
      <div className={css.fileToolbar}>
        <IconButton label={t('files.parentDirectory')} disabled={filePath === '.' || filePath === '/'} onClick={() => { void browse(selected, parentPath(filePath)) }}><VscArrowUp /></IconButton>
        <nav className={css.breadcrumbs} aria-label={t('files.remotePath')}>{pathBreadcrumbs(filePath).map((crumb, index, crumbs) => <span key={crumb.path}><button type="button" disabled={index === crumbs.length - 1} onClick={() => { void browse(selected, crumb.path) }}>{crumb.label}</button>{index < crumbs.length - 1 && <VscChevronRight />}</span>)}</nav>
        <IconButton label={t('files.refresh')} disabled={fileBusy} onClick={() => { void browse(selected) }}><VscRefresh /></IconButton>
        <IconButton label={t('files.upload')} disabled={fileBusy} onClick={() => { uploadInput.current?.click() }}><VscCloudUpload /></IconButton>
        <input ref={uploadInput} className={css.hiddenInput} type="file" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void upload(selected, file) }} />
      </div>
      <div className={css.pathEditor}><span>{t('files.path')}</span><input aria-label={t('files.remotePath')} value={filePath} onChange={event => { setFilePath(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void browse(selected) }} /><button type="button" disabled={fileBusy} onClick={() => { void browse(selected) }}>{t('files.go')}</button></div>
      <div className={css.tableScroll}>
        <table className={css.fileTable}>
          <thead><tr><th>{t('files.name')}</th><th>{t('files.size')}</th><th>{t('files.modified')}</th><th><span className={css.srOnly}>{t('common.actions')}</span></th></tr></thead>
          <tbody>{files?.entries.map(entry => <tr key={entry.path}>
            <td><button type="button" className={css.fileName} disabled={entry.type !== 'directory'} onClick={() => { if (entry.type === 'directory') void browse(selected, entry.path) }}>{entry.type === 'directory' ? <VscFolder /> : <VscFile />}<span>{entry.name}</span></button></td>
            <td>{entry.type === 'directory' ? t('files.folder') : formatBytes(entry.size)}</td>
            <td><time>{new Date(entry.modifiedAt).toLocaleString()}</time></td>
            <td>{entry.type === 'file' && <IconButton label={t('files.download') + ' ' + entry.name} disabled={fileBusy} onClick={() => { void download(selected, entry.path) }}><VscCloudDownload /></IconButton>}</td>
          </tr>)}</tbody>
        </table>
        {files === null && <div className={css.emptySmall}>{fileBusy ? t('files.loading') : t('files.openPath')}</div>}
        {files !== null && files.entries.length === 0 && <div className={css.emptySmall}>{t('files.empty')}</div>}
      </div>
    </div>}
  </section>

  const renderTunnels = () => <section className={css.workView} aria-label={t('tunnels.label')}>
    {renderHostHeader(t('view.tunnels'))}
    {selected === null || forwardForm === null ? <div className={css.empty}><VscPlug /><strong>{t('host.select')}</strong><span>{t('tunnels.selectDescription')}</span></div> : <div className={css.tunnelWorkbench}>
      <section className={css.forwardComposer} aria-label={t('tunnels.new')}>
        <header><strong>{t('tunnels.new')}</strong><span>{t('tunnels.forwardThrough', { name: selected.name })}</span></header>
        <div className={css.forwardForm}>
          <label>{t('tunnels.direction')}<Select label={t('tunnels.direction')} value={forwardForm.direction} options={directionOptions} onChange={value => { setForwardForm({ ...forwardForm, direction: value as SshPortForwardRequest['direction'] }) }} /></label>
          <label>{t('tunnels.bindHost')}<input value={forwardForm.bindHost} onChange={event => { setForwardForm({ ...forwardForm, bindHost: event.target.value }) }} /></label>
          <label>{t('tunnels.bindPort')}<input type="number" min={0} max={65535} value={forwardForm.bindPort} onChange={event => { setForwardForm({ ...forwardForm, bindPort: Number(event.target.value) }) }} /></label>
          <span className={css.forwardArrow}>{t('tunnels.to')}</span>
          <label>{t('tunnels.targetHost')}<input value={forwardForm.targetHost} onChange={event => { setForwardForm({ ...forwardForm, targetHost: event.target.value }) }} /></label>
          <label>{t('tunnels.targetPort')}<input type="number" min={1} max={65535} value={forwardForm.targetPort} onChange={event => { setForwardForm({ ...forwardForm, targetPort: Number(event.target.value) }) }} /></label>
          <button type="button" className={css.primary} title={t('tunnels.openTitle')} onClick={() => { void openForward() }}><VscAdd />{t('tunnels.open')}</button>
        </div>
      </section>
      <div className={css.tableScroll}>
        <table className={css.tunnelTable}>
          <thead><tr><th>{t('tunnels.direction')}</th><th>{t('tunnels.listenAddress')}</th><th>{t('tunnels.target')}</th><th>{t('tunnels.status')}</th><th><span className={css.srOnly}>{t('common.actions')}</span></th></tr></thead>
          <tbody>{hostForwards.map(forward => <tr key={forward.id}>
            <td><span className={css.direction}><VscPlug />{forward.direction === 'local' ? t('tunnels.local') : t('tunnels.remote')}</span></td>
            <td>{forward.bindHost}:{forward.bindPort}</td>
            <td>{forward.targetHost}:{forward.targetPort}</td>
            <td><span className={css.forwardState} data-state={forward.state}><i />{t(('tunnels.state.' + forward.state) as TranslationKey)}</span>{forward.error !== undefined && <small className={css.danger}>{forward.error}</small>}</td>
            <td><div className={css.rowActions}>{forward.state !== 'active' && <IconButton label={t('tunnels.reconnect')} onClick={() => { void reconnectForward(forward.id) }}><VscRefresh /></IconButton>}<IconButton label={t('tunnels.close')} onClick={() => { void closeForward(forward.id) }}><VscDebugDisconnect /></IconButton></div></td>
          </tr>)}</tbody>
        </table>
        {hostForwards.length === 0 && <div className={css.emptySmall}>{t('tunnels.empty')}</div>}
      </div>
    </div>}
  </section>

  return <div className={css.root} data-dsh-ssh-manager>
    <header className={css.toolbar}>
      <div className={css.brand}><VscRemoteExplorer size={18} /><strong>{t('app.title')}</strong></div>
      <nav className={css.viewSwitch} aria-label={t('app.workspaceView')}>{VIEW_ITEMS.map(item => {
        const Icon = item.icon
        return <button type="button" key={item.id} data-active={view === item.id} aria-pressed={view === item.id} onClick={() => { chooseView(item.id) }}><Icon /><span>{t(item.label)}</span>{item.id === 'terminal' && terminals.length > 0 && <small>{terminals.length}</small>}</button>
      })}</nav>
      <div className={css.globalActions}>
        <IconButton label={t(inventoryOpen ? 'app.hideExplorer' : 'app.showExplorer')} aria-pressed={inventoryOpen} onClick={() => { setInventoryOpen(current => !current) }}><VscLayoutSidebarLeft /></IconButton>
        <IconButton label={t('inventory.addCluster')} onClick={() => { beginCluster() }}><VscFolder /></IconButton>
        <IconButton label={t('inventory.addHost')} onClick={() => { beginHost() }}><VscAdd /></IconButton>
      </div>
    </header>
    {error !== null && <div className={css.error} role="alert"><VscInfo />{error}<IconButton label={t('action.dismissError')} onClick={() => { setError(null) }}><VscClose /></IconButton></div>}
    <div className={css.workspace} data-inventory={inventoryOpen} data-overlay={view !== 'hosts'}>
      {inventoryOpen && renderInventory()}
      <main className={css.mainWorkspace}>{view === 'hosts' ? renderOverview() : view === 'terminal' ? renderTerminal() : view === 'files' ? renderFiles() : renderTunnels()}</main>
    </div>
    {renderContextMenu()}

    {hostForm !== null && <div className={css.backdrop}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t('dialog.host')}>
        <header><div><strong>{t(hostForm.id === '' ? 'dialog.addHost' : 'dialog.editHost')}</strong><span>{t('dialog.hostSecrets')}</span></div><IconButton label={t('action.close')} onClick={() => { setHostForm(null); setCredential({}) }}><VscClose /></IconButton></header>
        <div className={css.form}>
          <label>{t('field.name')}<input autoFocus value={hostForm.name} onChange={event => { setHostForm({ ...hostForm, name: event.target.value }) }} /></label>
          <label>{t('field.hostname')}<input value={hostForm.hostname} onChange={event => { setHostForm({ ...hostForm, hostname: event.target.value }) }} /></label>
          <label>{t('field.port')}<input type="number" min={1} max={65535} value={hostForm.port} onChange={event => { setHostForm({ ...hostForm, port: Number(event.target.value) }) }} /></label>
          <label>{t('field.user')}<input value={hostForm.username} onChange={event => { setHostForm({ ...hostForm, username: event.target.value }) }} /></label>
          <label>{t('field.environment')}<Select label={t('field.environment')} value={hostForm.environment} options={environmentOptions} onChange={value => { setHostForm({ ...hostForm, environment: value as SshEnvironment }) }} /></label>
          <label>{t('field.cluster')}<Select label={t('field.cluster')} value={hostForm.clusterId ?? ''} options={clusterOptions} onChange={value => { setHostForm({ ...hostForm, clusterId: value || null }) }} /></label>
          <label>{t('field.authentication')}<Select label={t('field.authentication')} value={hostForm.authKind} options={authOptions} onChange={value => { setHostForm({ ...hostForm, authKind: value as SshHost['authKind'] }); setCredential({}) }} /></label>
          {hostForm.authKind === 'password' && <label>{t('field.password')}<input type="password" value={credential.password ?? ''} onChange={event => { setCredential({ password: event.target.value }) }} placeholder={hostForm.credentialConfigured ? t('field.keepCredential') : ''} /></label>}
          {hostForm.authKind === 'private-key' && <><label className={css.full}>{t('field.privateKey')}<textarea value={credential.privateKey ?? ''} onChange={event => { setCredential({ ...credential, privateKey: event.target.value }) }} placeholder={hostForm.credentialConfigured ? t('field.keepCredential') : t('field.privateKeyPlaceholder')} /></label><label>{t('field.passphrase')}<input type="password" value={credential.passphrase ?? ''} onChange={event => { setCredential({ ...credential, passphrase: event.target.value }) }} /></label></>}
          <label>{t('field.jumpHost')}<Select label={t('field.jumpHost')} value={hostForm.jumpHostId ?? ''} options={jumpHostOptions} onChange={value => { setHostForm({ ...hostForm, jumpHostId: value || null }) }} /></label>
          <label>{t('field.keepaliveSeconds')}<input type="number" min={0} value={hostForm.keepAliveSeconds} onChange={event => { setHostForm({ ...hostForm, keepAliveSeconds: Number(event.target.value) }) }} /></label>
          <label className={css.full}>{t('field.knownHostFingerprint')}<input value={hostForm.knownHostFingerprint ?? ''} onChange={event => { setHostForm({ ...hostForm, knownHostFingerprint: event.target.value || null }) }} placeholder={t('field.fingerprintPlaceholder')} /></label>
          <label className={css.full}>{t('field.tags')}<input value={hostForm.tags.join(', ')} onChange={event => { setHostForm({ ...hostForm, tags: event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) }) }} placeholder={t('field.tagsPlaceholder')} /></label>
          <label className={css.full}>{t('field.description')}<textarea value={hostForm.description} onChange={event => { setHostForm({ ...hostForm, description: event.target.value }) }} /></label>
        </div>
        <footer><button type="button" onClick={() => { setHostForm(null); setCredential({}) }}>{t('action.cancel')}</button><button type="button" className={css.primary} disabled={hostForm.name.trim() === '' || hostForm.hostname.trim() === '' || hostForm.username.trim() === ''} onClick={() => { void saveHost() }}>{t('action.saveHost')}</button></footer>
      </div>
    </div>}

    {clusterForm !== null && <div className={css.backdrop}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t('dialog.cluster')}>
        <header><div><strong>{t(clusterForm.id === '' ? 'dialog.addCluster' : 'dialog.editCluster')}</strong><span>{t('dialog.clusterDescription')}</span></div><IconButton label={t('action.close')} onClick={() => { setClusterForm(null) }}><VscClose /></IconButton></header>
        <div className={css.form}><label className={css.full}>{t('field.name')}<input autoFocus value={clusterForm.name} onChange={event => { setClusterForm({ ...clusterForm, name: event.target.value }) }} /></label><label className={css.full}>{t('field.description')}<textarea value={clusterForm.description} onChange={event => { setClusterForm({ ...clusterForm, description: event.target.value }) }} /></label></div>
        <footer><button type="button" onClick={() => { setClusterForm(null) }}>{t('action.cancel')}</button><button type="button" className={css.primary} disabled={clusterForm.name.trim() === ''} onClick={() => { void saveCluster() }}>{t('action.saveCluster')}</button></footer>
      </div>
    </div>}
  </div>
}
