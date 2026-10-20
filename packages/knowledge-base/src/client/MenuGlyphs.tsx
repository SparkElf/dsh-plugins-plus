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
  IconFlatListOutlineRegular,
  IconSearchOutlineRegular,
  IconShieldOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The glyph matching one rail section.
 *
 * Kept as a map rather than a switch so the menu can render a row per entry and
 * stay a single expression.
 * @param kind - section id, matching the selection kind.
 * @param size - glyph size.
 * @returns The glyph element.
 */
export function sectionGlyph(kind: 'search' | 'permissions' | 'indexing', size?: number) {
  const props = { size: size ?? 16 }
  if (kind === 'permissions') return <IconShieldOutlineRegular {...props} />
  if (kind === 'indexing') return <IconFlatListOutlineRegular {...props} />
  return <IconSearchOutlineRegular {...props} />
}
