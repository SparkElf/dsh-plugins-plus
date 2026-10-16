import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  KB_API,
  kbApiPath,
  type DeployHostView,
  type DeployRunView,
  type DeployStepView,
  type GrantView,
  type KnowledgeConfigView,
  type KnowledgeStatusView,
} from '../api.ts'
import type { en } from './locales.ts'
import styles from './KnowledgeSettingsSection.module.css'

/** Values injected by the DSH Settings slot. */
export interface KnowledgeSettingsInjected {
  /** Translate one knowledge-base message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the injected Settings section. */
export type KnowledgeSettingsProps = Partial<InjectFace<KnowledgeSettingsInjected>>

/** Distinguish the states the panel must render differently. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: KnowledgeConfigView; status: KnowledgeStatusView; grants: GrantView[] }
  | { kind: 'unavailable' }

/** POST one JSON method and decode the reply. */
async function postJson<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const decoded = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(decoded.error ?? `HTTP ${String(response.status)}`)
  return decoded
}

/**
 * Render the knowledge-base connection, resolved paths, status, the read-only
 * authorization summary, and the deployment wizard.
 *
 * Authorization itself is deliberately absent: DataOps owns grants, and this
 * panel only reports what the backend says (AGENTS.md "Managed DataOps
 * Authorization" forbids replicating that policy in a plugin).
 *
 * @param props - Settings slot injection values.
 * @returns The localized Settings section, or nothing before injection.
 */
export function KnowledgeSettingsSection(props: KnowledgeSettingsProps) {
  const { t } = props
  if (t === undefined) return null
  return <Loaded t={t} />
}

function Loaded({ t }: { t: KnowledgeSettingsInjected['t'] }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const config = await postJson<KnowledgeConfigView>(KB_API.config)
      const status = await postJson<KnowledgeStatusView>(KB_API.status)
      const grantsReply = await postJson<{ grants: GrantView[] }>(KB_API.grants)
      setState({ kind: 'ready', config, status, grants: grantsReply.grants })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const buildIndex = useCallback(async () => {
    setBusy(true)
    setNotice(undefined)
    try {
      await postJson(KB_API.index)
      setNotice(t('indexStarted'))
    } catch {
      setNotice(t('indexFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  if (state.kind === 'loading') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.detail}>{t('loading')}</p>
      </section>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <div className={styles.statusRow}>
          <StateDot state="error" />
          <span className={styles.statusLabel} role="alert">{t('unavailable')}</span>
        </div>
        <p className={styles.detail}>{t('unavailableDetail')}</p>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      </section>
    )
  }

  const { config, status, grants } = state

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>

      <div className={styles.body}>
        <p className={styles.description}>{t('description')}</p>

        <h3 className={styles.groupTitle}>{t('connection')}</h3>
        <dl className={styles.pairs}>
          <div className={styles.pair}>
            <dt>{t('host')}</dt>
            <dd>{config.host === '' ? t('backendUnset') : config.host}</dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('actualRoot')}</dt>
            <dd><code>{config.actualRoot}</code></dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('viewRoot')}</dt>
            <dd><code>{config.viewRoot}</code></dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('mountPoint')}</dt>
            <dd><code>{config.mountPoint}</code></dd>
          </div>
        </dl>
        {config.backendError !== undefined && (
          <p className={styles.detail} role="status">
            {t('backendError')} {config.backendError.message}
          </p>
        )}

        <DeploymentWizard t={t} />

        <h3 className={styles.groupTitle}>{t('status')}</h3>
        <div className={styles.statusRow}>
          <StateDot state={status.indexing.running ? 'ongoing' : 'done'} />
          <span className={styles.statusLabel}>
            {status.indexing.running ? t('indexing') : t('idle')}
          </span>
        </div>
        <dl className={styles.pairs}>
          <div className={styles.pair}>
            <dt>{t('visibleFiles')}</dt>
            <dd>{status.visibleFiles === null ? t('unknown') : String(status.visibleFiles)}</dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('lastSync')}</dt>
            <dd>{status.lastSyncAt ?? t('neverSynced')}</dd>
          </div>
        </dl>

        <h3 className={styles.groupTitle}>{t('grants')}</h3>
        <p className={styles.detail}>
          {t('grantsManaged')}{' '}<span className={styles.readOnly}>{t('readOnly')}</span>
        </p>
        {grants.length === 0
          ? <p className={styles.detail}>{t('grantsEmpty')}</p>
          : (
            <ul className={styles.grants}>
              {grants.map(grant => (
                <li key={grant.id}>
                  <code>{grant.relPath}</code>
                  <span className={styles.grantMeta}>{grant.kind} · {grant.grantedBy}</span>
                </li>
              ))}
            </ul>
          )}

        {notice !== undefined && <p className={styles.notice} role="status">{notice}</p>}

        <div className={styles.actions}>
          <Button variant="primary" disabled={busy} onClick={() => { void buildIndex() }}>
            {t('buildIndex')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => { void load() }}>
            {t('refresh')}
          </Button>
        </div>
      </div>
    </section>
  )
}

/**
 * The deployment wizard.
 *
 * Every step is idempotent on the Host side, so a button is safe to press
 * repeatedly; the panel only mirrors what the Host reports and never assembles
 * shell commands itself. The Host resolves a step's commands from its own
 * configuration, so the browser cannot choose what runs.
 */
function DeploymentWizard({ t }: { t: KnowledgeSettingsInjected['t'] }) {
  const [hosts, setHosts] = useState<DeployHostView[]>([])
  const [hostId, setHostId] = useState('')
  const [steps, setSteps] = useState<DeployStepView[]>([])
  const [run, setRun] = useState<DeployRunView | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [hostsError, setHostsError] = useState<string | undefined>(undefined)

  const loadHosts = useCallback(async () => {
    try {
      const reply = await postJson<{ hosts: DeployHostView[]; error?: { message: string } }>(KB_API.deployHosts)
      setHosts(reply.hosts)
      setHostsError(reply.error?.message)
      setHostId(current => (current !== '' ? current : (reply.hosts[0]?.id ?? '')))
    } catch (error) {
      setHostsError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const loadSteps = useCallback(async () => {
    const reply = await postJson<{ steps: DeployStepView[] }>(KB_API.deploySteps)
    setSteps(reply.steps)
  }, [])

  useEffect(() => { void loadHosts(); void loadSteps() }, [loadHosts, loadSteps])

  const runStep = useCallback(async (stepId: string) => {
    if (hostId === '') return
    setRunning(true)
    setRun(undefined)
    try {
      // The Host runs every command of the step before replying, so the reply
      // is already the finished record; no polling is needed.
      setRun(await postJson<DeployRunView>(KB_API.deployRun, { stepId, hostId }))
    } catch (error) {
      const now = new Date().toISOString()
      setRun({
        stepId,
        hostId,
        state: 'failed',
        startedAt: now,
        finishedAt: now,
        log: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      setRunning(false)
    }
  }, [hostId])

  const selectedHost = hosts.find(host => host.id === hostId)

  return (
    <div className={styles.wizard}>
      <h3 className={styles.groupTitle}>{t('deploy')}</h3>
      <p className={styles.detail}>{t('deployIntro')}</p>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="kb-deploy-host">{t('deployHost')}</label>
        <select
          id="kb-deploy-host"
          className={styles.select}
          value={hostId}
          onChange={event => { setHostId(event.target.value) }}
        >
          {hosts.length === 0 && <option value="">{t('deployNoHosts')}</option>}
          {hosts.map(host => (
            <option key={host.id} value={host.id}>
              {host.name} ({host.username}@{host.hostname}:{String(host.port)})
            </option>
          ))}
        </select>
      </div>

      {hostsError !== undefined && (
        <p className={styles.detail} role="status">{t('deployHostsError')} {hostsError}</p>
      )}
      {selectedHost !== undefined && !selectedHost.credentialConfigured && (
        <p className={styles.detail} role="status">{t('deployNoCredential')}</p>
      )}

      <ul className={styles.steps}>
        {steps.map(step => (
          <li key={step.id} className={styles.step}>
            <span className={styles.stepLabel}>{t(`step.${step.id}` as keyof typeof en)}</span>
            <Button
              variant="outline"
              disabled={running || hostId === ''}
              onClick={() => { void runStep(step.id) }}
            >
              {running ? t('deployRunning') : t('deployRun')}
            </Button>
          </li>
        ))}
      </ul>

      {run !== undefined && (
        <div className={styles.logBox}>
          <div className={styles.statusRow}>
            <StateDot state={run.state === 'succeeded' ? 'done' : run.state === 'failed' ? 'error' : 'ongoing'} />
            <span className={styles.statusLabel}>
              {run.state === 'succeeded'
                ? t('deploySucceeded')
                : run.state === 'failed' ? t('deployFailed') : t('deployRunning')}
            </span>
          </div>
          <pre className={styles.log}>{run.log.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
