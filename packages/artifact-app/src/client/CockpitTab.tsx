/**
 * The `dataops-artifact-apps` right-sidebar tab.
 *
 * One pane holds the cockpit list and, once a card is opened, the sandboxed
 * viewer. The list is proxied by the host so the browser holds no DataOps token
 * for reads.
 *
 * @module client/CockpitTab
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { CockpitViewer } from './CockpitViewer.tsx'

/** Minimal tab record Better Sidebar passes. */
interface TabRecord {
  meta?: unknown
  title?: string
}

/** Props this tab consumes. */
export interface CockpitTabProps {
  tab: TabRecord
  scope?: { sessionId?: string }
  visible?: boolean
}

interface AppRow {
  id: string
  name: string
  description?: string | null
  catalog?: string | null
  status: string
  currentVersion: number
  publishedVersion: number
  updatedAt: string
}

const readMeta = (value: unknown): { cockpitId?: string; cockpitName?: string; nonce?: string } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    cockpitId: typeof record.cockpitId === 'string' ? record.cockpitId : undefined,
    cockpitName: typeof record.cockpitName === 'string' ? record.cockpitName : undefined,
    nonce: typeof record.nonce === 'string' ? record.nonce : undefined,
  }
}

const cardStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  width: '100%',
  minWidth: 0,
  textAlign: 'left',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  color: 'inherit',
  cursor: 'pointer',
}

const muted: CSSProperties = { fontSize: 10, color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/** Cockpit list plus viewer. */
export function CockpitTab({ tab }: CockpitTabProps) {
  const meta = readMeta(tab.meta)
  const [apps, setApps] = useState<AppRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    meta.cockpitId === undefined ? null : { id: meta.cockpitId, name: meta.cockpitName ?? '驾驶舱' },
  )
  const [reloadToken, setReloadToken] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/dsh-artifact-app/apps?pageSize=50', { headers: { accept: 'application/json' } })
      const payload = await response.json() as { items?: AppRow[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'HTTP ' + String(response.status))
      setApps(payload.items ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (meta.cockpitId === undefined) return
    setSelected({ id: meta.cockpitId, name: meta.cockpitName ?? '驾驶舱' })
    setReloadToken((value) => value + 1)
  }, [meta.cockpitId, meta.cockpitName, meta.nonce])

  const catalogs = useMemo(() => [...new Set(apps.map((app) => app.catalog).filter((value): value is string => typeof value === 'string' && value !== ''))], [apps])

  /**
   * 导出一份可脱离 DSH 单独分发的 HTML：服务端返回的 HTML 已烧死 appId 与网关地址，
   * 这里再把运行时与 ECharts 内联进去，产物双击即可打开（地址栏加 #token=… 取数）。
   */
  const [exporting, setExporting] = useState(false)
  const exportHtml = async (): Promise<void> => {
    if (selected === null || exporting) return
    setExporting(true)
    try {
      const base = '/dsh-artifact-app/gateway/api/artifact-apps'
      const [htmlResponse, runtimeResponse, echartsResponse] = await Promise.all([
        fetch(base.replace(/\/+$/u, '') + '/' + encodeURIComponent(selected.id) + '/html', { headers: { accept: 'application/json' } }),
        fetch(base.replace(/\/+$/u, '') + '/runtime.js'),
        fetch(base.replace(/\/+$/u, '') + '/echarts.js'),
      ])
      if (!htmlResponse.ok) throw new Error('读取驾驶舱 HTML 失败')
      const payload = await htmlResponse.json() as { html?: string }
      const runtime = runtimeResponse.ok ? await runtimeResponse.text() : ''
      const echarts = echartsResponse.ok ? await echartsResponse.text() : ''
      const inline = (runtime === '' ? '' : '<script>' + runtime + '<\/script>') + (echarts === '' ? '' : '<script>' + echarts + '<\/script>')
      const html = (payload.html ?? '').replace('</body>', inline + '</body>')
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = (selected.name || 'cockpit') + '.html'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  if (selected !== null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' }}>
          <button type="button" onClick={() => setSelected(null)} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: 0 }}>← 列表</button>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name}</div>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            onClick={() => setReloadToken((value) => value + 1)}
            style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 6 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 4v5h-5" />
            </svg>
          </button>
          <button
            type="button"
            title="全屏查看"
            aria-label="全屏查看"
            onClick={() => {
              const host = document.querySelector('[data-artifact-fullscreen-host]') as HTMLElement | null
              const target = host ?? document.querySelector('iframe[data-artifact-viewer]')?.parentElement ?? null
              if (target === null) return
              if (document.fullscreenElement !== null) void document.exitFullscreen()
              else void target.requestFullscreen?.().catch(() => undefined)
            }}
            style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 6 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" />
            </svg>
          </button>
          <button
            type="button"
            title="导出 HTML"
            aria-label="导出 HTML"
            disabled={exporting}
            onClick={() => void exportHtml()}
            style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: exporting ? 'progress' : 'pointer', display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 6, opacity: exporting ? 0.5 : 1 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M4 21h16" />
            </svg>
          </button>
        </div>
        <div data-artifact-fullscreen-host style={{ flex: 1, minHeight: 0 }}>
          <CockpitViewer artifactId={selected.id} reloadToken={reloadToken} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>驾驶舱</div>
          <div style={muted}>DataOps 驾驶舱资产 · {apps.length} 个{catalogs.length > 0 ? ' · ' + catalogs.join(' / ') : ''}</div>
        </div>
        <button type="button" onClick={() => void load()} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }}>刷新</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'grid', gap: 8, alignContent: 'start' }}>
        {loading ? <div style={{ ...muted, textAlign: 'center', padding: 18 }}>正在加载驾驶舱…</div> : null}
        {error !== null ? <div role="alert" style={{ padding: '8px 10px', borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontSize: 11 }}>{error}</div> : null}
        {!loading && error === null && apps.length === 0 ? <div style={{ ...muted, textAlign: 'center', padding: 18 }}>暂无驾驶舱</div> : null}
        {apps.map((app) => (
          <button
            key={app.id}
            type="button"
            style={cardStyle}
            onClick={() => setSelected({ id: app.id, name: app.name })}
            data-cockpit-id={app.id}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
              <span style={{ ...muted, flex: 'none' }}>{app.status === 'PUBLISHED' ? '已发布' : '草稿'}</span>
            </span>
            {app.description ? <span style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.description}</span> : null}
            <span style={muted}>{app.catalog ?? '未分类'} · v{app.publishedVersion || app.currentVersion}</span>
          </button>
        ))}
      </div>
    </div>
  )
}