import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
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
  if (state.kind === 'unavailable') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('plazaTitle')}</h2>
        <p className={styles.intro}>{t('plazaUnavailable')}</p>
      </section>
    )
  }
  if (state.kind === 'failed') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('plazaTitle')}</h2>
        <p className={styles.intro} role="alert">{t('plazaLoadFailed')}</p>
      </section>
    )
  }

  const { listing } = state
  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('plazaTitle')}</h2>
      <p className={styles.intro}>{t('plazaIntro')}</p>

      <div className={styles.filters}>
        <input
          className={styles.search}
          placeholder={t('plazaSearch')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <select
          className={styles.tagSelect}
          aria-label={t('plazaTagFilter')}
          value={tag}
          onChange={(event) => {
            setTag(event.target.value)
            void refresh(event.target.value, query)
          }}
        >
          <option value="">{t('plazaAllTags')}</option>
          {listing.tags.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}

      {listing.skills.length === 0 ? <p className={styles.intro}>{t('plazaEmpty')}</p> : null}
      <ul className={styles.cards}>
        {listing.skills.map((skill) => (
          <li className={styles.card} key={skill.id}>
            <div className={styles.cardHead}>
              <strong className={styles.cardName}>{skill.name}</strong>
              {skill.sharedByMe ? <span className={styles.mine}>{t('plazaMine')}</span> : null}
            </div>
            {skill.description === undefined ? null : <p className={styles.cardDesc}>{skill.description}</p>}
            {skill.tags.length === 0 ? null : (
              <div className={styles.tags}>
                {skill.tags.map((item) => <span className={styles.tag} key={item}>{item}</span>)}
              </div>
            )}
            <div className={styles.cardActions}>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => { void act({ action: 'install', id: skill.id }, t('plazaInstalled')) }}
              >
                {t('plazaInstall')}
              </Button>
              {skill.sharedByMe ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void act({ action: 'unshare', id: skill.id }, t('plazaUnshared')) }}
                >
                  {t('plazaUnshare')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Re-exported so the registration site reads the route from one place. */
export { SKILL_PLAZA_PATH } from './skill-plaza-client.ts'
