import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconShareOutlineRegular,
  IconSkillOutlineRegular,
  IconTrashOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { fetchPlaza, postPlazaAction, type PlazaListing, type PlazaSkill } from './skill-plaza-client.ts'
import { decideReview, fetchReviewContext, reviewDemoMode, scanReview } from './review-client.ts'
import type { ReviewContext, ReviewTab, RiskReport } from './review-types.ts'
import {
  canReview,
  filterByReview,
  notificationTab,
  normalizeReviewStatus,
  reviewCounts,
  reviewTabsFor,
  visibilityTag,
} from './review-types.ts'
import { demoPlazaSkills } from './review-demo.ts'
import { NotificationBell } from './NotificationBell.tsx'
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

/** Tab counts from the same visible rows the cards render. */
function countsOf(skills: readonly PlazaSkill[]): NonNullable<PlazaListing['counts']> {
  const counted = reviewCounts(skills)
  return {
    approved: counted.approved,
    pending: counted.pending,
    rejected: skills.filter(row => row.reviewStatus === 'rejected').length,
    total: counted.all,
  }
}

/** One skill as a card in the plaza grid. */
function PlazaCard({ skill, busy, canAudit, onInstall, onUnshare, onReview, t }: {
  skill: PlazaSkill
  busy: boolean
  canAudit: boolean
  onInstall: () => void
  onUnshare: () => void
  onReview: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const status = normalizeReviewStatus(skill.reviewStatus)
  const tag = visibilityTag(skill)
  return (
    <li className={styles.card} data-review-status={status}>
      <div className={styles.cardTop}>
        <span className={styles.cardIcon}><IconSkillOutlineRegular size={16} /></span>
        <div className={styles.cardTitle}>{skill.name}</div>
        <span className={styles.tagTop} title={tag.detail}>{tag.label}</span>
      </div>
      <div className={styles.cardMarks}>
        {skill.sharedByMe ? <span className={styles.sharedTag}>{t('plazaSharedTag')}</span> : null}
        {status === 'pending' ? <span className={styles.pendingTag}>{t('plazaTabPending')}</span> : null}
        {status === 'rejected' ? <span className={styles.rejectedTag}>{t('plazaReject')}</span> : null}
        {skill.tags.map(item => <span className={styles.mark} key={item}>{item}</span>)}
      </div>
      <div className={styles.cardDesc}>{skill.description ?? ''}</div>
      {status === 'rejected' && skill.reviewNote !== null && skill.reviewNote !== undefined ? (
        <p className={styles.reviewNote}>{skill.reviewNote}</p>
      ) : null}
      <div className={styles.cardEnd}>
        {canAudit && status === 'pending' ? (
          <Button variant="outline" size="sm" className={styles.reviewButton} onClick={onReview}>
            {t('plazaReview')}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" icon={<IconDownloadOutlineRegular size={16} />} disabled={busy} onClick={onInstall}>
          {t('plazaInstall')}
        </Button>
        {skill.sharedByMe ? (
          <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={16} />} disabled={busy} onClick={onUnshare}>
            {t('plazaUnshare')}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" className={styles.detailButton} onClick={() => { setOpen(true) }}>
          {t('plazaShowDetail')}
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={skill.name}
        closeLabel={t('plazaClose')}
        className={styles.dialog as string}
        footer={<Button variant="outline" onClick={() => { setOpen(false) }}>{t('plazaClose')}</Button>}
      >
        <dl className={styles.detail}>
          <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaDetailUpdated')}</dt><dd className={styles.detailValue}>{skill.updatedAt}</dd></div>
          <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaDetailBody')}</dt><dd className={styles.detailValue}>{skill.instruction}</dd></div>
        </dl>
      </Modal>
    </li>
  )
}

/** The AI report block inside the audit dialog. */
function RiskReportView({ report, busy, failed, onScan, t }: {
  report: RiskReport | null
  busy: boolean
  failed: boolean
  onScan: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  return (
    <section className={styles.risk}>
      <div className={styles.riskHead}>
        <strong>{t('plazaRiskTitle')}</strong>
        <Button variant="outline" size="sm" disabled={busy} onClick={onScan}>
          {busy ? t('plazaRiskScanning') : t('plazaRiskScan')}
        </Button>
      </div>
      {failed ? <p className={styles.riskFailed}>{t('plazaRiskFailed')}</p> : null}
      {report === null ? (busy ? null : <p className={styles.riskEmpty}>{t('plazaRiskNone')}</p>) : (
        <>
          <div className={styles.riskSummary}>
            {report.score === undefined ? null : <span className={styles.riskScore}>{t('plazaRiskScore')} {report.score}</span>}
            {report.severity === undefined ? null : <span className={styles.severity} data-severity={report.severity}>{report.severity}</span>}
            {report.summary === undefined ? null : <span>{report.summary}</span>}
          </div>
          <ul className={styles.findings}>
            {report.findings.map((finding, index) => (
              <li key={String(index)} className={styles.finding}>
                <span className={styles.severity} data-severity={finding.severity}>{finding.severity}</span>
                <strong>{finding.category}</strong>
                {finding.evidence === undefined ? null : <span className={styles.findingText}>{finding.evidence}</span>}
                {finding.recommendation === undefined ? null : <span className={styles.findingHint}>{finding.recommendation}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * Browse, share, and install skills other users published.
 *
 * Review is a permissioned overlay on the same plaza: the tab strip and the audit dialog only
 * appear when the Host says the caller may review, and the Host additionally narrows the pending
 * list to the caller's department subtree.
 */
export function SkillPlazaSection(props: SkillPlazaSectionProps): ReactNode {
  const { t } = props
  const [state, setState] = useState<PlazaState>({ kind: 'loading' })
  const [context, setContext] = useState<ReviewContext | null | undefined>(undefined)
  const [tab, setTab] = useState<ReviewTab>('approved')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [audit, setAudit] = useState<PlazaSkill | null>(null)
  const [risk, setRisk] = useState<RiskReport | null>(null)
  const [riskBusy, setRiskBusy] = useState(false)
  const [riskFailed, setRiskFailed] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const query = props.query ?? ''
  const allowed = canReview(context)

  useEffect(() => {
    let live = true
    void fetchReviewContext().then((next) => { if (live) setContext(next) }).catch(() => { if (live) setContext(null) })
    return () => { live = false }
  }, [])

  const load = useCallback(async (filter: { tab: ReviewTab; tag: string; query: string }) => {
    try {
      // The demo fixture is complete on its own: mixing it with a live list would still call a
      // backend whose review endpoints have not shipped, which is exactly what the fixture exists
      // to review without.
      if (reviewDemoMode()) {
        const demo = demoPlazaSkills()
        setState({
          kind: 'ready',
          listing: {
            skills: [...filterByReview(demo, filter.tab)],
            tags: ['性能', '数据', '数据库', '质量', '经营', '日报', '客户'],
            counts: countsOf(demo),
          },
        })
        return
      }
      // One visible snapshot per query/tag. The tab is a client-side filter, so the count on
      // each tab is always the number of cards that tab will actually show.
      const listing = await fetchPlaza({ tag: filter.tag, query: filter.query, status: allowed ? 'all' : 'approved' })
      if (listing === null) {
        setState({ kind: 'unavailable' })
        return
      }
      const visible = allowed ? listing.skills : listing.skills.filter(row => normalizeReviewStatus(row.reviewStatus) === 'approved')
      setState({ kind: 'ready', listing: { ...listing, skills: [...filterByReview(visible, filter.tab)], counts: countsOf(visible) } })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [allowed])

  useEffect(() => { void load({ tab, tag, query }) }, [load, tab, tag, query])

  const refresh = useCallback(async (nextTab = tab, nextTag = tag) => {
    await load({ tab: nextTab, tag: nextTag, query })
  }, [load, tab, tag, query])

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

  const runScan = async (skill: PlazaSkill): Promise<void> => {
    setRiskBusy(true)
    setRiskFailed(false)
    try {
      const report = await scanReview('skill', [skill.id])
      if (report === null) setRiskFailed(true)
      else setRisk(report)
    } catch {
      setRiskFailed(true)
    } finally {
      setRiskBusy(false)
    }
  }

  const openAudit = (skill: PlazaSkill): void => {
    setAudit(skill)
    setRisk(skill.riskReport ?? null)
    setRiskFailed(false)
    setReviewNote('')
    setReviewError(null)
    if (skill.riskReport === null || skill.riskReport === undefined) void runScan(skill)
  }

  const submitReview = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (audit === null || reviewBusy) return
    if (decision === 'reject' && reviewNote.trim() === '') {
      setReviewError(t === undefined ? null : t('plazaReviewNote'))
      return
    }
    setReviewBusy(true)
    setReviewError(null)
    try {
      const ok = await decideReview('skill', [audit.id], decision, reviewNote.trim())
      if (!ok) {
        setReviewError(t === undefined ? null : t('plazaReviewFailed'))
        return
      }
      setAudit(null)
      setNotice(t === undefined ? null : t('plazaReviewDone'))
      await refresh('pending')
    } catch {
      setReviewError(t === undefined ? null : t('plazaReviewFailed'))
    } finally {
      setReviewBusy(false)
    }
  }

  if (t === undefined) return null
  if (state.kind === 'loading') return null

  const head = (count: number | null): ReactNode => (
    <div className={styles.head}>
      <div className={styles.headRow}>
        <h2 className={styles.title}>
          {t('plazaTitle')}
          {count === null ? null : <span className={styles.titleCount}>{count}</span>}
        </h2>
        {reviewDemoMode() ? <span className={styles.demoTag}>{t('plazaDemo')}</span> : null}
        <NotificationBell
          label={t('plazaTitle') + '通知'}
          onOpen={(item) => {
            const next = notificationTab(item)
            if (next !== undefined) setTab(next)
          }}
        />
      </div>
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
          <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void refresh() }}>{t('plazaRetry')}</Button>
        </div>
      </section>
    )
  }

  const { listing } = state
  const counts: Record<ReviewTab, number> = listing.counts === undefined
    ? reviewCounts(listing.skills)
    : { approved: listing.counts.approved, pending: listing.counts.pending, all: listing.counts.total }
  const tabs = reviewTabsFor(context)
  const tabLabel = (item: ReviewTab): string => item === 'approved' ? t('plazaTabApproved') : item === 'pending' ? t('plazaTabPending') : t('plazaTabAll')

  return (
    <section className={styles.section}>
      {head(counts[tab])}
      {tabs.length > 1 ? (
        <div className={styles.tabs} role="tablist" aria-label={t('plazaTitle')}>
          {tabs.map(item => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? styles.tab + ' ' + styles.tabActive : styles.tab}
              onClick={() => { setTab(item); void load({ tab: item, tag, query }) }}
            >
              {tabLabel(item)}
              <span className={styles.tabCount}>{counts[item]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {listing.tags.length === 0 ? null : (
        <div className={styles.tagBar}>
          <button type="button" className={tag === '' ? styles.chip + ' ' + styles.chipOn : styles.chip} onClick={() => { setTag(''); void refresh(tab, '') }}>{t('plazaAllTags')}</button>
          {listing.tags.map(item => (
            <button key={item} type="button" className={tag === item ? styles.chip + ' ' + styles.chipOn : styles.chip} onClick={() => { setTag(item); void refresh(tab, item) }}>{item}</button>
          ))}
        </div>
      )}

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}

      {listing.skills.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><IconShareOutlineRegular size={28} /></span>
          <p className={styles.emptyText}>{tab === 'pending' ? t('plazaPendingEmpty') : t('plazaEmpty')}</p>
        </div>
      ) : null}

      <ul className={styles.cards}>
        {listing.skills.map(skill => (
          <PlazaCard
            key={skill.id}
            skill={skill}
            busy={busy}
            canAudit={allowed}
            t={t}
            onInstall={() => { void act({ action: 'install', id: skill.id }, t('plazaInstalled')) }}
            onUnshare={() => { void act({ action: 'unshare', id: skill.id }, t('plazaUnshared')) }}
            onReview={() => { openAudit(skill) }}
          />
        ))}
      </ul>

      <Modal
        open={audit !== null}
        onClose={() => { if (!reviewBusy) setAudit(null) }}
        title={t('plazaAuditTitle')}
        closeLabel={t('plazaClose')}
        className={styles.auditDialog as string}
        footer={(
          <div className={styles.auditFooter}>
            <Button variant="outline" disabled={reviewBusy} onClick={() => { setAudit(null) }}>{t('plazaClose')}</Button>
            <Button variant="outline" disabled={reviewBusy} onClick={() => { void submitReview('reject') }}>{t('plazaReject')}</Button>
            <Button variant="primary" disabled={reviewBusy} onClick={() => { void submitReview('approve') }}>{t('plazaApprove')}</Button>
          </div>
        )}
      >
        {audit === null ? null : (
          <div className={styles.audit}>
            <dl className={styles.detail}>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaAuditSource')}</dt><dd className={styles.detailValue}>{audit.ownerName ?? '—'} · {visibilityTag(audit).detail}</dd></div>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaAuditVisibility')}</dt><dd className={styles.detailValue}>{visibilityTag(audit).label}</dd></div>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaShowDetail')}</dt><dd className={styles.detailValue}>{audit.description ?? '—'}</dd></div>
            </dl>
            <RiskReportView report={risk} busy={riskBusy} failed={riskFailed} onScan={() => { void runScan(audit) }} t={t} />
            <label className={styles.noteField}>
              <span>{t('plazaReviewNote')}</span>
              <textarea value={reviewNote} placeholder={t('plazaReviewNotePlaceholder')} onChange={(event) => { setReviewNote(event.target.value) }} />
            </label>
            {reviewError === null ? null : <p className={styles.reviewError} role="alert">{reviewError}</p>}
          </div>
        )}
      </Modal>
    </section>
  )
}

/** Re-exported so the registration site reads the route from one place. */
export { SKILL_PLAZA_PATH } from './skill-plaza-client.ts'