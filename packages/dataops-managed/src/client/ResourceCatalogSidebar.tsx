/**
 * The tab's own data-catalog tree (168px): 全部 / 收藏 / 置顶 + one row per catalog.
 *
 * The portal page inside the iframe is the product's card list and detail view; the host
 * sidebar owns the tree and only sends the active filter to that page, so the portal never
 * renders its own left column in embed mode.
 *
 * @module client/ResourceCatalogSidebar
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

export interface ResourceFilter {
  scope: 'all' | 'favorites' | 'pinned' | 'catalog'
  catalog?: string
  ids?: number[]
}

interface ResourceRow { id: number; catalog?: string }
interface ListResponse { items?: ResourceRow[]; total?: number }
interface PreferencePage { items?: Array<{ resourceId?: number; resource?: ResourceRow }>; total?: number }

const CSS = `
.dsh-cat{flex:0 0 168px;width:168px;min-width:0;border-right:1px solid var(--dsw-alias-border-l1,#2a2c33);padding:8px 6px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dsh-cat__head{display:flex;align-items:center;gap:6px;height:34px;padding:0 6px 0 8px;flex:0 0 auto}
.dsh-cat__head .ico{width:16px;height:16px;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#aab2c2)}
.dsh-cat__head .tt{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-cat__head .sp{flex:1}
.dsh-cat__head .collapse{width:22px;height:22px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-caption,#8b93a4);cursor:pointer;display:grid;place-items:center}
.dsh-cat__head .collapse:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-cat__search{margin:2px 8px 8px;height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);background:var(--dsw-alias-bg-layer-1,#1a1c21)}
.dsh-cat__search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:12px}
.dsh-cat__search input::placeholder{color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-cat__title{margin:8px 6px 3px;font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-cat__item{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:12px;text-align:left;cursor:pointer}
.dsh-cat__item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-cat__item.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,#fff)}
.dsh-cat__item .n{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#8b93a4);font-variant-numeric:tabular-nums}
.dsh-cat__item .ico{width:14px;text-align:center;font-size:11px;flex:0 0 auto}
`

export function ResourceCatalogSidebar({ onFilter }: { onFilter: (filter: ResourceFilter) => void }) {
  const [catalogs, setCatalogs] = useState<Array<[string, number]>>([])
  const [total, setTotal] = useState(0)
  const [favorites, setFavorites] = useState<number[]>([])
  const [pinned, setPinned] = useState<number[]>([])
  const [favoriteTotal, setFavoriteTotal] = useState(0)
  const [pinnedTotal, setPinnedTotal] = useState(0)
  const [active, setActive] = useState('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.dataopsCatalogTree = 'true'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  useEffect(() => {
    let live = true
    let timer: number | undefined
    const load = async (): Promise<boolean> => {
      try {
        const [listResponse, favoriteResponse, pinnedResponse] = await Promise.all([
          fetch('/integrations/dataops/resources?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
          fetch('/integrations/dataops/resources/favorites?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
          fetch('/integrations/dataops/resources/pinned?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
        ])
        if (!live) return false
        if (!listResponse.ok) throw new Error('HTTP ' + String(listResponse.status))
        const list = await listResponse.json() as ListResponse
        const counts = new Map<string, number>()
        for (const row of list.items ?? []) {
          if (typeof row.catalog !== 'string' || row.catalog.trim() === '') continue
          counts.set(row.catalog, (counts.get(row.catalog) ?? 0) + 1)
        }
        setCatalogs([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')))
        const nextTotal = typeof list.total === 'number' ? list.total : (list.items ?? []).length
        setTotal(nextTotal)
        if (favoriteResponse.ok) {
          const page = await favoriteResponse.json() as PreferencePage
          setFavorites((page.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number'))
          setFavoriteTotal(typeof page.total === 'number' ? page.total : (page.items ?? []).length)
        }
        if (pinnedResponse.ok) {
          const page = await pinnedResponse.json() as PreferencePage
          setPinned((page.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number'))
          setPinnedTotal(typeof page.total === 'number' ? page.total : (page.items ?? []).length)
        }
        return true
      } catch {
        /* the tree retries until the workspace credential is ready */
        return false
      }
    }
    const run = async (): Promise<void> => {
      const ok = await load()
      if (!live) return
      if (!ok) timer = window.setTimeout(() => { void run() }, 2500)
    }
    void run()
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [])

  const select = useCallback((key: string) => {
    setActive(key)
    if (key === 'all') onFilter({ scope: 'all' })
    else if (key === 'favorites') onFilter({ scope: 'favorites', ids: favorites })
    else if (key === 'pinned') onFilter({ scope: 'pinned', ids: pinned })
    else onFilter({ scope: 'catalog', catalog: key.slice('catalog:'.length) })
  }, [favorites, pinned, onFilter])

  const item = (key: string, icon: string, label: string, count: number) => (
    <button
      key={key}
      type="button"
      className={'dsh-cat__item' + (active === key ? ' is-active' : '')}
      onClick={() => select(key)}
      data-catalog-key={key}
    >
      <span className="ico" aria-hidden="true">{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="n">{count}</span>
    </button>
  )

  const visibleCatalogs = query.trim() === ''
    ? catalogs
    : catalogs.filter(([name]) => name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <aside className="dsh-cat" aria-label="数据目录">
      {/* 顶部：与「万相知识库」侧栏一致——图标 + 标题 + 收起按钮，下面一行搜索 */}
      <div className="dsh-cat__head">
        <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M1.8 4.2h4l1.2 1.6h7.2v7.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
        </svg>
        <span className="tt">数据资源</span>
        <span className="sp" />
        <button className="collapse" type="button" aria-label="收起目录" title="收起目录">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
            <path d="M6 2.8v10.4" />
          </svg>
        </button>
      </div>
      <label className="dsh-cat__search">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" style={{ opacity: 0.7 }}>
          <circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.5 13.5" />
        </svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按目录名搜索…" aria-label="按目录名搜索" />
      </label>
      {item('all', '▤', '全部', total)}
      {item('favorites', '★', '收藏', favoriteTotal)}
      {item('pinned', '📌', '置顶', pinnedTotal)}
      <div className="dsh-cat__title">数据目录</div>
      {catalogs.length === 0 ? <div style={{ padding: '4px 8px', fontSize: 10.5, opacity: 0.7 }}>暂无目录</div> : null}
      {visibleCatalogs.map(([name, count]) => item('catalog:' + name, '▸', name, count))}
    </aside>
  )
}
