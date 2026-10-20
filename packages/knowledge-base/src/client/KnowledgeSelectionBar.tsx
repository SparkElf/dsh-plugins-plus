/**
 * The batch action bar that closes a multi-select session in the tree.
 *
 * Copied from the explorer's own `explorerSelectionBar` (`FileTree.tsx:2238`,
 * `sidebar.module.css:932`): the same `role="toolbar"`, the same sticky bottom
 * position, the same 28px minimum height, the same `bg-layer-2` fill and 4px
 * radius, and the same split between a shrinking count on the left and the
 * actions on the right. It is a copy rather than a second design because a reader
 * sees that bar in this window's right sidebar, and the two are the same gesture.
 *
 * The actions are deliberately only the two this build can actually perform.
 * Delete is absent because the trash has no decided retention or ownership
 * semantics, and a destructive button wired to an undecided policy is worse than
 * no button: the explorer's own bar carries delete, so its absence here is a
 * decision rather than an oversight.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import styles from './KnowledgeSelectionBar.module.css'

/** Props for the batch bar. */
export interface KnowledgeSelectionBarProps {
  /** Locale-bound copy resolver. */
  t: (key: string, params?: Record<string, string | number>) => string
  /** How many rows are selected, for the count and the label. */
  count: number
  /** Move every selected path into one folder the reader picks. */
  onMove: () => void
  /** Pin every selected path. */
  onPin: () => void
  /** Drop the selection. */
  onClear: () => void
  /**
   * Whether a batch write is in flight, so the actions can be held.
   *
   * A second click while the first is still moving would send the same paths twice,
   * and the second would be refused as a missing source -- an error the reader
   * would read as the feature being broken.
   */
  busy?: boolean
}

/**
 * Render the batch bar for the current selection.
 * @param props - the count, the three actions, and the busy flag.
 * @returns The toolbar.
 */
export function KnowledgeSelectionBar(props: KnowledgeSelectionBarProps) {
  return (
    <div
      className={styles.bar}
      role="toolbar"
      aria-label={props.t('filesSelected', { count: props.count })}
      data-testid="kb-selection-bar"
    >
      <span className={styles.text}>{props.t('filesSelected', { count: props.count })}</span>
      <span className={styles.actions}>
        {/* Native buttons, as the explorer's own bar uses: these sit inside a
            sticky strip rather than in a form, and the official `Button` would add
            its own padding and background to a 28px strip. */}
        <button
          type="button"
          className={styles.action}
          disabled={props.busy === true}
          onClick={props.onMove}
        >
          {props.t('moveSelected')}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={props.busy === true}
          onClick={props.onPin}
        >
          {props.t('pinSelected')}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={props.busy === true}
          onClick={props.onClear}
        >
          {props.t('clearSelection')}
        </button>
      </span>
    </div>
  )
}
