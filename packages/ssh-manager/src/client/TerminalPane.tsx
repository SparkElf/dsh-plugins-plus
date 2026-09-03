import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SshTerminalSession } from '../types.ts'
import css from './SshManager.module.css'

export function TerminalPane({ sessionId, terminal, onSnapshot }: { sessionId: string; terminal: SshTerminalSession; onSnapshot(value: SshTerminalSession): void }) {
  const host = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const styles = getComputedStyle(element)
    const background = styles.getPropertyValue('--dsw-alias-bg-base').trim() || '#18181b'
    const foreground = styles.getPropertyValue('--dsw-alias-label-primary').trim() || '#e4e4e7'
    const cursor = styles.getPropertyValue('--dsw-alias-state-business-primary').trim() || '#60a5fa'
    const selectionBackground = styles.getPropertyValue('--dsw-alias-state-business-tertiary').trim() || '#334155'
    const instance = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, scrollback: 5000, theme: { background, foreground, cursor, selectionBackground } })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(element)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(protocol + '//' + location.host + '/dsh-ssh-manager/terminal?sessionId=' + encodeURIComponent(sessionId) + '&terminalId=' + encodeURIComponent(terminal.id))
    const sendResize = (): void => { try { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: instance.cols, rows: instance.rows })) } catch {} }
    socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)) as { type: string; data?: string; value?: SshTerminalSession; exitCode?: number | null; signal?: string | null; message?: string }; if (message.type === 'data') instance.write(message.data ?? ''); else if (message.type === 'snapshot' && message.value !== undefined) onSnapshot(message.value); else if (message.type === 'exit') instance.writeln('\r\n[remote shell exited: ' + String(message.exitCode) + (message.signal ? ' · ' + message.signal : '') + ']'); else if (message.type === 'error') instance.writeln('\r\n[terminal error: ' + String(message.message) + ']') })
    socket.addEventListener('open', sendResize)
    socket.addEventListener('close', () => { if (!terminal.exited) instance.writeln('\r\n[terminal detached]') })
    const input = instance.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })) })
    const observer = new ResizeObserver(sendResize)
    observer.observe(element)
    requestAnimationFrame(sendResize)
    return () => { observer.disconnect(); input.dispose(); socket.close(); instance.dispose() }
  }, [sessionId, terminal.id])
  return <div ref={host} className={css.terminalHost} data-ssh-terminal={terminal.id} />
}
