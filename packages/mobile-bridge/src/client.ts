/**
 * Client half: on narrow viewports, inject the mobile overlay stylesheet from
 * the local `/mobile/` route. Stock design tokens stay untouched; the overlay
 * only repairs occlusion at small widths.
 * @module @sparkelf/dsh-mobile-bridge/client
 */

export function apply(): void {
  if (typeof document === 'undefined') return
  const narrow = window.matchMedia('(max-width: 720px)')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/mobile/bridge/style.css'
  const sync = () => { link.disabled = !narrow.matches }
  narrow.addEventListener('change', sync)
  sync()
  document.head.appendChild(link)
}
