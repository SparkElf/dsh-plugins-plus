/**
 * Glyphs for the management page's own menu rows.
 *
 * These are the product's own icon components, not hand-drawn paths: the icon set
 * already draws each glyph on the product grid with the product stroke weights
 * (`ICON_REGULAR_STROKE` 1, `ICON_MEDIUM_STROKE` 1.3), and a local SVG with its own
 * stroke reads noticeably heavier beside them. Colour rides `currentColor`, so a
 * row's own text colour drives the glyph and no row needs an icon-specific rule.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import {
  IconArchiveOutlineRegular,
  IconChecklistOutlineRegular,
  IconFlatListOutlineRegular,
  IconSettingsOutlineRegular,
  IconShieldOutlineRegular,
  IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One rail section id, matching a selection kind. */
export type SectionKind = 'home' | 'permissions' | 'indexing' | 'trash' | 'audit' | 'settings'

/**
 * The glyph matching one rail section.
 *
 * Kept as a map rather than a switch so the menu can render a row per entry and
 * stay a single expression. The document glyph stands for Home because that is
 * what the surface holds, and it is the same mark the left sidebar uses for this
 * plugin, so the entry reads consistently in both rails.
 * @param kind - section id, matching the selection kind.
 * @param size - glyph size.
 * @returns The glyph element.
 */
export function sectionGlyph(kind: SectionKind, size?: number) {
  const props = { size: size ?? 16 }
  if (kind === 'permissions') return <IconShieldOutlineRegular {...props} />
  if (kind === 'indexing') return <IconFlatListOutlineRegular {...props} />
  if (kind === 'trash') return <IconArchiveOutlineRegular {...props} />
  // A checklist rather than a document with a clock: this row is a worklist to get
  // through, and the trail beside it on the same page is the record of having done so.
  if (kind === 'audit') return <IconChecklistOutlineRegular {...props} />
  if (kind === 'settings') return <IconSettingsOutlineRegular {...props} />
  // `IconWorkspaceTreeOutline` rather than the filled-artwork `IconDeliverDoc`: that one
  // is the only glyph in the shipped set without an `Outline` sibling, and beside three
  // outline rows it reads as the odd one out. This marks a browsable tree, which is what
  // Home shows here, and it keeps the rail in one visual family.
  return <IconWorkspaceTreeOutlineRegular {...props} />
}

/**
 * The brand mark at the rail's top-left.
 *
 * The same glyph the left sidebar shows for this plugin, at the shell's menu-icon
 * size rather than a rail-sized one: this row is a page header, and the sidebar's
 * own larger step belongs to the global rail rather than to a page inside it.
 * @param props - whether the rail is folded, which drops the mark to icon size.
 * @returns The brand glyph.
 */
export function KnowledgeMenuBrand(props: { folded: boolean }) {
  return <IconWorkspaceTreeOutlineRegular size={props.folded ? 18 : 20} />
}
