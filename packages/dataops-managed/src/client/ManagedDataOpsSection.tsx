import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { setWanxiangBrandEnabled, wanxiangBrandPreference } from './brand-store.ts'
import { MODEL_SYNC_PATH, fetchModelSyncStatus, postModelSyncAction } from './model-sync-client.ts'
import type { ModelSyncStatus } from './model-sync-client.ts'
import { fetchWorkspaceLimits, saveWorkspaceLimits } from './workspace-limits-client.ts'
import type { WorkspaceLimits, WorkspaceLimitsStatus } from './workspace-limits-client.ts'
import styles from './ManagedDataOpsSection.module.css'

/** Values injected by the DSH Settings slot. */
export interface ManagedDataOpsSectionInjected {
  /** Translate one managed DataOps Settings message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the managed DataOps Settings section. */
export type ManagedDataOpsSectionProps = Partial<InjectFace<ManagedDataOpsSectionInjected>>

/**
 * Explain the DataOps-managed JWT and permission owner, and share model configuration.
 * @param props - Settings slot injection values.
 * @returns The localized managed DataOps section, or nothing before injection.
 */
export function ManagedDataOpsSection(props: ManagedDataOpsSectionProps) {
  const { t } = props
  const branding = useSyncExternalStore(
    wanxiangBrandPreference.subscribe,
    wanxiangBrandPreference.getSnapshot,
    wanxiangBrandPreference.getSnapshot,
  )
  if (t === undefined) return null

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <div className={styles.statusRow}>
        <StateDot state="done" />
        <strong>{t('managed')}</strong>
      </div>
      <p className={styles.description}>{t('description')}</p>
      <div className={styles.brandingRow}>
        <div className={styles.brandingCopy}>
          <strong>{t('brandingTitle')}</strong>
          <span>{t('brandingDescription')}</span>
        </div>
        <button
          type="button"
          className={styles.switch}
          role="switch"
          aria-label={t('brandingToggle')}
          aria-checked={branding.enabled}
          data-checked={branding.enabled}
          onClick={() => { setWanxiangBrandEnabled(!branding.enabled) }}
        >
          <span />
        </button>
      </div>
      <PublishDefaults t={t} />
      <WorkspaceLimitsPanel t={t} />
      <dl className={styles.details}>
        <div className={styles.detailRow}>
          <dt>{t('identityLabel')}</dt>
          <dd>{t('identityValue')}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('toolsLabel')}</dt>
          <dd>{t('toolsValue')}</dd>
        </div>
      </dl>
    </section>
  )
}


/** What the publish panel knows about this workspace. */
type PublishState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: ModelSyncStatus }
  | { kind: 'failed' }

/**
 * Publish this workspace's configuration as the default other users start from.
 *
 * One action rather than a set of controls: the configuration is whatever this workspace already
 * holds -- the models, the permission default, the general settings -- and the button copies it to
 * DataOps. Every other user's workspace takes that copy as its starting values and may then change
 * anything, at which point their own version wins and this button never reaches it again.
 * @param props - Translate function from the section.
 * @returns The publish row.
 */
function PublishDefaults({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<PublishState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const status = await fetchModelSyncStatus()
      setState(status === null ? { kind: 'unavailable' } : { kind: 'ready', status })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const publish = useCallback(async () => {
    setBusy(true)
    try {
      const status = await postModelSyncAction({ action: 'publish-defaults' })
      if (status !== null) setState({ kind: 'ready', status })
    } catch {
      setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [])

  if (state.kind === 'loading') return null
  if (state.kind === 'unavailable' || state.kind === 'failed') {
    return (
      <div className={styles.modelPanel}>
        <h3 className={styles.modelTitle}>{t('defaultsTitle')}</h3>
        <p className={styles.modelDescription} role={state.kind === 'failed' ? 'alert' : undefined}>
          {state.kind === 'failed' ? t('loadFailed') : t('modelsUnavailable')}
        </p>
      </div>
    )
  }

  const { status } = state
  // A viewer DataOps does not authorize to publish sees the same explanation without the button,
  // because the permission rule lives in DataOps and the browser must not restate it.
  if (!status.canPublish) {
    return (
      <div className={styles.modelPanel}>
        <h3 className={styles.modelTitle}>{t('defaultsTitle')}</h3>
        <p className={styles.modelDescription}>{t('defaultsNotAdmin')}</p>
      </div>
    )
  }

  return (
    <div className={styles.modelPanel}>
      <h3 className={styles.modelTitle}>{t('defaultsTitle')}</h3>
      <p className={styles.modelDescription}>{t('defaultsDescription')}</p>
      <div className={styles.brandingRow}>
        <div className={styles.brandingCopy}>
          <strong>{t('defaultsActionTitle')}</strong>
          <span>
            {status.publishedAt === null
              ? t('defaultsNeverPublished')
              : t('defaultsPublishedAt') + ' ' + status.publishedAt}
          </span>
        </div>
        <button
          type="button"
          className={styles.modelAction}
          disabled={busy}
          onClick={() => { void publish() }}
        >
          {busy ? t('defaultsPublishing') : t('defaultsPublish')}
        </button>
      </div>
    </div>
  )
}

/** What the limits panel knows. */
type LimitsState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: WorkspaceLimitsStatus }
  | { kind: 'failed' }

/** The panel's unit, so a stored byte count survives a round trip through the input. */
const BYTES_PER_MIB = 1024 * 1024

/** Render a byte ceiling as the whole MiB the input shows. */
function toMib(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MIB) * 100) / 100)
}

/**
 * Read and change the file-size ceilings DataOps enforces on this workspace.
 *
 * The values live in DataOps and are read through the plugin, which holds the JWT; the panel only
 * ever holds what the administrator is allowed to see.
 * @param props - Translate function from the section.
 * @returns The limits panel.
 */
function WorkspaceLimitsPanel({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<LimitsState>({ kind: 'loading' })
  const [fileReadMib, setFileReadMib] = useState('')
  const [uploadMib, setUploadMib] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = useCallback((status: WorkspaceLimitsStatus) => {
    setState({ kind: 'ready', status })
    setFileReadMib(toMib(status.limits.fileReadMaxBytes))
    setUploadMib(toMib(status.limits.uploadMaxBytes))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const status = await fetchWorkspaceLimits()
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status)
    } catch {
      setState({ kind: 'failed' })
    }
  }, [apply])

  useEffect(() => { void refresh() }, [refresh])

  const submit = useCallback(async () => {
    const fileReadMaxBytes = Math.round(Number(fileReadMib) * BYTES_PER_MIB)
    const uploadMaxBytes = Math.round(Number(uploadMib) * BYTES_PER_MIB)
    if (!Number.isSafeInteger(fileReadMaxBytes) || fileReadMaxBytes <= 0) return
    if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes <= 0) return
    setBusy(true)
    try {
      const limits: WorkspaceLimits = { fileReadMaxBytes, uploadMaxBytes }
      const status = await saveWorkspaceLimits(limits)
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status)
    } catch {
      setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [fileReadMib, uploadMib, apply])

  if (state.kind === 'loading') return null
  if (state.kind !== 'ready') {
    return (
      <div className={styles.modelPanel}>
        <h3 className={styles.modelTitle}>{t('limitsTitle')}</h3>
        <p className={styles.modelDescription} role={state.kind === 'failed' ? 'alert' : undefined}>
          {state.kind === 'failed' ? t('loadFailed') : t('limitsUnavailable')}
        </p>
      </div>
    )
  }

  return (
    <div className={styles.modelPanel}>
      <h3 className={styles.modelTitle}>{t('limitsTitle')}</h3>
      <p className={styles.modelDescription}>{t('limitsDescription')}</p>
      <div className={styles.details}>
        <label className={styles.detailRow}>
          <span>{t('limitsFileReadLabel')}</span>
          <input
            className={styles.limitsInput}
            type="number"
            min="1"
            step="1"
            aria-label={t('limitsFileReadLabel')}
            value={fileReadMib}
            disabled={busy || !state.status.canWrite}
            onChange={event => { setFileReadMib(event.target.value) }}
          />
        </label>
        <label className={styles.detailRow}>
          <span>{t('limitsUploadLabel')}</span>
          <input
            className={styles.limitsInput}
            type="number"
            min="1"
            step="1"
            aria-label={t('limitsUploadLabel')}
            value={uploadMib}
            disabled={busy || !state.status.canWrite}
            onChange={event => { setUploadMib(event.target.value) }}
          />
        </label>
      </div>
      <div className={styles.brandingRow}>
        <span className={styles.modelDescription}>{t('limitsUnit')}</span>
        <button
          type="button"
          className={styles.modelAction}
          disabled={busy || !state.status.canWrite}
          onClick={() => { void submit() }}
        >
          {busy ? t('limitsSaving') : t('limitsSave')}
        </button>
      </div>
    </div>
  )
}

/** Re-exported so the settings entry can be discovered from the section alone. */
export { MODEL_SYNC_PATH }
