import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
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
  if (t === undefined) return null

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <div className={styles.statusRow}>
        <StateDot state="done" />
        <strong>{t('managed')}</strong>
      </div>
      <p className={styles.description}>{t('description')}</p>
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
