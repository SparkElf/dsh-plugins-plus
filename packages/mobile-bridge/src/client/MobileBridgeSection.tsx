/** Mobile Bridge settings section: connection state, configuration, and pairing QR. */

import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import QRCode from 'qrcode/lib/browser.js'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract.ts'
import css from './MobileBridgeSection.module.css'

/** Settings values owned by the Host plugin namespace. */
export interface MobileBridgeValues {
  serverUrl: string
  localPort: number
  userKey: string
  ownerEmail: string
  emailTwoFactor: boolean
  autoConnect: boolean
}

/** Current Host connection and pairing projection. */
export interface MobileBridgeStatus {
  connected: boolean
  qrUrl: string
}

/** Registration-side operations supplied by the Client plugin apply closure. */
export interface MobileBridgeSectionInjected {
  loadValues(): Promise<MobileBridgeValues>
  saveValues(values: MobileBridgeValues): Promise<void>
  loadStatus(): Promise<MobileBridgeStatus>
}

/** Full settings component props derived from the public Slot shares. */
export type MobileBridgeSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settingsMobileBridge'>
  & InjectFace<MobileBridgeSectionInjected>

const DEFAULTS: MobileBridgeValues = {
  serverUrl: '',
  localPort: 3080,
  userKey: '',
  ownerEmail: '',
  emailTwoFactor: false,
  autoConnect: true,
}

/** Render and operate the Mobile Bridge settings page. */
export function MobileBridgeSection(props: MobileBridgeSectionProps): ReactNode {
  const { loadStatus, loadValues, saveValues, t } = props
  const [values, setValues] = useState(DEFAULTS)
  const [status, setStatus] = useState<MobileBridgeStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [qrSource, setQrSource] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([loadValues(), loadStatus()]).then(([nextValues, nextStatus]) => {
      if (!live) return
      setValues(nextValues)
      setStatus(nextStatus)
      setLoaded(true)
    }).catch((caught: unknown) => {
      console.error('[dsh-mobile-bridge] settings load failed', caught)
      if (live) setError(t('loadFailed'))
    })
    return () => { live = false }
  }, [loadStatus, loadValues, t])

  useEffect(() => {
    const qrUrl = status?.qrUrl ?? ''
    if (qrUrl === '') {
      setQrSource(null)
      return
    }
    let live = true
    setQrSource(null)
    void QRCode.toDataURL(qrUrl, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' },
    }).then(source => {
      if (live) setQrSource(source)
    }).catch((caught: unknown) => {
      console.error('[dsh-mobile-bridge] pairing QR generation failed', caught)
      if (live) setError(t('qrFailed'))
    })
    return () => { live = false }
  }, [status?.qrUrl, t])

  const set = <K extends keyof MobileBridgeValues>(key: K, value: MobileBridgeValues[K]): void => {
    setValues(current => ({ ...current, [key]: value }))
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      await saveValues(values)
      setMessage(t('saved'))
    } catch (caught) {
      console.error('[dsh-mobile-bridge] settings save failed', caught)
      setError(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const statusLabel = status === null ? t('loading') : status.connected ? t('connected') : t('disconnected')

  return (
    <section className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.description}>{t('description')}</p>
      </header>
      <form className={css.form} onSubmit={event => { void save(event) }}>
        <div className={css.row}>
          <span className={css.label}>{t('status')}</span>
          <span className={status?.connected === true ? `${css.badge} ${css.badgeConnected}` : css.badge} role="status">{statusLabel}</span>
        </div>
        <label className={css.row} htmlFor="dshmb-server-url">
          <span className={css.fieldCopy}><span className={css.label}>{t('serverUrl')}</span><span className={css.hint}>{t('serverUrlHint')}</span></span>
          <input id="dshmb-server-url" className={css.input} type="url" value={values.serverUrl} disabled={!loaded || saving} onChange={event => set('serverUrl', event.currentTarget.value)} />
        </label>
        <label className={css.row} htmlFor="dshmb-local-port">
          <span className={css.fieldCopy}><span className={css.label}>{t('localPort')}</span><span className={css.hint}>{t('localPortHint')}</span></span>
          <input id="dshmb-local-port" className={css.input} type="number" min={1} step={1} value={values.localPort} disabled={!loaded || saving} onChange={event => set('localPort', event.currentTarget.valueAsNumber)} />
        </label>
        <label className={css.row} htmlFor="dshmb-user-key">
          <span className={css.fieldCopy}><span className={css.label}>{t('userKey')}</span><span className={css.hint}>{t('userKeyHint')}</span></span>
          <input id="dshmb-user-key" className={css.input} type="password" value={values.userKey} disabled={!loaded || saving} onChange={event => set('userKey', event.currentTarget.value)} />
        </label>
        <label className={css.row} htmlFor="dshmb-owner-email">
          <span className={css.fieldCopy}><span className={css.label}>{t('ownerEmail')}</span><span className={css.hint}>{t('ownerEmailHint')}</span></span>
          <input id="dshmb-owner-email" className={css.input} type="email" value={values.ownerEmail} disabled={!loaded || saving} onChange={event => set('ownerEmail', event.currentTarget.value)} />
        </label>
        <label className={css.row} htmlFor="dshmb-email-two-factor">
          <span className={css.label}>{t('twoFactor')}</span>
          <input id="dshmb-email-two-factor" className={css.check} type="checkbox" checked={values.emailTwoFactor} disabled={!loaded || saving} onChange={event => set('emailTwoFactor', event.currentTarget.checked)} />
        </label>
        <label className={css.row} htmlFor="dshmb-auto-connect">
          <span className={css.label}>{t('autoConnect')}</span>
          <input id="dshmb-auto-connect" className={css.check} type="checkbox" checked={values.autoConnect} disabled={!loaded || saving} onChange={event => set('autoConnect', event.currentTarget.checked)} />
        </label>
        <div className={css.row}>
          <span className={css.fieldCopy}><span className={css.label}>{t('pair')}</span><span className={css.hint}>{t('pairHint')}</span></span>
          {qrSource === null ? <span className={css.qrEmpty}>{t('qrUnavailable')}</span> : <img className={css.qr} src={qrSource} alt={t('qrAlt')} width={180} height={180} />}
        </div>
        <div className={css.actions}>
          <button className={css.save} type="submit" disabled={!loaded || saving}>{saving ? t('saving') : t('save')}</button>
          {message !== null ? <p className={css.message} role="status">{message}</p> : null}
        </div>
      </form>
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
    </section>
  )
}
