import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { setWanxiangBrandEnabled, wanxiangBrandPreference } from './brand-store.ts'
import { MODEL_SYNC_PATH, fetchModelSyncStatus, postModelSyncAction } from './model-sync-client.ts'
import type { ModelSyncStatus } from './model-sync-client.ts'
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
      <ModelSharing t={t} />
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

/** What the sharing panel knows about this workspace. */
type SharingState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: ModelSyncStatus }
  | { kind: 'failed' }

/**
 * Share this workspace's models, and choose which of them other users may use.
 *
 * The panel shows the sharing control to an administrator alone, and tells every other user
 * which configuration their workspace is using, including how to stop following it. Nothing
 * here decides permissions: DataOps reports who may publish.
 * @param props - Translate function from the section.
 * @returns The sharing panel.
 */
function ModelSharing({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<SharingState>({ kind: 'loading' })
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

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const status = await postModelSyncAction(body)
      if (status !== null) setState({ kind: 'ready', status })
    } catch {
      setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [])

  if (state.kind === 'loading') return null
  if (state.kind === 'unavailable') {
    return (
      <div className={styles.modelPanel}>
        <h3 className={styles.modelTitle}>{t('modelsTitle')}</h3>
        <p className={styles.modelDescription}>{t('modelsUnavailable')}</p>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className={styles.modelPanel}>
        <h3 className={styles.modelTitle}>{t('modelsTitle')}</h3>
        <p className={styles.modelDescription} role="alert">{t('loadFailed')}</p>
      </div>
    )
  }

  const { status } = state
  const following = status.followState === 'following'
  return (
    <div className={styles.modelPanel}>
      <h3 className={styles.modelTitle}>{t('modelsTitle')}</h3>
      <p className={styles.modelDescription}>{t('modelsDescription')}</p>

      {status.canPublish ? (
        <>
          <div className={styles.brandingRow}>
            <div className={styles.brandingCopy}>
              <strong>{t('syncTitle')}</strong>
              <span>{t('syncDescription')}</span>
            </div>
            <button
              type="button"
              className={styles.switch}
              role="switch"
              aria-label={t('syncToggle')}
              aria-checked={status.publisherSharing}
              data-checked={status.publisherSharing}
              disabled={busy}
              onClick={() => { void act({ action: 'publish', sharingEnabled: !status.publisherSharing }) }}
            >
              <span />
            </button>
          </div>
          {status.publisherSharing && status.models.length > 0 ? (
            <div className={styles.modelList}>
              <strong className={styles.modelListTitle}>{t('modelsListTitle')}</strong>
              <span className={styles.modelListDescription}>{t('modelsListDescription')}</span>
              {status.models.map((model) => (
                <div className={styles.modelRow} key={model.id}>
                  <code className={styles.modelId}>{model.id}</code>
                  <button
                    type="button"
                    className={styles.switch}
                    role="switch"
                    aria-label={t('modelShareLabel') + ': ' + model.id}
                    aria-checked={model.shared}
                    data-checked={model.shared}
                    disabled={busy}
                    onClick={() => {
                      const next = model.shared
                        ? [...status.privateModelIds, model.id]
                        : status.privateModelIds.filter((id) => id !== model.id)
                      void act({ action: 'private-models', privateModelIds: next, sharingEnabled: true })
                    }}
                  >
                    <span />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {status.publisherSharing && status.models.length === 0 ? (
            <p className={styles.modelDescription}>{t('modelsEmpty')}</p>
          ) : null}
        </>
      ) : (
        <div className={styles.brandingRow}>
          <div className={styles.brandingCopy}>
            <strong>{following ? t('followTitle') : t('detachedTitle')}</strong>
            <span>{following && !status.publisherSharing ? t('noPublisher') : (following ? t('followDescription') : t('detachedDescription'))}</span>
          </div>
          {following ? null : (
            <button
              type="button"
              className={styles.modelAction}
              disabled={busy}
              onClick={() => { void act({ action: 'resume' }) }}
            >
              {busy ? t('resuming') : t('resume')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Re-exported so the settings entry can be discovered from the section alone. */
export { MODEL_SYNC_PATH }
