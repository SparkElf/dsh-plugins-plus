/** Mobile Bridge settings section: connection state, configuration, and pairing QR. */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import QRCode from 'qrcode/lib/browser.js'
import { Button, IconStopFill16, Input, Modal, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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
  sessionDays: number
  autoConnect: boolean
}

/** One phone device projected by the Host. */
export interface MobileBridgeDevice {
  id: string
  bridgeId: string
  name: string
  ip: string
  pairedAt: number
  lastSeenAt: number
  online: boolean
}

/** Current Host connection, pairing ticket, and device projection. */
export interface MobileBridgeStatus {
  connected: boolean
  qrUrl: string
  pairingCode: string
  pairingRefreshing: boolean
  devices: MobileBridgeDevice[]
}

/** Registration-side operations supplied by the Client plugin apply closure. */
export interface MobileBridgeSectionInjected {
  loadValues(): Promise<MobileBridgeValues>
  saveValues(values: MobileBridgeValues): Promise<void>
  loadStatus(): Promise<MobileBridgeStatus>
  subscribeStatus(listener: (status: MobileBridgeStatus) => void): () => void
  disconnectDevice(deviceId: string): Promise<MobileBridgeStatus>
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

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const DEFAULTS: MobileBridgeValues = {
  serverUrl: '',
  localPort: 3080,
  userKey: '',
  ownerEmail: '',
  emailTwoFactor: false,
  sessionDays: 7,
  autoConnect: true,
}

/** Render and operate the Mobile Bridge settings page. */
export function MobileBridgeSection(props: MobileBridgeSectionProps): ReactNode {
  const { disconnectDevice, loadStatus, loadValues, saveValues, subscribeStatus, t } = props
  const [values, setValues] = useState(DEFAULTS)
  const [status, setStatus] = useState<MobileBridgeStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [qrSource, setQrSource] = useState<{ url: string; source: string } | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<MobileBridgeDevice | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const saveRefresh = useRef<AbortController | null>(null)

  useEffect(() => () => {
    const controller = saveRefresh.current
    saveRefresh.current = null
    controller?.abort()
  }, [])

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
    if (!loaded) return
    return subscribeStatus(nextStatus => {
      setStatus(nextStatus)
      setError(null)
    })
  }, [loaded, subscribeStatus])

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
      if (live) setQrSource({ url: qrUrl, source })
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

  const confirmFreshStatus = async (previousQrUrl: string, expectQr: boolean, signal: AbortSignal): Promise<boolean> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (signal.aborted) return false
      const nextStatus = await loadStatus()
      if (signal.aborted) return false
      setStatus(nextStatus)
      if (!expectQr || (nextStatus.connected && nextStatus.qrUrl !== '' && nextStatus.qrUrl !== previousQrUrl && /^[0-9a-f]{6}$/i.test(nextStatus.pairingCode))) return true
      if (attempt < 19) await waitForDelay(500, signal)
    }
    return false
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    saveRefresh.current?.abort()
    const controller = new AbortController()
    saveRefresh.current = controller
    const previousQrUrl = status?.qrUrl ?? ''
    const expectQr = values.autoConnect && values.serverUrl.trim() !== ''
    let persisted = false
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      await saveValues(values)
      persisted = true
      if (expectQr) setStatus(current => current === null ? current : { ...current, connected: false, qrUrl: '', pairingCode: '', pairingRefreshing: true })
      const ready = await confirmFreshStatus(previousQrUrl, expectQr, controller.signal)
      if (controller.signal.aborted) return
      if (!ready) {
        setError(t('reconnectFailed'))
        return
      }
      setMessage(t('saved'))
    } catch (caught) {
      console.error('[dsh-mobile-bridge] settings save confirmation failed', caught)
      if (!controller.signal.aborted) setError(t(persisted ? 'reconnectFailed' : 'saveFailed'))
    } finally {
      if (saveRefresh.current === controller) {
        saveRefresh.current = null
        setSaving(false)
      }
    }
  }

  const confirmDisconnect = async (): Promise<void> => {
    if (disconnectTarget === null) return
    setDisconnecting(true)
    setMessage(null)
    setError(null)
    try {
      setStatus(await disconnectDevice(disconnectTarget.id))
      setDisconnectTarget(null)
      setMessage(t('deviceDisconnected'))
    } catch (caught) {
      console.error('[dsh-mobile-bridge] device disconnect failed', caught)
      setError(t('deviceDisconnectFailed'))
    } finally {
      setDisconnecting(false)
    }
  }

  const statusLabel = status === null ? t('loading') : status.connected ? t('connected') : t('disconnected')
  const statusState = refreshing || status === null ? 'ongoing' : status.connected ? 'done' : 'warning'
  const currentQrSource = status !== null && qrSource?.url === status.qrUrl ? qrSource.source : null
  const pairingRefreshing = status !== null && (status.pairingRefreshing || (status.qrUrl !== '' && currentQrSource === null))

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
          <label className={css.field} htmlFor="dshmb-session-days">
            <SettingsLabel label={t('sessionDays')} hint={t('sessionDaysHint')} />
            <Input id="dshmb-session-days" className={css.control} type="number" min={1} max={365} step={1} value={values.sessionDays} disabled={!loaded || saving} onChange={event => set('sessionDays', event.currentTarget.valueAsNumber)} />
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
        <div className={css.actions}>
          {message !== null ? <p className={css.message} role="status">{message}</p> : null}
          <Button variant="primary" type="submit" disabled={!loaded || saving}>{saving ? t('saving') : t('save')}</Button>
        </div>
      </form>

      <div className={css.pairing}>
        <SettingsLabel label={t('pair')} hint={t('pairHint')} />
        {pairingRefreshing
          ? (
              <div className={css.qrRefreshing} role="status">
                <span className={css.qrSpinner} aria-hidden="true" />
                <span>{t('pairingRefreshing')}</span>
              </div>
            )
          : currentQrSource === null
            ? <span className={css.qrEmpty}>{t('qrUnavailable')}</span>
            : (
                <div className={css.pairingDisplay}>
                  <img className={css.qr} src={currentQrSource} alt={t('qrAlt')} width={180} height={180} />
                  <div className={css.pairingCodeBlock}>
                    <span className={css.label}>{t('pairingCode')}</span>
                    <output className={css.pairingCode} aria-label={t('pairingCode')}>
                      {status?.pairingCode.toUpperCase().split('').map((character, index) => <span key={index}>{character}</span>)}
                    </output>
                  </div>
                </div>
              )}
      </div>

      <div className={css.devices}>
        <div className={css.devicesHeader}>
          <SettingsLabel label={t('devices')} hint={t('devicesHint')} />
          <span className={css.deviceCount}>{status?.devices.length ?? 0}</span>
        </div>
        {status !== null && status.devices.length > 0
          ? (
              <ul className={css.deviceList}>
                {status.devices.map(device => (
                  <li className={css.deviceRow} key={device.id}>
                    <span className={css.deviceState}><StateDot state={device.online ? 'done' : 'warning'} />{device.online ? t('online') : t('offline')}</span>
                    <strong className={css.deviceName}>{device.name}</strong>
                    <span className={css.deviceMeta}>IP {device.ip}</span>
                    <span className={css.deviceTimes}><span>{t('pairedAt')} {new Date(device.pairedAt).toLocaleString()}</span><span>{t('lastSeen')} {new Date(device.lastSeenAt).toLocaleString()}</span></span>
                    <Button variant="outline" size="sm" icon={<IconStopFill16 size={14} />} className={css.disconnectButton} onClick={() => { setDisconnectTarget(device) }}>
                      {t('disconnect')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          : <p className={css.deviceEmpty}>{t('noDevices')}</p>}
      </div>

      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      <Modal
        open={disconnectTarget !== null}
        onClose={() => { if (!disconnecting) setDisconnectTarget(null) }}
        title={t('disconnectTitle')}
        footer={(
          <>
            <Button variant="outline" disabled={disconnecting} onClick={() => { setDisconnectTarget(null) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={disconnecting} onClick={() => { void confirmDisconnect() }}>{disconnecting ? t('disconnecting') : t('confirmDisconnect')}</Button>
          </>
        )}
      >
        <p className={css.disconnectDescription}>{t('disconnectDescription')}</p>
      </Modal>
    </section>
  )
}
