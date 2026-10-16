import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The sidebar region must read as the same design system as the workspace region, which
 * is a claim about numbers copied from `ui-workspace`'s own stylesheet. Those numbers
 * cannot be asserted by rendering (no DOM environment ships here), so they are asserted
 * against the stylesheet this package owns.
 *
 * If `ui-workspace` changes a value, this fails and names the value rather than letting
 * the two regions drift apart silently.
 */
const CSS = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')

/**
 * Read every declaration block one selector owns, joined.
 *
 * A selector legitimately appears more than once — a size may be declared apart from its
 * layout — so the helper accumulates instead of stopping at the first block.
 */
const ruleOf = (selector: string): string => {
  const pattern = new RegExp(`\\.${selector}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gu')
  const blocks = [...CSS.matchAll(pattern)].map((match) => match[1])
  if (blocks.length === 0) throw new Error(`no rule for .${selector}`)
  return blocks.join(' ').replace(/\s+/gu, ' ')
}

describe('sidebar region aligns with the workspace region', () => {
  it('uses the workspace section header geometry', () => {
    // ui-workspace: .sectionHeader{height:36px;gap:4px;margin-bottom:4px;padding-left:4px}
    const header = ruleOf('sectionHeader')
    expect(header).toContain('height: 36px')
    expect(header).toContain('gap: 4px')
    expect(header).toContain('margin-bottom: 4px')
    expect(header).toContain('padding-left: 4px')
  })

  it('does not shrink the section label to a caption', () => {
    // The workspace label carries no font-size of its own and inherits the sidebar's
    // 14px; a small fixed size here is what made the first attempt look like a lookalike.
    const label = ruleOf('sectionLabel')
    expect(label).not.toMatch(/font-size/u)
    expect(label).toContain('line-height: 20px')
    expect(label).toContain('max-width: 45%')
  })

  it('keeps the icon button and expanded search at the workspace sizes', () => {
    expect(ruleOf('iconButton')).toContain('width: 28px')
    expect(ruleOf('iconButton')).toContain('height: 28px')
    // `searchExpanded` shares one block with `search`, so the size lives on `.searchExpanded`.
    expect(ruleOf('searchExpanded')).toContain('height: 30px')
    expect(ruleOf('searchInput')).toContain('font-size: 13px')
  })

  it('keeps the session row height', () => {
    // ui-workspace: .sessionRow{height:32px}
    expect(CSS).toContain('height: 32px')
  })

  it('draws every colour from a DSH token rather than a literal palette', () => {
    // A hard-coded colour is what makes a panel stop following the theme.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//gu, '')
    const literals = declarations.match(/#[0-9a-f]{3,8}\b/giu) ?? []
    // The only permitted literals are fallbacks inside var(), e.g. var(--x, #d29922).
    const bare = literals.filter((value) => !new RegExp(`var\\([^)]*${value}`, 'u').test(declarations))
    expect(bare).toEqual([])
  })

  it('fills the row container the seat gives it', () => {
    // The seat renders inside `sidebar.footer.action`, which the shell styles as a row
    // flex container. A column child there is content-sized unless it is told to grow,
    // which parked the header's trailing actions beside the label instead of against the
    // right edge.
    const root = ruleOf('root')
    expect(root).toContain('flex: 1 1 auto')
    expect(root).toContain('min-width: 0')
    expect(root).toContain('width: 100%')
  })

  it('renders the empty state the way the workspace region does', () => {
    // Copied from ui-workspace's `.emptyState`: centred column, glyph above the copy.
    const emptyState = ruleOf('emptyState')
    expect(emptyState).toContain('flex-direction: column')
    expect(emptyState).toContain('align-items: center')
    expect(emptyState).toContain('gap: 8px')
    expect(emptyState).toContain('font-size: 13px')
  })

  it('adds nothing to the empty state beyond the glyph and the copy', () => {
    // The workspace's empty state is an icon and a sentence, and nothing else. A link to
    // create a room would repeat the header's own button.
    const section = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    const start = section.indexOf('styles.emptyState')
    const block = section.slice(start, section.indexOf('</div>', start))
    expect(block).toContain('IconQueueOutlineRegular')
    expect(block).not.toContain('<button')
  })

  it('hides the collapsed search input instead of leaving a sliver', () => {
    // The input stays mounted while collapsed so the caret can move straight into it, and
    // `width: 0` alone still leaves a couple of pixels of caret visible after the search
    // glyph. Measured in the running app: the input sat 2px wide at the right of the
    // button and read as a stray colon.
    const input = ruleOf('searchInput')
    expect(input).toContain('width: 0')
    expect(input).toContain('opacity: 0')
    expect(input).toContain('pointer-events: none')
    // Open, it becomes visible again.
    expect(ruleOf('searchExpanded .searchInput')).toContain('opacity: 1')
  })

  it('does not let the search box grow inside its slot', () => {
    // The slot is what flexes; a growing inner box stretches past the 28px button.
    // `.search` shares its block with `.searchExpanded`, so match on the shared rule.
    expect(CSS).toMatch(/\.search,\s*\n\.searchExpanded \{[^}]*flex: none/u)
  })

  it('caps its own height, because the footer seat does not shrink', () => {
    // `footArea` is flex:none, so without a cap the room list grows until it crowds the
    // workspace region above it.
    expect(ruleOf('root')).toContain('max-height')
  })
})

describe('create dialog states what the fields decide', () => {
  const source = readFileSync(new URL('../src/client/CreateRoomDialog.tsx', import.meta.url), 'utf8')

  it('carries the working directory and preset to the server', () => {
    // Collecting the two fields and dropping them was the failure mode here: the room
    // would be created with the server default while the dialog implied otherwise.
    expect(source).toContain('cwd: cwd.trim()')
    expect(source).toContain('agentPreset: preset.trim()')
    expect(source).not.toContain('void cwd')
    expect(source).not.toContain('void preset')
  })

  it('warns about the working directory rather than hinting', () => {
    // Every member shares this scope, so the copy states the consequence.
    expect(source).toContain("t('createCwdHint')")
    expect(source).toContain('styles.warn')
  })

  it('shows the required notice that the switches are not access control', () => {
    expect(source).toContain("t('createNotice')")
  })

  it('offers the three policy dimensions, including the record-only trigger', () => {
    for (const key of ['createPolicy', 'createVisibility', 'createTrigger']) {
      expect(source).toContain(`t('${key}')`)
    }
    for (const key of ['triggerMention', 'triggerAlways', 'triggerNever']) {
      expect(source).toContain(key)
    }
  })
})

describe('room context menu follows the settled entry set', () => {
  const menu = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')

  it('offers the entries the design settled on', () => {
    for (const key of ['menuRename', 'menuInvite', 'menuSettings', 'menuMembers', 'copyRoomId', 'menuLeave']) {
      expect(menu, key).toContain(`t('${key}')`)
    }
  })

  it('omits the two official workspace entries that do not fit a room', () => {
    // Archiving duplicates "leave room", and forking copies history whose events carry no
    // member attribution — a room that looks continuous but whose older messages belong
    // to nobody. Neither is relabelled here; both are absent.
    expect(menu).not.toContain("t('archive')")
    expect(menu).not.toContain("t('fork')")
  })

  it('shows invite and leave only to a member', () => {
    // A room the operator left is still listed under the "show left rooms" filter, and
    // offering to leave it again would be a no-op the server rejects.
    expect(menu).toMatch(/room\.joined && \(\s*<button[\s\S]{0,200}menuInvite/u)
    expect(menu).toMatch(/room\.joined && \(\s*<button[\s\S]{0,200}menuLeave/u)
  })

  it('renames in place rather than through a second dialog', () => {
    expect(menu).toContain('renameTitle')
    expect(menu).toContain('store.rename')
  })
})

describe('room dialogs', () => {
  const dialogs = readFileSync(new URL('../src/client/RoomDialogs.tsx', import.meta.url), 'utf8')

  it('writes the three policy dimensions, not a subset', () => {
    expect(dialogs).toContain('invitePolicy')
    expect(dialogs).toContain('discoverability')
    expect(dialogs).toContain('agentTrigger')
    for (const key of ['triggerMention', 'triggerAlways', 'triggerNever']) {
      expect(dialogs).toContain(key)
    }
  })

  it('repeats the notice that the switches are not access control', () => {
    expect(dialogs).toContain("t('createNotice')")
  })

  it('sends the invite as the server expects it', () => {
    expect(dialogs).toContain('inviteMembers(roomId, userIds)')
  })
})

describe('右键菜单不被滚动容器裁剪', () => {
  it('renders the room menu through a portal, not inside the scrolling list', () => {
    // The room list scrolls (`overflow-y: auto`). A positioned menu inside it is clipped at
    // the box's edge, so the lower rooms lost their bottom entries — the menu appeared cut
    // off. The portal moves it outside every clipping ancestor.
    const tsx = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    expect(tsx).toContain("from 'react-dom'")
    expect(tsx).toMatch(/createPortal\(/u)
    expect(tsx).toMatch(/document\.body/u)
  })

  it('positions the portal against the row that opened it', () => {
    // Captured at open time rather than read during render, so scrolling the list while the
    // menu is open does not drag the menu away from the row the operator aimed at.
    const tsx = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    expect(tsx).toMatch(/getBoundingClientRect\(\)/u)
    expect(tsx).toMatch(/anchor: DOMRect/u)
  })

  it('keeps the view menu inline, where nothing clips it', () => {
    // Its anchor sits in the header, outside the scrolling list, so the portal would only
    // add indirection — it keeps its own absolute positioning class.
    const css = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.menuLayer\s*\{[^}]*position:\s*fixed/u)
    expect(css).toMatch(/\.menuInline\s*\{[^}]*position:\s*absolute/u)
  })
})
