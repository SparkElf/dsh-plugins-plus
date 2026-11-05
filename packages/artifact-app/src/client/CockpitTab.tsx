/**
 * The `dataops-artifact-apps` right-sidebar tab.
 *
 * One pane holds the cockpit catalogue (published apps plus cockpit templates) and, once a card
 * is opened, the sandboxed viewer. Both lists are proxied by the host so the browser holds no
 * DataOps token for reads.
 *
 * @module client/CockpitTab
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CockpitViewer } from './CockpitViewer.tsx'

/** Minimal tab record Better Sidebar passes. */
interface TabRecord {
  meta?: unknown
  title?: string
}

/** What a card can hand back to the composer when "添加到对话" is pressed. */
export interface CockpitReferenceInput {
  kind: 'app' | 'template'
  id: string
  name: string
  catalog?: string | null
}

/** Props this tab consumes. */
export interface CockpitTabProps {
  tab: TabRecord
  scope?: { sessionId?: string }
  visible?: boolean
  /** Insert a cockpit/template reference into the active composer. */
  insertArtifactReference?: (item: CockpitReferenceInput, sessionId?: string) => void
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

interface TemplateRow {
  id: string
  name: string
  description?: string | null
  catalog?: string | null
  status?: string
  currentVersion?: number
  contract?: { slots?: string[]; question?: string } | null
  updatedAt?: string
}

interface SelectedCockpit {
  kind: 'app' | 'template'
  /** Address the render route understands: `<appId>` or `template/<templateId>`. */
  viewerId: string
  name: string
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

const readItems = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[]
  if (typeof payload === 'object' && payload !== null && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: T[] }).items
  }
  return []
}

const versionLabel = (row: { currentVersion?: number; publishedVersion?: number }): string => {
  const version = row.publishedVersion || row.currentVersion || 1
  return 'v' + String(version)
}

/**
 * All styling is local to the tab and consumes the host's `--dsw-*` tokens, so the panel follows
 * both light and dark themes without a second palette.
 */
const CSS = `
.dsh-ac {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base, #151517);
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.dsh-ac__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #151517) 92%, transparent);
  backdrop-filter: blur(10px);
}
.dsh-ac__glyph {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--dsw-alias-state-business-primary, #7aaaff);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 14%, transparent);
  flex: none;
}
.dsh-ac__heading { flex: 1; min-width: 0; }
.dsh-ac__name {
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-ac__sub {
  margin-top: 1px;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-caption, #81858c);
  font-variant-numeric: tabular-nums;
}
.dsh-ac__icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #cfd3d6);
  cursor: pointer;
  flex: none;
}
.dsh-ac__icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); color: var(--dsw-alias-label-primary, #f9fafb); }
.dsh-ac__icon:focus-visible, .dsh-ac__btn:focus-visible, .dsh-ac__card:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #7aaaff));
  outline-offset: 1px;
}
.dsh-ac__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-ac__section { display: flex; flex-direction: column; gap: 6px; }
.dsh-ac__section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 1px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #cfd3d6);
}
.dsh-ac__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, #353638);
  color: var(--dsw-alias-label-caption, #81858c);
  font-size: 10px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.dsh-ac__list { display: flex; flex-direction: column; gap: 6px; }
.dsh-ac__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
  color: inherit;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}
.dsh-ac__card:hover {
  border-color: var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #2c2c2e) 82%, var(--dsw-alias-bg-layer-3, #353638));
  transform: translateY(-1px);
}
.dsh-ac__card-top { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dsh-ac__badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .01em;
  flex: none;
}
.dsh-ac__badge.is-app {
  color: var(--dsw-alias-state-business-primary, #7aaaff);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 15%, transparent);
}
.dsh-ac__badge.is-template {
  /* 模板用「蓝 × 红」两个既有 token 混出紫色，不引入新的硬编码色值。 */
  color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 55%, var(--dsw-alias-state-error-secondary, #f25a5a));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 12%, var(--dsw-alias-state-error-secondary, #f25a5a) 10%, transparent);
}
.dsh-ac__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 10px;
  color: var(--dsw-alias-label-caption, #81858c);
  flex: none;
}
.dsh-ac__status::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.dsh-ac__status.is-published { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-ac__status.is-draft { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-ac__card-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 17px;
  color: var(--dsw-alias-label-primary, #f9fafb);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ac__card-desc {
  margin: 0;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-secondary, #cfd3d6);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dsh-ac__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--dsw-alias-label-caption, #81858c);
  font-variant-numeric: tabular-nums;
}
.dsh-ac__meta .dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .7; }
.dsh-ac__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.dsh-ac__btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #f9fafb);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dsh-ac__btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-ac__btn.is-primary {
  border-color: var(--dsw-alias-state-business-primary, #7aaaff);
  background: var(--dsw-alias-state-business-primary, #7aaaff);
  color: var(--dsw-alias-label-primary-foreground, #0f1115);
}
.dsh-ac__btn.is-primary:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 86%, white); }
.dsh-ac__btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-ac__state {
  padding: 22px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--dsw-alias-label-caption, #81858c);
}
.dsh-ac__error {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 9%, transparent);
  color: var(--dsw-alias-state-error-primary, #f25a5a);
  font-size: 10px;
  line-height: 15px;
}
.dsh-ac__toast {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  z-index: 5;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-3, #353638);
  color: var(--dsw-alias-label-primary, #f9fafb);
  font-size: 10px;
  text-align: center;
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
  pointer-events: none;
}
.dsh-ac-viewer { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dsh-ac-viewer__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
}
.dsh-ac-viewer__back {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #cfd3d6);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 5px;
}
.dsh-ac-viewer__back:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); color: var(--dsw-alias-label-primary, #f9fafb); }
.dsh-ac-viewer__title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

/** Cockpit catalogue plus viewer. */
export function CockpitTab({ tab, scope, insertArtifactReference }: CockpitTabProps) {
  const meta = readMeta(tab.meta)
  const [apps, setApps] = useState<AppRow[]>([])
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<SelectedCockpit | null>(
    meta.cockpitId === undefined
      ? null
      : { kind: 'app', viewerId: meta.cockpitId, name: meta.cockpitName ?? '驾驶舱' },
  )
  const [reloadToken, setReloadToken] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setTemplateError(null)
    const [appsResult, templatesResult] = await Promise.allSettled([
      fetch('/dsh-artifact-app/apps?pageSize=50', { headers: { accept: 'application/json' } })
        .then(async (response) => {
          const payload = await response.json() as { items?: AppRow[]; error?: string }
          if (!response.ok) throw new Error(payload.error ?? 'HTTP ' + String(response.status))
          return payload.items ?? []
        }),
      fetch('/dsh-artifact-app/templates', { headers: { accept: 'application/json' } })
        .then(async (response) => {
          const payload = await response.json() as { items?: TemplateRow[]; error?: string }
          if (!response.ok) throw new Error(payload.error ?? 'HTTP ' + String(response.status))
          return readItems<TemplateRow>(payload)
        }),
    ])
    if (appsResult.status === 'fulfilled') setApps(appsResult.value)
    else setError(appsResult.reason instanceof Error ? appsResult.reason.message : String(appsResult.reason))
    if (templatesResult.status === 'fulfilled') setTemplates(templatesResult.value)
    else setTemplateError(templatesResult.reason instanceof Error ? templatesResult.reason.message : String(templatesResult.reason))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (meta.cockpitId === undefined) return
    setSelected({ kind: 'app', viewerId: meta.cockpitId, name: meta.cockpitName ?? '驾驶舱' })
    setReloadToken((value) => value + 1)
  }, [meta.cockpitId, meta.cockpitName, meta.nonce])

  useEffect(() => {
    if (notice === '') return undefined
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  const catalogs = useMemo(
    () => [...new Set([
      ...apps.map((app) => app.catalog),
      ...templates.map((template) => template.catalog),
    ].filter((value): value is string => typeof value === 'string' && value !== ''))],
    [apps, templates],
  )

  const openApp = (app: AppRow): void => setSelected({ kind: 'app', viewerId: app.id, name: app.name })
  const openTemplate = (template: TemplateRow): void => setSelected({
    kind: 'template',
    viewerId: 'template/' + template.id,
    name: template.name,
  })

  const addToConversation = (item: CockpitReferenceInput): void => {
    if (insertArtifactReference === undefined) {
      setNotice('当前会话不可用，无法插入引用')
      return
    }
    try {
      insertArtifactReference(item, scope?.sessionId)
      setNotice('已添加到对话')
    } catch (cause) {
      setNotice('插入引用失败：' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }

  /**
   * 导出一份可脱离 DSH 单独分发的 HTML：服务端返回的 HTML 已烧死 appId 与网关地址，
   * 这里再把运行时与 ECharts 内联进去，产物双击即可打开（地址栏加 #token=… 取数）。
   * 模板不是应用，没有网关导出地址，因此只在应用视图里提供。
   */
  const [exporting, setExporting] = useState(false)
  const exportHtml = async (): Promise<void> => {
    if (selected === null || selected.kind !== 'app' || exporting) return
    setExporting(true)
    try {
      const base = '/dsh-artifact-app/gateway/api/artifact-apps'
      const [htmlResponse, runtimeResponse, echartsResponse] = await Promise.all([
        fetch(base.replace(/\/+$/u, '') + '/' + encodeURIComponent(selected.viewerId) + '/html', { headers: { accept: 'application/json' } }),
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
      <div className="dsh-ac">
        <style>{CSS}</style>
        <div className="dsh-ac-viewer">
          <div className="dsh-ac-viewer__head">
            <button type="button" className="dsh-ac-viewer__back" onClick={() => setSelected(null)}>← 列表</button>
            <span className={`dsh-ac__badge ${selected.kind === 'template' ? 'is-template' : 'is-app'}`}>
              {selected.kind === 'template' ? '模板' : '应用'}
            </span>
            <div className="dsh-ac-viewer__title">{selected.name}</div>
            <button
              type="button"
              className="dsh-ac__icon"
              title="刷新"
              aria-label="刷新"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>
            <button
              type="button"
              className="dsh-ac__icon"
              title="全屏查看"
              aria-label="全屏查看"
              onClick={() => {
                const host = document.querySelector('[data-artifact-fullscreen-host]') as HTMLElement | null
                const target = host ?? document.querySelector('iframe[data-artifact-viewer]')?.parentElement ?? null
                if (target === null) return
                if (document.fullscreenElement !== null) void document.exitFullscreen()
                else void target.requestFullscreen?.().catch(() => undefined)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" />
              </svg>
            </button>
            {selected.kind === 'app' ? (
              <button
                type="button"
                className="dsh-ac__icon"
                title="导出 HTML"
                aria-label="导出 HTML"
                disabled={exporting}
                onClick={() => void exportHtml()}
                style={{ opacity: exporting ? 0.5 : 1, cursor: exporting ? 'progress' : 'pointer' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v12" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M4 21h16" />
                </svg>
              </button>
            ) : null}
          </div>
          <div data-artifact-fullscreen-host style={{ flex: 1, minHeight: 0 }}>
            <CockpitViewer artifactId={selected.viewerId} reloadToken={reloadToken} />
          </div>
        </div>
        {notice !== '' ? <div className="dsh-ac__toast" role="status">{notice}</div> : null}
      </div>
    )
  }

  return (
    <div className="dsh-ac">
      <style>{CSS}</style>
      <div className="dsh-ac__head">
        <span className="dsh-ac__glyph" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 18a8 8 0 1 1 16 0" />
            <path d="M12 18l4.2-5" />
            <circle cx="12" cy="18" r="1.4" />
          </svg>
        </span>
        <div className="dsh-ac__heading">
          <div className="dsh-ac__name">驾驶舱</div>
          <div className="dsh-ac__sub">
            {apps.length} 个应用 · {templates.length} 个模板
            {catalogs.length > 0 ? ' · ' + catalogs.join(' / ') : ''}
          </div>
        </div>
        <button type="button" className="dsh-ac__icon" title="刷新" aria-label="刷新" onClick={() => void load()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 4v5h-5" />
          </svg>
        </button>
      </div>

      <div className="dsh-ac__body">
        {loading ? <div className="dsh-ac__state">正在加载驾驶舱资产…</div> : null}
        {error !== null ? <div className="dsh-ac__error" role="alert">{error}</div> : null}

        {!loading && error === null ? (
          <section className="dsh-ac__section">
            <div className="dsh-ac__section-head">
              <span>应用</span>
              <span className="dsh-ac__count">{apps.length}</span>
            </div>
            {apps.length === 0 ? <div className="dsh-ac__state">暂无驾驶舱应用</div> : (
              <div className="dsh-ac__list">
                {apps.map((app) => (
                  <article
                    key={app.id}
                    className="dsh-ac__card"
                    data-cockpit-id={app.id}
                    tabIndex={0}
                    onClick={() => openApp(app)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openApp(app) }
                    }}
                  >
                    <div className="dsh-ac__card-top">
                      <span className="dsh-ac__badge is-app">应用</span>
                      <span className={`dsh-ac__status ${app.status === 'PUBLISHED' ? 'is-published' : 'is-draft'}`}>
                        {app.status === 'PUBLISHED' ? '已发布' : '草稿'}
                      </span>
                    </div>
                    <h3 className="dsh-ac__card-title" title={app.name}>{app.name}</h3>
                    {app.description ? <p className="dsh-ac__card-desc">{app.description}</p> : null}
                    <div className="dsh-ac__meta">
                      <span>{app.catalog ?? '未分类'}</span>
                      <span className="dot" />
                      <span>{versionLabel(app)}</span>
                    </div>
                    <div className="dsh-ac__actions" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="dsh-ac__btn is-primary" data-action="view" onClick={() => openApp(app)}>查看</button>
                      <button
                        type="button"
                        className="dsh-ac__btn"
                        data-action="insert"
                        onClick={() => addToConversation({ kind: 'app', id: app.id, name: app.name, catalog: app.catalog })}
                      >添加到对话</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {!loading ? (
          <section className="dsh-ac__section">
            <div className="dsh-ac__section-head">
              <span>模板</span>
              <span className="dsh-ac__count">{templates.length}</span>
            </div>
            {templateError !== null ? <div className="dsh-ac__error" role="alert">模板加载失败：{templateError}</div> : null}
            {templateError === null && templates.length === 0 ? <div className="dsh-ac__state">暂无驾驶舱模板</div> : null}
            {templates.length > 0 ? (
              <div className="dsh-ac__list">
                {templates.map((template) => {
                  const slots = template.contract?.slots ?? []
                  return (
                    <article
                      key={template.id}
                      className="dsh-ac__card"
                      data-template-id={template.id}
                      tabIndex={0}
                      onClick={() => openTemplate(template)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTemplate(template) }
                      }}
                    >
                      <div className="dsh-ac__card-top">
                        <span className="dsh-ac__badge is-template">模板</span>
                        <span className="dsh-ac__status">{versionLabel(template)}</span>
                      </div>
                      <h3 className="dsh-ac__card-title" title={template.name}>{template.name}</h3>
                      <p className="dsh-ac__card-desc">
                        {template.description || template.contract?.question || '驾驶舱模板，可选择后填写数据槽位。'}
                      </p>
                      <div className="dsh-ac__meta">
                        <span>{template.catalog ?? '未分类'}</span>
                        {slots.length > 0 ? <span className="dot" /> : null}
                        {slots.length > 0 ? <span>{slots.length} 个槽位</span> : null}
                      </div>
                      <div className="dsh-ac__actions" onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="dsh-ac__btn is-primary" data-action="view" onClick={() => openTemplate(template)}>查看</button>
                        <button
                          type="button"
                          className="dsh-ac__btn"
                          data-action="insert"
                          onClick={() => addToConversation({ kind: 'template', id: template.id, name: template.name, catalog: template.catalog })}
                        >添加到对话</button>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      {notice !== '' ? <div className="dsh-ac__toast" role="status">{notice}</div> : null}
    </div>
  )
}