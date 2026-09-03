import { useSyncExternalStore } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { setWanxiangBrandEnabled, wanxiangBrandPreference } from './brand-store.ts'
import styles from './ManagedDataOpsSection.module.css'

/** Values injected by the DSH Settings slot. */
export interface ManagedDataOpsSectionInjected {
  /** Translate one managed DataOps Settings message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the managed DataOps Settings section. */
export type ManagedDataOpsSectionProps = Partial<InjectFace<ManagedDataOpsSectionInjected>>

/**
 * Explain the DataOps-managed JWT and permission owner without standalone controls.
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
