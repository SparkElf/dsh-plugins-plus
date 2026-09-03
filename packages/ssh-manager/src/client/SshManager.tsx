import { useEffect, useMemo, useRef, useState } from 'react'
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
import { TerminalPane } from './TerminalPane.tsx'
import css from './SshManager.module.css'

interface ConversationInput { state: { getSnapshot(): { draft: string } }; setDraft(text: string): void }
interface ClientServices { sessions: { scope(sessionId: string): Context | undefined }; conversation: { input: { for(scope: Context): ConversationInput } } }
type WorkspaceView = 'hosts' | 'terminal' | 'files' | 'tunnels'

const EMPTY: SshManagerState = { clusters: [], hosts: [] }
const ENVIRONMENTS: SshEnvironment[] = ['development', 'testing', 'staging', 'production', 'other']
const ENVIRONMENT_OPTIONS: SelectOption[] = ENVIRONMENTS.map(value => ({ value, label: value[0]?.toUpperCase() + value.slice(1) }))
const AUTH_OPTIONS: SelectOption[] = [
  { value: 'password', label: 'Password', description: 'Stored in central credentials' },
  { value: 'private-key', label: 'Private key', description: 'OpenSSH key and optional passphrase' },
  { value: 'agent', label: 'SSH agent', description: 'Use the host SSH agent' },
]
const DIRECTION_OPTIONS: SelectOption[] = [
  { value: 'local', label: 'Local', description: 'Listen locally and forward to remote' },
  { value: 'remote', label: 'Remote', description: 'Listen remotely and forward to local' },
]
const VIEW_ITEMS: Array<{ id: WorkspaceView; label: string; icon: typeof VscTerminal }> = [
  { id: 'hosts', label: 'Hosts', icon: VscServerEnvironment },
  { id: 'terminal', label: 'Terminal', icon: VscTerminal },
  { id: 'files', label: 'Files', icon: VscFiles },
  { id: 'tunnels', label: 'Tunnels', icon: VscPlug },
]

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
  const [state, setState] = useState(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [hostForm, setHostForm] = useState<SshHost | null>(null)
  const [credential, setCredential] = useState<SshCredentialInput>({})
  const [clusterForm, setClusterForm] = useState<SshCluster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [commandOutput, setCommandOutput] = useState<string | null>(null)
  const [runningCommand, setRunningCommand] = useState(false)
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
  const uploadInput = useRef<HTMLInputElement | null>(null)

  const selected = state.hosts.find(host => host.id === selectedId) ?? null
  const activeTerminal = terminals.find(terminal => terminal.id === activeTerminalId) ?? null
  const filtered = useMemo(() => {
    const value = search.trim().toLowerCase()
    return value === '' ? state.hosts : state.hosts.filter(host => [host.name, host.hostname, host.description, ...host.tags].some(field => field.toLowerCase().includes(value)))
  }, [search, state.hosts])
  const groups = useMemo(() => [...state.clusters.map(cluster => ({ cluster, hosts: filtered.filter(host => host.clusterId === cluster.id) })), { cluster: null, hosts: filtered.filter(host => host.clusterId === null) }], [filtered, state.clusters])
  const hostForwards = selected === null ? [] : forwards.filter(forward => forward.hostId === selected.id)
  const clusterOptions = useMemo<SelectOption[]>(() => [{ value: '', label: 'Unclustered' }, ...state.clusters.map(cluster => ({ value: cluster.id, label: cluster.name }))], [state.clusters])
  const jumpHostOptions = useMemo<SelectOption[]>(() => [{ value: '', label: 'None' }, ...state.hosts.filter(host => host.id !== hostForm?.id).map(host => ({ value: host.id, label: host.name, description: host.username + '@' + host.hostname }))], [hostForm?.id, state.hosts])

  const report = (failure: unknown): void => { setError(failure instanceof Error ? failure.message : String(failure)) }
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
    const reference = ['SSH host reference:', JSON.stringify({ id: host.id, name: host.name, description: host.description, tags: host.tags, cluster: cluster?.name ?? null, environment: host.environment, hostname: host.hostname, port: host.port, username: host.username, authKind: host.authKind, credentialConfigured: host.credentialConfigured, jumpHost: state.hosts.find(item => item.id === host.jumpHostId)?.name ?? null, knownHostFingerprint: host.knownHostFingerprint }, null, 2)].join('\n')
    const current = input.state.getSnapshot().draft
    input.setDraft(current === '' ? reference : current + '\n\n' + reference)
  }

  const testConnection = async (host: SshHost): Promise<void> => {
    try {
      setConnectionStatus('Testing connection')
      const result = await sshApi<{ latencyMs: number; fingerprint: string }>('hosts.test', { hostId: host.id })
      setConnectionStatus('Connected in ' + result.latencyMs.toString() + ' ms · ' + result.fingerprint)
      setError(null)
    } catch (failure) { setConnectionStatus(null); report(failure) }
  }

  const runCommand = async (host: SshHost): Promise<void> => {
    if (command.trim() === '') return
    try {
      setRunningCommand(true)
      const result = await sshApi<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; truncated: boolean }>('hosts.execute', { hostId: host.id, command, timeoutMs: 60_000 })
      setCommandOutput([result.stdout, result.stderr].filter(Boolean).join(String.fromCharCode(10)) + String.fromCharCode(10) + '[exit ' + String(result.exitCode) + ' · ' + result.durationMs.toString() + ' ms' + (result.truncated ? ' · truncated' : '') + ']')
      setError(null)
    } catch (failure) { report(failure) } finally { setRunningCommand(false) }
  }

  const openTerminal = async (host: SshHost): Promise<void> => {
    try {
      const result = await sshApi<{ terminal: SshTerminalSession; terminals: SshTerminalSession[] }>('terminals.open', { sessionId, hostId: host.id, cols: 80, rows: 24 })
      setTerminals(result.terminals)
      setActiveTerminalId(result.terminal.id)
      setView('terminal')
      setInventoryOpen(false)
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

  const renderInventory = () => <aside className={css.inventory} aria-label="SSH hosts" data-overlay={view !== 'hosts'}>
    <header className={css.inventoryHeader}>
      <strong>Host explorer</strong>
      <span>{filtered.length}</span>
      <IconButton label="Add cluster" onClick={() => { setClusterForm({ id: '', name: '', description: '', tags: [], hostIds: [] }) }}><VscFolder /></IconButton>
      <IconButton label="Add host" onClick={() => { setHostForm(emptyHost()); setCredential({}) }}><VscAdd /></IconButton>
      {view !== 'hosts' && <IconButton label="Close host explorer" onClick={() => { setInventoryOpen(false) }}><VscClose /></IconButton>}
    </header>
    <label className={css.search}><VscSearch aria-hidden="true" /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder="Search hosts" aria-label="Search hosts" /></label>
    <div className={css.tree}>
      {groups.map(group => {
        const key = group.cluster?.id ?? 'unclustered'
        if (group.hosts.length === 0 && group.cluster === null) return null
        const collapsed = collapsedGroups.has(key)
        return <section key={key}>
          <div className={css.group}>
            <button type="button" className={css.groupToggle} aria-expanded={!collapsed} onClick={() => { toggleGroup(key) }}>
              {collapsed ? <VscChevronRight /> : <VscChevronDown />}
              {collapsed ? <VscFolder /> : <VscFolderOpened />}
              <span>{group.cluster?.name ?? 'Unclustered'}</span>
              <small>{group.hosts.length}</small>
            </button>
            {group.cluster !== null && <IconButton label={'Delete cluster ' + group.cluster.name} onClick={() => { void sshApi<SshManagerState>('clusters.delete', { clusterId: group.cluster?.id }).then(setState).catch(report) }}><VscTrash /></IconButton>}
          </div>
          {!collapsed && group.hosts.map(host => <button
            type="button"
            className={css.hostRow}
            data-selected={host.id === selectedId}
            key={host.id}
            onClick={() => { setSelectedId(host.id) }}
            onDoubleClick={() => { void openTerminal(host) }}
          >
            <VscServerEnvironment aria-hidden="true" />
            <span><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small></span>
            <i data-ready={host.credentialConfigured} title={host.credentialConfigured ? 'Credential configured' : 'Credential missing'} />
          </button>)}
        </section>
      })}
      {filtered.length === 0 && <div className={css.emptySmall}>No matching hosts</div>}
    </div>
  </aside>

  const renderHostHeader = (title: string) => <header className={css.workHeader}>
    <div className={css.workTitle}><VscServerEnvironment /><span><strong>{title}</strong><small>{selected === null ? 'Choose a host from the explorer' : selected.username + '@' + selected.hostname + ':' + selected.port.toString()}</small></span></div>
    {selected !== null && <div className={css.workActions}>
      <IconButton label="Open new terminal" onClick={() => { void openTerminal(selected) }}><VscTerminal /></IconButton>
      <IconButton label="Test connection" onClick={() => { void testConnection(selected) }}><VscPulse /></IconButton>
      <IconButton label="Send host to conversation" onClick={() => { sendToConversation(selected) }}><VscComment /></IconButton>
      <IconButton label="Edit host" onClick={() => { setHostForm({ ...selected }); setCredential({}) }}><VscEdit /></IconButton>
      <IconButton label="Delete host" onClick={() => { void sshApi<SshManagerState>('hosts.delete', { hostId: selected.id }).then(next => { setState(next); setSelectedId(next.hosts[0]?.id ?? null) }).catch(report) }}><VscTrash /></IconButton>
    </div>}
  </header>

  const renderOverview = () => <section className={css.workView} aria-label="Host overview">
    {renderHostHeader(selected?.name ?? 'Host overview')}
    {selected === null ? <div className={css.empty}><VscServerEnvironment /><strong>Select a host</strong><span>Use the host explorer to inspect connection details.</span></div> : <div className={css.scrollBody}>
      {connectionStatus !== null && <div className={css.connectionStatus}><VscPulse />{connectionStatus}</div>}
      <dl className={css.hostFacts}>
        <div><dt>Address</dt><dd>{selected.hostname}:{selected.port}</dd></div>
        <div><dt>User</dt><dd>{selected.username}</dd></div>
        <div><dt>Environment</dt><dd><span className={css.environment} data-environment={selected.environment}>{selected.environment}</span></dd></div>
        <div><dt>Cluster</dt><dd>{state.clusters.find(cluster => cluster.id === selected.clusterId)?.name ?? 'Unclustered'}</dd></div>
        <div><dt>Authentication</dt><dd><VscKey />{selected.authKind} · {selected.credentialConfigured ? 'configured' : 'not configured'}</dd></div>
        <div><dt>Jump host</dt><dd>{state.hosts.find(host => host.id === selected.jumpHostId)?.name ?? 'None'}</dd></div>
        <div><dt>Keepalive</dt><dd>{selected.keepAliveSeconds === 0 ? 'Disabled' : selected.keepAliveSeconds.toString() + ' seconds'}</dd></div>
        <div><dt>Fingerprint</dt><dd>{selected.knownHostFingerprint ?? 'Not pinned'}</dd></div>
      </dl>
      <div className={css.description}><strong>Description</strong><p>{selected.description || 'No description'}</p>{selected.tags.length > 0 && <div className={css.tags}>{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</div>
      <section className={css.commandPane}>
        <header><VscTerminal /><strong>Run one command</strong><span>60 second timeout</span></header>
        <div><input aria-label="SSH command" value={command} onChange={event => { setCommand(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void runCommand(selected) }} placeholder="Enter a command" /><button type="button" className={css.primary} disabled={runningCommand || command.trim() === ''} onClick={() => { void runCommand(selected) }}>{runningCommand ? 'Running' : 'Run'}</button></div>
        {commandOutput !== null && <pre>{commandOutput}</pre>}
      </section>
    </div>}
  </section>

  const renderTerminal = () => <section className={css.terminalWorkspace} aria-label="Terminal workspace">
    <header className={css.terminalBar}>
      <div className={css.terminalTabs} role="tablist" aria-label="Terminal sessions">
        {terminals.map(terminal => <div className={css.terminalTab} data-active={terminal.id === activeTerminalId} key={terminal.id}>
          <button type="button" role="tab" aria-selected={terminal.id === activeTerminalId} onClick={() => { setActiveTerminalId(terminal.id) }}><VscTerminal /><span>{terminal.title}</span><i data-state={terminal.state} /></button>
          <IconButton label={'Close ' + terminal.title} onClick={() => { void closeTerminal(terminal.id) }}><VscClose /></IconButton>
        </div>)}
      </div>
      <div className={css.terminalActions}>
        <IconButton label="New terminal" disabled={selected === null} onClick={() => { if (selected !== null) void openTerminal(selected) }}><VscAdd /></IconButton>
        <IconButton label="Reconnect terminal" disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void reconnectTerminal(activeTerminal.id) }}><VscRefresh /></IconButton>
        <IconButton label="Close active terminal" disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void closeTerminal(activeTerminal.id) }}><VscDebugDisconnect /></IconButton>
      </div>
    </header>
    <div className={css.terminalStage}>
      {terminals.map(terminal => <TerminalPane key={terminal.id} sessionId={sessionId} terminal={terminal} active={terminal.id === activeTerminalId} onSnapshot={updateTerminal} />)}
      {activeTerminal === null && <div className={css.empty}><VscTerminal /><strong>No terminal session</strong><span>{selected === null ? 'Select a host, then create a terminal.' : 'Open a shell on ' + selected.name + '.'}</span>{selected !== null && <button type="button" className={css.primary} onClick={() => { void openTerminal(selected) }}><VscAdd />New terminal</button>}</div>}
    </div>
    <footer className={css.statusBar}>
      <span><i data-state={activeTerminal?.state ?? 'disconnected'} />{activeTerminal?.state ?? 'No session'}</span>
      <span>{activeTerminal?.cwd ?? 'Working directory unavailable'}</span>
      <span className={css.spacer} />
      <span>{terminals.length} session{terminals.length === 1 ? '' : 's'}</span>
      {selected !== null && <span>{selected.name}</span>}
    </footer>
  </section>

  const renderFiles = () => <section className={css.workView} aria-label="SFTP files">
    {renderHostHeader('Files')}
    {selected === null ? <div className={css.empty}><VscFiles /><strong>Select a host</strong><span>Remote files are scoped to the selected connection.</span></div> : <div className={css.fileWorkbench}>
      <div className={css.fileToolbar}>
        <IconButton label="Parent directory" disabled={filePath === '.' || filePath === '/'} onClick={() => { void browse(selected, parentPath(filePath)) }}><VscArrowUp /></IconButton>
        <nav className={css.breadcrumbs} aria-label="Remote path">{pathBreadcrumbs(filePath).map((crumb, index, crumbs) => <span key={crumb.path}><button type="button" disabled={index === crumbs.length - 1} onClick={() => { void browse(selected, crumb.path) }}>{crumb.label}</button>{index < crumbs.length - 1 && <VscChevronRight />}</span>)}</nav>
        <IconButton label="Refresh files" disabled={fileBusy} onClick={() => { void browse(selected) }}><VscRefresh /></IconButton>
        <IconButton label="Upload file" disabled={fileBusy} onClick={() => { uploadInput.current?.click() }}><VscCloudUpload /></IconButton>
        <input ref={uploadInput} className={css.hiddenInput} type="file" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void upload(selected, file) }} />
      </div>
      <div className={css.pathEditor}><span>Path</span><input aria-label="Remote path" value={filePath} onChange={event => { setFilePath(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void browse(selected) }} /><button type="button" disabled={fileBusy} onClick={() => { void browse(selected) }}>Go</button></div>
      <div className={css.tableScroll}>
        <table className={css.fileTable}>
          <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th><span className={css.srOnly}>Actions</span></th></tr></thead>
          <tbody>{files?.entries.map(entry => <tr key={entry.path}>
            <td><button type="button" className={css.fileName} disabled={entry.type !== 'directory'} onClick={() => { if (entry.type === 'directory') void browse(selected, entry.path) }}>{entry.type === 'directory' ? <VscFolder /> : <VscFile />}<span>{entry.name}</span></button></td>
            <td>{entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)}</td>
            <td><time>{new Date(entry.modifiedAt).toLocaleString()}</time></td>
            <td>{entry.type === 'file' && <IconButton label={'Download ' + entry.name} disabled={fileBusy} onClick={() => { void download(selected, entry.path) }}><VscCloudDownload /></IconButton>}</td>
          </tr>)}</tbody>
        </table>
        {files === null && <div className={css.emptySmall}>{fileBusy ? 'Loading files' : 'Open a remote path'}</div>}
        {files !== null && files.entries.length === 0 && <div className={css.emptySmall}>Directory is empty</div>}
      </div>
    </div>}
  </section>

  const renderTunnels = () => <section className={css.workView} aria-label="SSH tunnels">
    {renderHostHeader('Tunnels')}
    {selected === null || forwardForm === null ? <div className={css.empty}><VscPlug /><strong>Select a host</strong><span>Port forwards are scoped to the selected connection.</span></div> : <div className={css.tunnelWorkbench}>
      <section className={css.forwardComposer} aria-label="New tunnel">
        <header><strong>New tunnel</strong><span>Forward TCP traffic through {selected.name}</span></header>
        <div className={css.forwardForm}>
          <label>Direction<Select label="Tunnel direction" value={forwardForm.direction} options={DIRECTION_OPTIONS} onChange={value => { setForwardForm({ ...forwardForm, direction: value as SshPortForwardRequest['direction'] }) }} /></label>
          <label>Bind host<input value={forwardForm.bindHost} onChange={event => { setForwardForm({ ...forwardForm, bindHost: event.target.value }) }} /></label>
          <label>Bind port<input type="number" min={0} max={65535} value={forwardForm.bindPort} onChange={event => { setForwardForm({ ...forwardForm, bindPort: Number(event.target.value) }) }} /></label>
          <span className={css.forwardArrow}>to</span>
          <label>Target host<input value={forwardForm.targetHost} onChange={event => { setForwardForm({ ...forwardForm, targetHost: event.target.value }) }} /></label>
          <label>Target port<input type="number" min={1} max={65535} value={forwardForm.targetPort} onChange={event => { setForwardForm({ ...forwardForm, targetPort: Number(event.target.value) }) }} /></label>
          <button type="button" className={css.primary} title="Open port forward" onClick={() => { void openForward() }}><VscAdd />Open</button>
        </div>
      </section>
      <div className={css.tableScroll}>
        <table className={css.tunnelTable}>
          <thead><tr><th>Direction</th><th>Listen address</th><th>Target</th><th>Status</th><th><span className={css.srOnly}>Actions</span></th></tr></thead>
          <tbody>{hostForwards.map(forward => <tr key={forward.id}>
            <td><span className={css.direction}><VscPlug />{forward.direction === 'local' ? 'Local' : 'Remote'}</span></td>
            <td>{forward.bindHost}:{forward.bindPort}</td>
            <td>{forward.targetHost}:{forward.targetPort}</td>
            <td><span className={css.forwardState} data-state={forward.state}><i />{forward.state}</span>{forward.error !== undefined && <small className={css.danger}>{forward.error}</small>}</td>
            <td><div className={css.rowActions}>{forward.state !== 'active' && <IconButton label="Reconnect tunnel" onClick={() => { void reconnectForward(forward.id) }}><VscRefresh /></IconButton>}<IconButton label="Close tunnel" onClick={() => { void closeForward(forward.id) }}><VscDebugDisconnect /></IconButton></div></td>
          </tr>)}</tbody>
        </table>
        {hostForwards.length === 0 && <div className={css.emptySmall}>No active tunnels for this host</div>}
      </div>
    </div>}
  </section>

  return <div className={css.root} data-dsh-ssh-manager>
    <header className={css.toolbar}>
      <div className={css.brand}><VscRemoteExplorer size={18} /><strong>SSH Manager</strong></div>
      <nav className={css.viewSwitch} aria-label="SSH workspace view">{VIEW_ITEMS.map(item => {
        const Icon = item.icon
        return <button type="button" key={item.id} data-active={view === item.id} aria-pressed={view === item.id} onClick={() => { chooseView(item.id) }}><Icon /><span>{item.label}</span>{item.id === 'terminal' && terminals.length > 0 && <small>{terminals.length}</small>}</button>
      })}</nav>
      <div className={css.globalActions}>
        <IconButton label={inventoryOpen ? 'Hide host explorer' : 'Show host explorer'} aria-pressed={inventoryOpen} onClick={() => { setInventoryOpen(current => !current) }}><VscLayoutSidebarLeft /></IconButton>
        <IconButton label="Add cluster" onClick={() => { setClusterForm({ id: '', name: '', description: '', tags: [], hostIds: [] }) }}><VscFolder /></IconButton>
        <IconButton label="Add host" onClick={() => { setHostForm(emptyHost()); setCredential({}) }}><VscAdd /></IconButton>
      </div>
    </header>
    {error !== null && <div className={css.error} role="alert"><VscInfo />{error}<IconButton label="Dismiss error" onClick={() => { setError(null) }}><VscClose /></IconButton></div>}
    <div className={css.workspace} data-inventory={inventoryOpen} data-overlay={view !== 'hosts'}>
      {inventoryOpen && renderInventory()}
      <main className={css.mainWorkspace}>{view === 'hosts' ? renderOverview() : view === 'terminal' ? renderTerminal() : view === 'files' ? renderFiles() : renderTunnels()}</main>
    </div>

    {hostForm !== null && <div className={css.backdrop}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label="SSH host">
        <header><div><strong>{hostForm.id === '' ? 'Add host' : 'Edit host'}</strong><span>Connection secrets are stored in central credentials.</span></div><IconButton label="Close" onClick={() => { setHostForm(null); setCredential({}) }}><VscClose /></IconButton></header>
        <div className={css.form}>
          <label>Name<input autoFocus value={hostForm.name} onChange={event => { setHostForm({ ...hostForm, name: event.target.value }) }} /></label>
          <label>Hostname<input value={hostForm.hostname} onChange={event => { setHostForm({ ...hostForm, hostname: event.target.value }) }} /></label>
          <label>Port<input type="number" min={1} max={65535} value={hostForm.port} onChange={event => { setHostForm({ ...hostForm, port: Number(event.target.value) }) }} /></label>
          <label>User<input value={hostForm.username} onChange={event => { setHostForm({ ...hostForm, username: event.target.value }) }} /></label>
          <label>Environment<Select label="Environment" value={hostForm.environment} options={ENVIRONMENT_OPTIONS} onChange={value => { setHostForm({ ...hostForm, environment: value as SshEnvironment }) }} /></label>
          <label>Cluster<Select label="Cluster" value={hostForm.clusterId ?? ''} options={clusterOptions} onChange={value => { setHostForm({ ...hostForm, clusterId: value || null }) }} /></label>
          <label>Authentication<Select label="Authentication" value={hostForm.authKind} options={AUTH_OPTIONS} onChange={value => { setHostForm({ ...hostForm, authKind: value as SshHost['authKind'] }); setCredential({}) }} /></label>
          {hostForm.authKind === 'password' && <label>Password<input type="password" value={credential.password ?? ''} onChange={event => { setCredential({ password: event.target.value }) }} placeholder={hostForm.credentialConfigured ? 'Leave blank to keep current' : ''} /></label>}
          {hostForm.authKind === 'private-key' && <><label className={css.full}>Private key<textarea value={credential.privateKey ?? ''} onChange={event => { setCredential({ ...credential, privateKey: event.target.value }) }} placeholder={hostForm.credentialConfigured ? 'Leave blank to keep current' : 'OpenSSH private key'} /></label><label>Passphrase<input type="password" value={credential.passphrase ?? ''} onChange={event => { setCredential({ ...credential, passphrase: event.target.value }) }} /></label></>}
          <label>Jump host<Select label="Jump host" value={hostForm.jumpHostId ?? ''} options={jumpHostOptions} onChange={value => { setHostForm({ ...hostForm, jumpHostId: value || null }) }} /></label>
          <label>Keepalive seconds<input type="number" min={0} value={hostForm.keepAliveSeconds} onChange={event => { setHostForm({ ...hostForm, keepAliveSeconds: Number(event.target.value) }) }} /></label>
          <label className={css.full}>Known-host fingerprint<input value={hostForm.knownHostFingerprint ?? ''} onChange={event => { setHostForm({ ...hostForm, knownHostFingerprint: event.target.value || null }) }} placeholder="SHA256:..." /></label>
          <label className={css.full}>Tags<input value={hostForm.tags.join(', ')} onChange={event => { setHostForm({ ...hostForm, tags: event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) }) }} placeholder="web, production" /></label>
          <label className={css.full}>Description<textarea value={hostForm.description} onChange={event => { setHostForm({ ...hostForm, description: event.target.value }) }} /></label>
        </div>
        <footer><button type="button" onClick={() => { setHostForm(null); setCredential({}) }}>Cancel</button><button type="button" className={css.primary} disabled={hostForm.name.trim() === '' || hostForm.hostname.trim() === '' || hostForm.username.trim() === ''} onClick={() => { void saveHost() }}>Save host</button></footer>
      </div>
    </div>}

    {clusterForm !== null && <div className={css.backdrop}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label="SSH cluster">
        <header><div><strong>Add cluster</strong><span>Group related hosts in the explorer.</span></div><IconButton label="Close" onClick={() => { setClusterForm(null) }}><VscClose /></IconButton></header>
        <div className={css.form}><label className={css.full}>Name<input autoFocus value={clusterForm.name} onChange={event => { setClusterForm({ ...clusterForm, name: event.target.value }) }} /></label><label className={css.full}>Description<textarea value={clusterForm.description} onChange={event => { setClusterForm({ ...clusterForm, description: event.target.value }) }} /></label></div>
        <footer><button type="button" onClick={() => { setClusterForm(null) }}>Cancel</button><button type="button" className={css.primary} disabled={clusterForm.name.trim() === ''} onClick={() => { void saveCluster() }}>Save cluster</button></footer>
      </div>
    </div>}
  </div>
}
