/**
 * Sandboxed cockpit viewer.
 *
 * The iframe is served by the plugin's render route and runs with
 * `sandbox="allow-scripts allow-same-origin"` (opaque origin). The workspace token reaches it only
 * through postMessage, and only after this parent verified the message source.
 *
 * @module client/CockpitViewer
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'

/** Addresses resolved from the host config route. */
interface ViewerConfig {
  renderBaseUrl: string
  gatewayBaseUrl: string
  dataopsWebBaseUrl: string
}

/** Message the runtime posts to its parent. */
interface RuntimeMessage {
  source?: string
  type?: string
  resourceRef?: string
}

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  // 宿主侧栏的 tab 容器不一定是可伸展的 flex 父级，只写 height:100% 会被压到 ~140px
  // （实测 clientHeight=142，画布被裁成一条）。给一个下限，让驾驶舱在任何容器里都能看。
  minHeight: '520px',
  border: '0',
  display: 'block',
  background: '#060a14',
}

/**
 * Render one cockpit in a sandboxed iframe and keep its bootstrap config fed.
 * @param props.artifactId - cockpit (or preview draft) id.
 * @param props.refreshKey - changing it reloads the iframe, used by "updated" events.
 * @param props.reloadToken - bump from outside to force a reload.
 */
export function CockpitViewer({ artifactId, reloadToken }: { artifactId: string; reloadToken?: number }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /** iframe 加载完成后重发一次引导配置：`hello` 可能在监听器挂上之前就发出去了。 */
  const resendRef = useRef<(() => void) | null>(null)
  const [config, setConfig] = useState<ViewerConfig | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [configResponse, tokenResponse] = await Promise.all([
          fetch('/dsh-artifact-app/config', { headers: { accept: 'application/json' } }),
          fetch('/dsh-artifact-app/token', { headers: { accept: 'application/json' } }),
        ])
        const configPayload = await configResponse.json() as ViewerConfig & { error?: string }
        const tokenPayload = await tokenResponse.json() as { token?: string; error?: string }
        if (!configResponse.ok) throw new Error(configPayload.error ?? '读取驾驶舱配置失败')
        if (!tokenResponse.ok || typeof tokenPayload.token !== 'string') throw new Error(tokenPayload.error ?? '读取 DataOps 登录凭证失败')
        if (alive) {
          setConfig(configPayload)
          setToken(tokenPayload.token)
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (config === null || token === null) return undefined
    /** 把引导配置推给 iframe；`hello` 与 iframe 的 load 事件都会触发它。 */
    const sendConfig = (): void => {
      frameRef.current?.contentWindow?.postMessage({
        source: 'dataops-artifact-host',
        type: 'config',
        payload: {
          artifactId,
          token,
          gatewayBaseUrl: config.gatewayBaseUrl,
          refreshIntervalSeconds: 300,
          keepConnection: false,
          locale: 'zh-CN',
          theme: 'dark',
        },
      }, '*')
    }
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const data = event.data as RuntimeMessage | null
      if (data === null || typeof data !== 'object' || data.source !== 'dataops-artifact-app') return
      if (data.type === 'request-access') {
        const target = config.dataopsWebBaseUrl.replace(/\/+$/u, '')
        window.open(target, '_blank', 'noopener,noreferrer')
        return
      }
      if (data.type !== 'hello' && data.type !== 'ready' && data.type !== 'token:expired') return
      sendConfig()
    }
    resendRef.current = sendConfig
    window.addEventListener('message', onMessage)
    return () => { resendRef.current = null; window.removeEventListener('message', onMessage) }
  }, [artifactId, config, token])

  if (error !== null) {
    return <div role="alert" style={{ padding: 18, color: '#b91c1c', fontSize: 12 }}>{error}</div>
  }
  if (config === null || token === null) {
    return <div style={{ padding: 18, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 12 }}>正在准备驾驶舱…</div>
  }
  const src = config.renderBaseUrl.replace(/\/+$/u, '') + '/' + encodeURIComponent(artifactId) + (reloadToken === undefined ? '' : '?r=' + String(reloadToken))
  return (
    <iframe
      ref={frameRef}
      title="驾驶舱"
      src={src}
      sandbox="allow-scripts allow-same-origin"
      allow="fullscreen"
      onLoad={() => resendRef.current?.()}
      style={frameStyle}
      data-artifact-viewer={artifactId}
    />
  )
}