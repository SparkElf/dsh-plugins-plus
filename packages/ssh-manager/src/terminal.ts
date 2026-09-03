import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import { SshManagerStore } from './store.ts'
import { openSshConnection, type SshConnection } from './transport.ts'
import type { SshTerminalSession } from './types.ts'

const TRANSCRIPT_LIMIT = 1 << 20
const TERMINALS_PER_SESSION = 10
export type SshTerminalEvent = { type: 'snapshot'; value: SshTerminalSession } | { type: 'data'; data: string } | { type: 'exit'; exitCode: number | null; signal: string | null }
interface Handle { sessionId: string; snapshot: SshTerminalSession; connection: SshConnection; channel: ClientChannel; transcript: string; listeners: Set<(event: SshTerminalEvent) => void> }

function clampDimension(value: number): number { return Math.min(500, Math.max(2, Math.trunc(value))) }
function appendTranscript(current: string, chunk: string): string { const combined = current + chunk; const bytes = Buffer.byteLength(combined); if (bytes <= TRANSCRIPT_LIMIT) return combined; return Buffer.from(combined).subarray(bytes - TRANSCRIPT_LIMIT).toString('utf8') }
function snapshot(handle: Handle): SshTerminalSession { return { ...handle.snapshot } }

export class SshTerminalManager {
  private readonly handles = new Map<string, Handle>()
  constructor(private readonly store: SshManagerStore) {}

  async open(sessionId: string, hostId: string, cols = 80, rows = 24): Promise<SshTerminalSession> {
    if ([...this.handles.values()].filter(handle => handle.sessionId === sessionId && !handle.snapshot.exited).length >= TERMINALS_PER_SESSION) throw new Error('SSH terminal limit reached for this session')
    const connection = await openSshConnection(this.store, hostId)
    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => { connection.client.shell({ term: 'xterm-256color', cols: clampDimension(cols), rows: clampDimension(rows) }, (error, stream) => { if (error !== undefined) reject(error); else resolve(stream) }) })
      const id = randomUUID()
      const handle: Handle = { sessionId, snapshot: { id, hostId, title: connection.host.name, cwd: null, connectedAt: Date.now(), state: 'connected', exited: false }, connection, channel, transcript: '', listeners: new Set() }
      this.handles.set(id, handle)
      const publishData = (data: Buffer): void => { const text = data.toString('utf8'); handle.transcript = appendTranscript(handle.transcript, text); for (const listener of handle.listeners) listener({ type: 'data', data: text }) }
      channel.on('data', publishData)
      channel.stderr.on('data', publishData)
      channel.once('close', (exitCode: number | null, exitSignal: string | null) => { handle.snapshot = { ...handle.snapshot, state: 'disconnected', exited: true, exitCode, signal: exitSignal }; for (const listener of handle.listeners) { listener({ type: 'exit', exitCode, signal: exitSignal }); listener({ type: 'snapshot', value: snapshot(handle) }) } connection.close() })
      channel.once('error', () => { handle.snapshot = { ...handle.snapshot, state: 'failed', exited: true }; for (const listener of handle.listeners) listener({ type: 'snapshot', value: snapshot(handle) }); connection.close() })
      return snapshot(handle)
    } catch (error) { connection.close(); throw error }
  }

  list(sessionId: string): SshTerminalSession[] { return [...this.handles.values()].filter(handle => handle.sessionId === sessionId).map(snapshot) }
  private owned(sessionId: string, terminalId: string): Handle { const handle = this.handles.get(terminalId); if (handle === undefined || handle.sessionId !== sessionId) throw new Error('SSH terminal not found: ' + terminalId); return handle }
  attach(sessionId: string, terminalId: string, listener: (event: SshTerminalEvent) => void): () => void { const handle = this.owned(sessionId, terminalId); listener({ type: 'snapshot', value: snapshot(handle) }); if (handle.transcript !== '') listener({ type: 'data', data: handle.transcript }); handle.listeners.add(listener); return () => { handle.listeners.delete(listener) } }
  write(sessionId: string, terminalId: string, data: string): void { if (data.length > 65_536) throw new Error('SSH terminal input exceeds 65536 characters'); const handle = this.owned(sessionId, terminalId); if (handle.snapshot.exited) throw new Error('SSH terminal has exited'); handle.channel.write(data) }
  resize(sessionId: string, terminalId: string, cols: number, rows: number): void { const handle = this.owned(sessionId, terminalId); if (handle.snapshot.exited) return; handle.channel.setWindow(clampDimension(rows), clampDimension(cols), 0, 0) }
  close(sessionId: string, terminalId: string): void { const handle = this.owned(sessionId, terminalId); this.handles.delete(terminalId); handle.channel.close(); handle.connection.close(); handle.listeners.clear() }
  closeAll(): void { for (const handle of this.handles.values()) { handle.channel.close(); handle.connection.close(); handle.listeners.clear() } this.handles.clear() }
}
