/** Mobile Bridge settings section: connection state, configuration, and pairing QR. */

import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import QRCode from 'qrcode/lib/browser.js'
import { Button, Input, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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
  paired: boolean
  qrUrl: string
  qrRefreshAt: number
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

function SettingsLabel({ label, hint }: { label: string; hint: string }): ReactNode {
  return (
    <Tooltip label={hint} side="bottom" delayMs={300}>
      <span className={css.label} tabIndex={0}>{label}</span>
    </Tooltip>
  )
}

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
  const [refreshing, setRefreshing] = useState(false)
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
    const refreshAt = status?.qrRefreshAt ?? 0
    if (status?.paired === true || refreshAt <= 0) return
    let live = true
    const timer = setTimeout(() => {
      void loadStatus().then(nextStatus => {
        if (live) setStatus(nextStatus)
      }).catch((caught: unknown) => {
        console.error('[dsh-mobile-bridge] scheduled status refresh failed', caught)
        if (live) setError(t('statusFailed'))
      })
    }, Math.max(0, refreshAt - Date.now() + 750))
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [loadStatus, status?.paired, status?.qrRefreshAt, t])

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

  const refreshStatus = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      setStatus(await loadStatus())
    } catch (caught) {
      console.error('[dsh-mobile-bridge] status refresh failed', caught)
      setError(t('statusFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      await saveValues(values)
      setMessage(t('saved'))
      void refreshStatus()
    } catch (caught) {
      console.error('[dsh-mobile-bridge] settings save failed', caught)
      setError(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const statusLabel = status === null ? t('loading') : status.connected ? t('connected') : t('disconnected')
  const statusState = refreshing || status === null ? 'ongoing' : status.connected ? 'done' : 'warning'

  return (
    <section className={css.section}>
      <header className={css.header}>
        <Tooltip label={t('description')} side="bottom" delayMs={300}>
          <h2 className={css.title} tabIndex={0}>{t('title')}</h2>
        </Tooltip>
        <div className={css.toolbar}>
          <span className={css.status} role="status"><StateDot state={statusState} />{statusLabel}</span>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => { void refreshStatus() }}>{refreshing ? t('refreshing') : t('refresh')}</Button>
        </div>
      </header>
      <form className={css.form} onSubmit={event => { void save(event) }}>
        <div className={css.fields}>
          <label className={`${css.field} ${css.fieldWide}`} htmlFor="dshmb-server-url">
            <SettingsLabel label={t('serverUrl')} hint={t('serverUrlHint')} />
            <Input id="dshmb-server-url" className={css.control} type="url" value={values.serverUrl} disabled={!loaded || saving} onChange={event => set('serverUrl', event.currentTarget.value)} />
          </label>
          <label className={css.field} htmlFor="dshmb-local-port">
            <SettingsLabel label={t('localPort')} hint={t('localPortHint')} />
            <Input id="dshmb-local-port" className={css.control} type="number" min={1} step={1} value={values.localPort} disabled={!loaded || saving} onChange={event => set('localPort', event.currentTarget.valueAsNumber)} />
          </label>
          <label className={css.field} htmlFor="dshmb-user-key">
            <SettingsLabel label={t('userKey')} hint={t('userKeyHint')} />
            <Input id="dshmb-user-key" className={css.control} type="password" value={values.userKey} disabled={!loaded || saving} onChange={event => set('userKey', event.currentTarget.value)} />
          </label>
          <label className={`${css.field} ${css.fieldWide}`} htmlFor="dshmb-owner-email">
            <SettingsLabel label={t('ownerEmail')} hint={t('ownerEmailHint')} />
            <Input id="dshmb-owner-email" className={css.control} type="email" value={values.ownerEmail} disabled={!loaded || saving} onChange={event => set('ownerEmail', event.currentTarget.value)} />
          </label>
        </div>
        <div className={css.toggles}>
          <label className={css.toggle} htmlFor="dshmb-email-two-factor">
            <input id="dshmb-email-two-factor" className={css.checkbox} type="checkbox" checked={values.emailTwoFactor} disabled={!loaded || saving} onChange={event => set('emailTwoFactor', event.currentTarget.checked)} />
            <span>{t('twoFactor')}</span>
          </label>
          <label className={css.toggle} htmlFor="dshmb-auto-connect">
            <input id="dshmb-auto-connect" className={css.checkbox} type="checkbox" checked={values.autoConnect} disabled={!loaded || saving} onChange={event => set('autoConnect', event.currentTarget.checked)} />
            <span>{t('autoConnect')}</span>
          </label>
        </div>
        <div className={css.pairing}>
          <SettingsLabel label={t('pair')} hint={t('pairHint')} />
          {qrSource === null ? <span className={css.qrEmpty}>{status?.paired === true ? t('paired') : t('qrUnavailable')}</span> : <img className={css.qr} src={qrSource} alt={t('qrAlt')} width={180} height={180} />}
        </div>
        <div className={css.actions}>
          {message !== null ? <p className={css.message} role="status">{message}</p> : null}
          <Button variant="primary" type="submit" disabled={!loaded || saving}>{saving ? t('saving') : t('save')}</Button>
        </div>
      </form>
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
    </section>
  )
}
