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
  type KnowledgeConfigWriteResult,
  type KnowledgeStatusView,
} from '../api.ts'
import { hasDeployTarget } from './deployTarget.ts'
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
 * The storage settings as the reader is editing them.
 *
 * Strings throughout, including the port, because these are bound to inputs: a number input
 * still yields text, and holding a half-typed port as a number would fight the caret.
 */
interface StorageDraft {
  mode: 'local' | 'remote'
  protocol: 'nfs' | 'sshfs'
  nfsServer: string
  sshHost: string
  sshUser: string
  sshPort: string
  sshRemotePath: string
  sshMountOptions: string
  sshKeyRef: string
}

const EMPTY_DRAFT: StorageDraft = {
  mode: 'local',
  protocol: 'nfs',
  nfsServer: '',
  sshHost: '',
  sshUser: '',
  sshPort: '22',
  sshRemotePath: '',
  sshMountOptions: '',
  sshKeyRef: '',
}

/** What a save attempt ended as. */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; restartRequired: boolean; saved: string[] }
  | { kind: 'failed'; message: string }

/** Seed the draft from what the deployment reports. */
function draftOf(config: KnowledgeConfigView, status: KnowledgeStatusView): StorageDraft {
  const ssh = config.ssh
  return {
    mode: status.storageMode === 'remote' ? 'remote' : 'local',
    protocol: status.storageProtocol ?? config.storageProtocol ?? 'nfs',
    nfsServer: config.nfsServer ?? '',
    sshHost: ssh?.host ?? '',
    sshUser: ssh?.user ?? '',
    sshPort: String(ssh?.port ?? 22),
    sshRemotePath: ssh?.remotePath ?? '',
    sshMountOptions: ssh?.mountOptions ?? '',
    sshKeyRef: ssh?.keyRef ?? '',
  }
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
  // 知识库自己的偏好（当前只有 MinerU 地址与 review 开关）与部署配置是两条读路径：
  // 前者是每个 caller 的 view 目录里的文件，后者是部署级配置。分开加载，互不阻塞。
  const [mineru, setMineru] = useState<{ stored: string; canEdit: boolean } | undefined>(undefined)
  const [mineruDraft, setMineruDraft] = useState<string | undefined>(undefined)
  const [mineruBusy, setMineruBusy] = useState(false)
  const [mineruNotice, setMineruNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // What the reader is editing, seeded from the server and saved by an explicit action.
  // Deliberately NOT applied on change: the deployment's storage shape is decided when the
  // workspace container is created, so a radio button that silently rewrote it would be
  // claiming an effect it cannot have. The reader edits, presses save, and is told what the
  // save means for the running deployment.
  const [draft, setDraft] = useState<StorageDraft>(EMPTY_DRAFT)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const config = await postJson<KnowledgeConfigView>(KB_API.config)
      const status = await postJson<KnowledgeStatusView>(KB_API.status)
      const grantsReply = await postJson<{ grants: GrantView[] }>(KB_API.grants)
      setState({ kind: 'ready', config, status, grants: grantsReply.grants })
      // 设置读取失败不能拖垮整个分节：地址是附加配置，读不到就按"未配置"显示，
      // 用户可以照样改存储模式与部署。
      try {
        const reply = await postJson<{ settings?: { mineruBaseUrl?: string }; canEdit?: boolean }>(KB_API.settingsGet)
        setMineru({
          stored: typeof reply.settings?.mineruBaseUrl === 'string' ? reply.settings.mineruBaseUrl : '',
          canEdit: reply.canEdit === true,
        })
        setMineruDraft(undefined)
      } catch {
        setMineru({ stored: '', canEdit: false })
      }
      setDraft(draftOf(config, status))
      setSaveState({ kind: 'idle' })
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

  /**
   * Persist the edited storage settings.
   *
   * A port that is not a number is refused here rather than sent: the server would reject it
   * anyway, and the reader deserves the answer next to the field they typed in.
   */
  const saveStorage = useCallback(async () => {
    setSaveState({ kind: 'saving' })
    const port = Number(draft.sshPort)
    if (draft.protocol === 'sshfs' && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
      setSaveState({ kind: 'failed', message: t('saveBadPort') })
      return
    }
    try {
      const result = await postJson<KnowledgeConfigWriteResult>(KB_API.configSet, {
        storageMode: draft.mode,
        storageProtocol: draft.protocol,
        nfsServer: draft.nfsServer,
        sshHost: draft.sshHost,
        sshUser: draft.sshUser,
        sshPort: draft.protocol === 'sshfs' ? port : 22,
        sshRemotePath: draft.sshRemotePath,
        sshMountOptions: draft.sshMountOptions,
        sshKeyRef: draft.sshKeyRef,
      })
      setSaveState({ kind: 'saved', restartRequired: result.restartRequired, saved: result.saved })
    } catch (error) {
      setSaveState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [draft, t])

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
      </section>
    )
  }

  /**
   * 保存 MinerU 服务地址。
   *
   * review 开关与地址是同一条设置记录，所以一起提交：只发地址会让 Host 认为调用方
   * 要清空 review，只发 review 则会清空地址（Host 侧对缺省字段的处理是"保留原值"，
   * 但这里显式带上更清楚）。保存后重新读回，显示的永远是已存值而不是输入值。
   */
  const saveMineru = async (): Promise<void> => {
    if (mineruDraft === undefined || mineru === undefined) return
    setMineruBusy(true); setMineruNotice(undefined)
    try {
      const reply = await postJson<{ settings?: { mineruBaseUrl?: string } }>(KB_API.settingsSet, {
        reviewRequired: false,
        mineruBaseUrl: mineruDraft,
      })
      setMineru({
        stored: typeof reply.settings?.mineruBaseUrl === 'string' ? reply.settings.mineruBaseUrl : '',
        canEdit: mineru.canEdit,
      })
      setMineruDraft(undefined)
      setMineruNotice(t('settingsSaved'))
    } catch (error: unknown) {
      setMineruNotice(error instanceof Error ? error.message : t('settingsSaveFailed'))
    } finally {
      setMineruBusy(false)
    }
  }

  const { config, status } = state

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>

      <div className={styles.body}>
        <p className={styles.description}>{t('description')}</p>

          {/* Storage: what decides the rest of this section. The reader edits and presses
              save; nothing here is applied on change, because the shape is fixed when the
              workspace container is created. */}
          <h3 className={styles.groupTitle}>{t('storageMode')}</h3>
          <div className={styles.modeRow} role="radiogroup" aria-label={t('storageMode')}>
            <label className={styles.modeOption}>
              <input
                type="radio"
                name="kb-storage-mode"
                value="local"
                checked={draft.mode === 'local'}
                onChange={() => { setDraft(d => ({ ...d, mode: 'local' })); setSaveState({ kind: 'idle' }) }}
              />
              <span>{t('storageModeLocal')}</span>
            </label>
            <label className={styles.modeOption}>
              <input
                type="radio"
                name="kb-storage-mode"
                value="remote"
                checked={draft.mode === 'remote'}
                onChange={() => { setDraft(d => ({ ...d, mode: 'remote' })); setSaveState({ kind: 'idle' }) }}
              />
              <span>{t('storageModeRemote')}</span>
            </label>
          </div>
          <p className={styles.detail}>
            {draft.mode === 'local' ? t('storageModeLocalHint') : t('storageModeRemoteHint')}
          </p>

          {draft.mode === 'remote' && (<>
            {/* The transport decides which fields matter, so it is asked for before them. */}
            <h3 className={styles.groupTitle}>{t('storageProtocol')}</h3>
            <div className={styles.modeRow} role="radiogroup" aria-label={t('storageProtocol')}>
              <label className={styles.modeOption}>
                <input
                  type="radio"
                  name="kb-storage-protocol"
                  value="nfs"
                  checked={draft.protocol === 'nfs'}
                  onChange={() => { setDraft(d => ({ ...d, protocol: 'nfs' })); setSaveState({ kind: 'idle' }) }}
                />
                <span>{t('protocolNfs')}</span>
              </label>
              <label className={styles.modeOption}>
                <input
                  type="radio"
                  name="kb-storage-protocol"
                  value="sshfs"
                  checked={draft.protocol === 'sshfs'}
                  onChange={() => { setDraft(d => ({ ...d, protocol: 'sshfs' })); setSaveState({ kind: 'idle' }) }}
                />
                <span>{t('protocolSshfs')}</span>
              </label>
            </div>
            <p className={styles.detail}>
              {draft.protocol === 'nfs' ? t('protocolNfsHint') : t('protocolSshfsHint')}
            </p>

            {draft.protocol === 'nfs' ? (
              <dl className={styles.pairs}>
                <div className={styles.pair}>
                  <dt>{t('nfsServer')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.nfsServer}
                      placeholder={t('nfsServerPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, nfsServer: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
              </dl>
            ) : (
              <dl className={styles.pairs}>
                <div className={styles.pair}>
                  <dt>{t('sshHost')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshHost}
                      placeholder={t('sshHostPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshHost: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshUser')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshUser}
                      placeholder={t('sshUserPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshUser: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshPort')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.sshPort}
                      onChange={event => { setDraft(d => ({ ...d, sshPort: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshRemotePath')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshRemotePath}
                      placeholder={t('sshRemotePathPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshRemotePath: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshMountOptions')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshMountOptions}
                      placeholder={t('sshMountOptionsPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshMountOptions: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshKey')}</dt>
                  <dd>
                    {/* The key itself never reaches this page: the panel shows the
                        credential's name and whether it resolves. */}
                    <code>{draft.sshKeyRef === '' ? t('sshKeyUnset') : draft.sshKeyRef}</code>
                    {' '}
                    <span className={config.ssh?.keyConfigured === true ? styles.badgeOk : styles.badgeWarn}>
                      {config.ssh?.keyConfigured === true ? t('sshKeyConfigured') : t('sshKeyMissing')}
                    </span>
                  </dd>
                </div>
              </dl>
            )}

          </>)}

          {/* Outside the remote branch on purpose: switching BACK to local is equally a
              change, and a save control that vanishes with the choice it would record
              leaves the reader unable to return. */}
          <div className={styles.saveRow}>
            <Button
              variant="primary"
              disabled={saveState.kind === 'saving'}
              onClick={() => { void saveStorage() }}
            >
              {saveState.kind === 'saving' ? t('saving') : t('save')}
            </Button>
            {saveState.kind === 'saved' && (
              <p className={styles.notice} role="status">
                {t('savedOk')}
                {saveState.restartRequired ? ' ' + t('savedRestart') : ''}
              </p>
            )}
            {saveState.kind === 'failed' && (
              <p className={styles.error} role="alert">{saveState.message}</p>
            )}
          </div>

          {/* Where the tree is mounted, and the resolved paths it points at: facts about
              the running deployment rather than settings, so they read as values. */}
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

        <DeploymentWizard t={t} storageMode={status.storageMode} />

          {/* MinerU 的地址。端口只能表达"本机"，所以服务在隧道、网关或另一台机器后面时
              没有地方填。留空即按部署配置的端口推导，因此这是一项可选覆盖而不是必填项。
              本地与远程模式都显示：文档解析与存储形态无关。 */}
          <h3 className={styles.groupTitle}>{t('settingsMineruHeading')}</h3>
          <p className={styles.detail}>{t('settingsMineruHint')}</p>
          {mineru === undefined
            ? <p className={styles.detail}>{t('settingsLoading')}</p>
            : (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="kb-mineru-base-url">
                    {t('settingsMineruHeading')}
                  </label>
                  <input
                    id="kb-mineru-base-url"
                    className={styles.input}
                    type="url"
                    inputMode="url"
                    value={mineruDraft ?? mineru.stored}
                    placeholder={t('settingsMineruPlaceholder')}
                    // 没有授权的人看到的是已配置值，但改不了：这是部署级行为，不是
                    // 个人偏好，所以按 canEdit 禁用而不是隐藏。
                    disabled={!mineru.canEdit || mineruBusy}
                    onChange={(event) => { setMineruDraft(event.target.value) }}
                  />
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    disabled={!mineru.canEdit || mineruBusy || mineruDraft === undefined}
                    onClick={() => { void saveMineru() }}
                  >
                    {mineruBusy ? t('settingsSaving') : t('settingsSave')}
                  </Button>
                  {/* 说清当前生效来源比只显示原始值重要：空值不是"没配置"，而是
                      "按端口推导"，那是能工作的配置。 */}
                  <span className={styles.detail}>
                    {mineru.stored === '' ? t('settingsMineruDerived') : t('settingsMineruExplicit')}
                  </span>
                </div>
                {!mineru.canEdit && <p className={styles.detail}>{t('settingsReadOnly')}</p>}
                {mineruNotice !== undefined && <p className={styles.notice} role="status">{mineruNotice}</p>}
              </>
            )}

          {/* Runtime state (idle/indexing, visible count, last sync, the read-only grant
              list) deliberately stays off this page: a settings surface answers "what can
              I change", while those answer "what is happening right now". They live on the
              Home and Permissions pages, which is where a reader goes to look at them. */}

        {notice !== undefined && <p className={styles.notice} role="status">{notice}</p>}

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
function DeploymentWizard({ t, storageMode }: { t: KnowledgeSettingsInjected['t']; storageMode?: 'local' | 'remote' }) {
  const [hosts, setHosts] = useState<DeployHostView[]>([])
  const [hostId, setHostId] = useState('')
  const [steps, setSteps] = useState<DeployStepView[]>([])
  const [run, setRun] = useState<DeployRunView | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [hostsError, setHostsError] = useState<string | undefined>(undefined)
  /**
   * Whether the host list has been read yet.
   *
   * The two shapes below render differently, and guessing before the answer arrives
   * would flash the seven-step wizard at a local reader and then replace it -- a
   * layout jump in a settings panel reads as a bug. Until the read settles the
   * section renders nothing, which is the same thing it renders for the reader who
   * has no remote host at all.
   */
  const [hostsLoaded, setHostsLoaded] = useState(false)

  const loadHosts = useCallback(async () => {
    try {
      const reply = await postJson<{ hosts: DeployHostView[]; error?: { message: string } }>(KB_API.deployHosts)
      setHosts(reply.hosts)
      setHostsError(reply.error?.message)
      setHostId(current => (current !== '' ? current : (reply.hosts[0]?.id ?? '')))
    } catch (error) {
      setHostsError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostsLoaded(true)
    }
  }, [])

  const loadSteps = useCallback(async () => {
    const reply = await postJson<{ steps: DeployStepView[] }>(KB_API.deploySteps)
    setSteps(reply.steps)
  }, [])

  useEffect(() => { void loadHosts() }, [loadHosts])

  /**
   * Read the plan only once the block is actually going to draw it.
   *
   * The host list decides whether the wizard has a remote target; a local deployment
   * renders one sentence instead of the steps, so fetching them there is a request
   * whose answer is never shown. Gated on `hostsLoaded` so the decision is made after
   * the answer arrives, not on a guess.
   */
  useEffect(() => {
    if (!hostsLoaded) return
    if (hosts.length === 0 && storageMode !== 'remote') return
    void loadSteps()
  }, [hostsLoaded, hosts.length, storageMode, loadSteps])

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

  /**
   * Whether this deployment can run any of the steps at all.
   *
   * Every step in the plan executes ON A REMOTE HOST: the Host's `deploy.run` route
   * refuses a request without a `hostId` ("Steps mutate a remote host"), and the
   * MinerU steps are shell run there too -- they read the remote `/etc/os-release`,
   * remote `uv`, remote `docker`. So the wizard is not an NFS-only block that a local
   * deployment skips in part; with no SSH host configured it has nothing that can
   * run, and seven disabled buttons are seven dead controls.
   *
   * A configured host is what makes the block meaningful, so that is the test. The
   * deployment's own declared mode is the fallback: a `remote` deployment is one that
   * intends to sync, so it keeps the wizard even before a host row exists (the host
   * list may be empty for reasons the reader can fix, and hiding the wizard would
   * remove the only place that says so).
   *
   * Both inputs are real state: `hosts` is the `deploy.hosts` reply, `storageMode` is
   * the `status` reply. Anything missing counts as local -- the conservative
   * direction, because the local shape is the one where the buttons would be a lie.
   */
  const hasRemoteTarget = hasDeployTarget(hosts, storageMode)

  // The host list has not come back yet: hold the section rather than guess at its
  // shape (see `hostsLoaded`).
  if (!hostsLoaded) return null

  /**
   * The local shape: one sentence and a way to learn what the block is for.
   *
   * Not the disabled buttons with an explanation attached: a control that cannot act
   * is not made acceptable by explaining it, and the reader who is local has no
   * decision to make here. The pointer keeps the capability findable for the reader
   * who is about to switch this deployment to a remote store, which is the one
   * question the absence would otherwise leave open. It is a disclosure rather than
   * a link because the plugin owns no documentation URL, and inventing one would be
   * worse than not offering it.
   */
  if (!hasRemoteTarget) {
    return (
      <div className={styles.wizard} data-testid="kb-deploy-local-note">
        <h3 className={styles.groupTitle}>{t('deploy')}</h3>
        <p className={styles.detail}>{t('deployLocalOnly')}</p>
        {/* Plain text, not a link and not a disclosure. The plugin owns no
            documentation URL, and inventing one would send the reader to a 404; a
            `details` element would also be a control, and the whole point of this
            branch is that there is nothing here to operate. When a real page exists
            this becomes the one place to attach it. */}
        <div className={styles.deployAbout}>
          <p className={styles.deployAboutLabel}>{t('deployAboutRemote')}</p>
          <p className={styles.detail}>{t('deployAboutRemoteBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.wizard}>
      <h3 className={styles.groupTitle}>{t('deploy')}</h3>
      <p className={styles.detail}>{t('deployIntro')}</p>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="kb-deploy-host">{t('deployHost')}</label>
        {/* A native select, because the primitive library exports no Select at all
            (checked `ui-primitives/src/index.ts`: no Select, Dropdown or Combobox).
            What it does export -- SegmentedControl, SegmentedTabs -- renders every
            option side by side, which suits three fixed tabs and not a list of
            hosts that grows with the deployment. The label is bound by `htmlFor`,
            so the keyboard and screen-reader behaviour is the platform's own. */}
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
