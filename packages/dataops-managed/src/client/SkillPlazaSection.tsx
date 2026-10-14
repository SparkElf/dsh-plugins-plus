import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconShareOutlineRegular,
  IconSkillOutlineRegular,
  IconTrashOutlineRegular,
  Pill,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { fetchPlaza, postPlazaAction, type PlazaListing, type PlazaSkill } from './skill-plaza-client.ts'
import styles from './SkillPlazaSection.module.css'

/** Values the skill center passes to a contributed section. */
export interface SkillPlazaSectionInjected {
  /** Translate one DataOps plaza message key. */
  t: (key: keyof typeof en) => string
  /**
   * The page's current search text.
   *
   * The page draws one search field for every skill it shows, and this section is part of that
   * page. Filtering here with the same text keeps the visible result consistent with the field;
   * drawing a second field would offer the same control twice and filter only half the page.
   */
  query: string
}

/** Props accepted by the plaza section. */
export type SkillPlazaSectionProps = Partial<InjectFace<SkillPlazaSectionInjected>>

/** What the section currently knows. */
type PlazaState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; listing: PlazaListing }
  | { kind: 'failed' }

/**
 * One skill as a card in the plaza grid.
 *
 * A plaza entry carries a name, a description, tags, and its own actions; a full-width row left
 * most of that width empty and forced every entry onto its own line. The card stacks the same
 * parts vertically, so a grid column count can change without the content reflowing into a
 * different shape.
 *
 * @param props - the card's skill, its actions, and the dictionary resolver.
 * @returns the rendered card.
 */
function PlazaCard({ skill, busy, onInstall, onUnshare, t }: {
  skill: PlazaSkill
  busy: boolean
  onInstall: () => void
  onUnshare: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.cardIcon}><IconSkillOutlineRegular size={16} /></span>
        <div className={styles.cardTitle}>{skill.name}</div>
        {skill.sharedByMe ? <Tag tone="info" className={styles.mine}>{t('plazaMine')}</Tag> : null}
      </div>
      {skill.description === undefined ? null : (
        <div className={styles.cardDesc}>{skill.description}</div>
      )}
      {skill.tags.length === 0 ? null : (
        <div className={styles.cardMarks}>
          {skill.tags.map((item) => <Tag tone="quiet" key={item}>{item}</Tag>)}
        </div>
      )}
      <div className={styles.cardEnd}>
        <Button
          variant="outline"
          size="sm"
          icon={<IconDownloadOutlineRegular size={16} />}
          disabled={busy}
          onClick={onInstall}
        >
          {t('plazaInstall')}
        </Button>
        {skill.sharedByMe ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconTrashOutlineRegular size={16} />}
            disabled={busy}
            onClick={onUnshare}
          >
            {t('plazaUnshare')}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Browse, share, and install skills other users published.
 *
 * The section appears only where this plugin is installed: the skill center renders the slot,
 * and an empty slot renders nothing. Every action goes through this plugin's Host route, so a
 * workspace without DataOps never reaches these calls.
 * @param props - Skill center injection values.
 * @returns The plaza section, or nothing before injection.
 */
export function SkillPlazaSection(props: SkillPlazaSectionProps): ReactNode {
  const { t } = props
  const [state, setState] = useState<PlazaState>({ kind: 'loading' })
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  // The page owns the search text and filters its own list with it, so this section reads the
  // same value rather than keeping a second copy that could disagree.
  const query = props.query ?? ''
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (filter: { tag?: string; query?: string }) => {
    try {
      const listing = await fetchPlaza(filter)
      setState(listing === null ? { kind: 'unavailable' } : { kind: 'ready', listing })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [])

  // The page's search text arrives as a prop, so a change to it is what reloads the listing:
  // the plaza filters on the Host, where the whole catalogue is known.
  useEffect(() => { void load({ query }) }, [load, query])

  const refresh = useCallback(async (nextTag = tag, nextQuery = query) => {
    await load({ tag: nextTag, query: nextQuery })
  }, [load, tag, query])

  const act = useCallback(async (body: Record<string, unknown>, message: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await postPlazaAction(body)
      setNotice(message)
      await refresh()
    } catch {
      setNotice(t === undefined ? null : t('plazaActionFailed'))
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  if (t === undefined) return null
  if (state.kind === 'loading') return null

  // The section names itself once; the states below swap only what sits under the heading. The
  // count sits beside the title as the skill center's own group headings carry theirs, so both
  // halves of the page announce a group the same way.
  const head = (count: number | null): ReactNode => (
    <div className={styles.head}>
      <h2 className={styles.title}>
        {t('plazaTitle')}
        {count === null ? null : <span className={styles.titleCount}>{count}</span>}
      </h2>
    </div>
  )

  if (state.kind === 'unavailable') {
    return <section className={styles.section}>{head(null)}<p className={styles.status}>{t('plazaUnavailable')}</p></section>
  }
  if (state.kind === 'failed') {
    return (
      <section className={styles.section}>
        {head(null)}
        <div className={styles.empty} role="alert">
          <span className={styles.emptyIcon}><IconSkillOutlineRegular size={28} /></span>
          <p className={styles.emptyText}>{t('plazaLoadFailed')}</p>
          <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void refresh() }}>
            {t('plazaRetry')}
          </Button>
        </div>
      </section>
    )
  }

  const { listing } = state
  return (
    <section className={styles.section}>
      {head(listing.skills.length)}

      {listing.tags.length === 0 ? null : (
        <div className={styles.tagBar}>
          <Pill active={tag === ''} onClick={() => { setTag(''); void refresh('', query) }}>{t('plazaAllTags')}</Pill>
          {listing.tags.map((item) => (
            <Pill key={item} active={tag === item} onClick={() => { setTag(item); void refresh(item, query) }}>
              {item}
            </Pill>
          ))}
        </div>
      )}

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}

      {listing.skills.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><IconShareOutlineRegular size={28} /></span>
          <p className={styles.emptyText}>{t('plazaEmpty')}</p>
        </div>
      ) : null}

      <ul className={styles.cards}>
        {listing.skills.map((skill) => (
          <PlazaCard
            key={skill.id}
            skill={skill}
            busy={busy}
            t={t}
            onInstall={() => { void act({ action: 'install', id: skill.id }, t('plazaInstalled')) }}
            onUnshare={() => { void act({ action: 'unshare', id: skill.id }, t('plazaUnshared')) }}
          />
        ))}
      </ul>
    </section>
  )
}

/** Re-exported so the registration site reads the route from one place. */
export { SKILL_PLAZA_PATH } from './skill-plaza-client.ts'
