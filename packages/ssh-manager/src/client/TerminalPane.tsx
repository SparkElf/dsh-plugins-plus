import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SshTerminalSession } from '../types.ts'
import css from './SshManager.module.css'

interface TerminalPaneProps {
  sessionId: string
  terminal: SshTerminalSession
  active: boolean
  onSnapshot(value: SshTerminalSession): void
}

export function TerminalPane({ sessionId, terminal, active, onSnapshot }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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
    instanceRef.current = instance
    fitRef.current = fit
    instance.loadAddon(fit)
    instance.open(element)

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(protocol + '//' + location.host + '/dsh-ssh-manager/terminal?sessionId=' + encodeURIComponent(sessionId) + '&terminalId=' + encodeURIComponent(terminal.id))
    const sendResize = (): void => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return
      try {
        fit.fit()
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: instance.cols, rows: instance.rows }))
      } catch {}
    }
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string; value?: SshTerminalSession; exitCode?: number | null; signal?: string | null; message?: string }
      if (message.type === 'data') instance.write(message.data ?? '')
      else if (message.type === 'snapshot' && message.value !== undefined) onSnapshot(message.value)
      else if (message.type === 'exit') instance.writeln('\r\n[remote shell exited: ' + String(message.exitCode) + (message.signal ? ' · ' + message.signal : '') + ']')
      else if (message.type === 'error') instance.writeln('\r\n[terminal error: ' + String(message.message) + ']')
    })
    socket.addEventListener('open', sendResize)
    socket.addEventListener('close', () => { if (!terminal.exited) instance.writeln('\r\n[terminal detached]') })
    const input = instance.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })) })
    const observer = new ResizeObserver(sendResize)
    observer.observe(element)
    requestAnimationFrame(() => { sendResize(); if (active) instance.focus() })
    return () => {
      observer.disconnect()
      input.dispose()
      socket.close()
      instance.dispose()
      instanceRef.current = null
      fitRef.current = null
    }
  }, [sessionId, terminal.id])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try { fitRef.current?.fit() } catch {}
      instanceRef.current?.focus()
    })
  }, [active])

  return <div ref={host} className={css.terminalHost} data-active={active} data-ssh-terminal={terminal.id} aria-hidden={!active} />
}
