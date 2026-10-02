import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconShareOutlineRegular,
  IconSkillOutlineRegular,
  IconSparkleRegular,
  IconTrashOutlineRegular,
  Input,
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
 * One plaza row, laid out like the skill center's own rows so the section reads as part of the
 * page rather than a panel bolted onto it.
 * @param props - the row's skill, its actions, and the dictionary resolver.
 * @returns the rendered row.
 */
function PlazaRow({ skill, busy, onInstall, onUnshare, t }: {
  skill: PlazaSkill
  busy: boolean
  onInstall: () => void
  onUnshare: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}><IconSkillOutlineRegular size={22} /></span>
        <div className={styles.cardMain}>
          <div className={styles.cardTitle}>
            {skill.name}
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
        </div>
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
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (filter: { tag?: string; query?: string }) => {
    try {
      const listing = await fetchPlaza(filter)
      setState(listing === null ? { kind: 'unavailable' } : { kind: 'ready', listing })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [])

  useEffect(() => { void load({}) }, [load])

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

  // The section names itself once; the states below swap only what sits under the heading.
  const head = (
    <div className={styles.head}>
      <h2 className={styles.title}>
        <span className={styles.titleIcon}><IconSparkleRegular size={18} /></span>
        {t('plazaTitle')}
      </h2>
      <p className={styles.intro}>{t('plazaIntro')}</p>
    </div>
  )

  if (state.kind === 'unavailable') {
    return <section className={styles.section}>{head}<p className={styles.intro}>{t('plazaUnavailable')}</p></section>
  }
  if (state.kind === 'failed') {
    return (
      <section className={styles.section}>
        {head}
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
      {head}

      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          icon={<IconSearchOutlineRegular size={16} />}
          placeholder={t('plazaSearch')}
          value={query}
          onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            void refresh(tag, next)
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<IconRefreshOutlineRegular size={16} />}
          aria-label={t('plazaRefresh')}
          disabled={busy}
          onClick={() => { void refresh() }}
        />
      </div>

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
          <PlazaRow
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
