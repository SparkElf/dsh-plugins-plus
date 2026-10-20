/**
 * The Trash surface.
 *
 * Deletion is not implemented, and the reason is a policy the product has not
 * settled rather than a missing call. The knowledge tree is a shared, curated
 * store: every user's view holds hardlinks to the same inodes, so "deleting" a
 * document raises questions this page cannot answer on its own -- whether it
 * disappears for everyone or only for the caller, who may empty it, and how long a
 * removal is recoverable. Each answer changes what a trash even IS, and building
 * one against a guess would ship a data-loss path on a shared store.
 *
 * The page is still a PAGE rather than a placeholder. It renders the columns the
 * feature will fill and an empty state that keeps them, so the shape is reviewable
 * now and the rows have somewhere to land: a two-line centred notice would have to
 * be thrown away when the data source arrives. No row is invented -- the table is
 * driven by a list that is genuinely empty until a delete record exists, and the
 * banner says so instead of implying the store holds nothing.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import styles from './KnowledgePanel.module.css'
import tableStyles from './KnowledgePermissions.module.css'

/** Props for the Trash surface. */
export interface KnowledgeTrashProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
}

/** One removed document, as the trash will list it. */
interface TrashEntry {
  /** Display name of the removed document. */
  name: string
  /** Path it was removed from, relative to the knowledge root. */
  origin: string
  /** ISO-8601 instant of the removal. */
  deletedAt: string
  /** Human-readable time left before it is purged. */
  retention: string
}

/**
 * Render the Trash surface.
 *
 * The list is empty by construction rather than by a fetch: there is no delete
 * record store to read, so an empty array is the honest value and a request would
 * be a route invented to answer nothing.
 * @param props - copy resolver.
 * @returns The trash table and its empty state.
 */
export function KnowledgeTrash(props: KnowledgeTrashProps) {
  const c = props.t
  const rows: TrashEntry[] = []

  return (
    <div className={styles.surface}>
      {/* No title band: the panel header already names this surface, and a second
          heading over the table repeated it. The retention explanation is the part
          that is not in the header, so it stays. */}
      {rows.length > 0 && (
        <div className={tableStyles.tableHead}>
          <p className={tableStyles.tableHint}>{c('trashDisabled')}</p>
        </div>
      )}
      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>{c('colTrashName')}</th>
            <th>{c('colTrashOrigin')}</th>
            <th>{c('colTrashDeletedAt')}</th>
            <th>{c('colTrashRetention')}</th>
            <th>{c('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {/* The empty state KEEPS the header above it: a table that removes its
              own columns reads as a different page, and the columns are the part
              of this surface that is already decided. */}
          {rows.length === 0 && (
            <tr className={tableStyles.emptyRow} role="status">
              <td colSpan={5}>
                <div>{c('trashEmptyRow')}</div>
                <div className={tableStyles.emptyNote}>{c('trashPending')}</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
