export interface PathCrumb { label: string; path: string }

export function pathBreadcrumbs(path: string): PathCrumb[] {
  const normalized = path.trim().replace(/\/+$/u, '') || (path.startsWith('/') ? '/' : '.')
  if (normalized === '.') return [{ label: 'Home', path: '.' }]
  if (normalized === '/') return [{ label: 'Root', path: '/' }]
  const absolute = normalized.startsWith('/')
  const parts = normalized.split('/').filter(Boolean)
  const crumbs: PathCrumb[] = [{ label: absolute ? 'Root' : 'Home', path: absolute ? '/' : '.' }]
  let current = absolute ? '' : '.'
  for (const part of parts) {
    current = absolute ? current + '/' + part : current === '.' ? part : current + '/' + part
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

export function parentPath(path: string): string {
  if (path === '/' || path === '.') return path
  const parts = path.replace(/\/+$/u, '').split('/')
  parts.pop()
  return parts.join('/') || (path.startsWith('/') ? '/' : '.')
}

export function joinedPath(path: string, name: string): string {
  return path === '/' ? '/' + name : path === '.' ? name : path.replace(/\/+$/u, '') + '/' + name
}

export function formatBytes(value: number): string {
  if (value < 1024) return value.toString() + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}
