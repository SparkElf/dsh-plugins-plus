/**
 * The create-room dialog.
 *
 * Three fields are required because each one decides something the room cannot change
 * later — the name, the working directory, and the agent preset. `cwd` is the real
 * security boundary: every member of the room can ask the agent to modify anything under
 * it, so the field carries a visible warning rather than a hint.
 *
 * The three policy switches are the room's settings, offered at creation so a room is not
 * born with defaults the creator would have chosen differently. The notice at the foot is
 * required wording: these settings control where a room appears, not who may reach it.
 *
 * @module @sparkelf/dsh-group-chat/client/CreateRoomDialog
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoom } from './api.ts'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './CreateRoomDialog.module.css'

/** Props the page half passes. */
export interface CreateRoomDialogProps {
  readonly t: (key: GroupChatKey) => string
  readonly store: RoomStore
}

/** Invite policy values the backend accepts. */
type InvitePolicy = 'anyone' | 'admin'
/** Discoverability values the backend accepts. */
type Discoverability = 'discoverable' | 'invite_only'
/** Agent trigger values the backend accepts. */
type AgentTrigger = 'mention' | 'always' | 'never'

/**
 * Render the create-room dialog.
 * @param props - the copy resolver and shared store whose `pendingCreate` opens this.
 * @returns the dialog, or null while closed.
 */
export function CreateRoomDialog(props: CreateRoomDialogProps) {
  const { t, store } = props
  const open = store.getState().pendingCreate

  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [preset, setPreset] = useState('')
  const [invitePolicy, setInvitePolicy] = useState<InvitePolicy>('anyone')
  const [discoverability, setDiscoverability] = useState<Discoverability>('discoverable')
  const [agentTrigger, setAgentTrigger] = useState<AgentTrigger>('mention')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)

  // A reopened dialog starts clean, so a cancelled attempt leaves nothing behind.
  useEffect(() => {
    if (!open) {
      setName(''); setBusy(false); setError(undefined)
    }
  }, [open])

  const close = (): void => store.closeCreate()

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0 || busy) return
    setBusy(true)
    try {
      const room = await createRoom(name.trim(), {
        // Empty means "use the server's default", so it is omitted rather than sent blank.
        ...cwd.trim().length === 0 ? {} : { cwd: cwd.trim() },
        ...preset.trim().length === 0 ? {} : { agentPreset: preset.trim() },
      })
      // The policies travel as a follow-up update rather than create-time fields, so a
      // failure to apply them still leaves a usable room instead of none.
      await Promise.all([
        invitePolicy === 'anyone' ? Promise.resolve() : store.setPolicy(room.id, { invitePolicy }),
        discoverability === 'discoverable' ? Promise.resolve() : store.setPolicy(room.id, { discoverability }),
        agentTrigger === 'mention' ? Promise.resolve() : store.setPolicy(room.id, { agentTrigger }),
      ])
      await store.refresh()
      store.open(room.id)
      close()
    } catch (cause) {
      setError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('createTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={close}>{t('cancel')}</Button>
          <Button
            variant="primary"
            size="md"
            disabled={busy || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {t('createSubmit')}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>{t('createName')}</span>
          <Input
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          />
        </label>

        {/* Required and security-relevant: this field decides what the agent can touch on
            behalf of everyone in the room, so it is shown with its consequence. */}
        <label className={styles.field}>
          <span className={styles.label}>{t('createCwd')}</span>
          <Input
            value={cwd}
            placeholder="/workspace"
            onChange={(event) => setCwd(event.target.value)}
          />
          <span className={styles.warn}>{t('createCwdHint')}</span>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('createPreset')}</span>
          <Input
            value={preset}
            placeholder="default"
            onChange={(event) => setPreset(event.target.value)}
          />
          <span className={styles.hint}>{t('createPresetHint')}</span>
        </label>

        <div className={styles.switches}>
          <Switch
            checked={invitePolicy === 'anyone'}
            onChange={(next) => setInvitePolicy(next ? 'anyone' : 'admin')}
            label={t('createPolicy')}
          />
          <Switch
            checked={discoverability === 'discoverable'}
            onChange={(next) => setDiscoverability(next ? 'discoverable' : 'invite_only')}
            label={t('createVisibility')}
          />
          <Switch
            checked={agentTrigger === 'mention'}
            onChange={(next) => setAgentTrigger(next ? 'mention' : 'always')}
            label={t('createTrigger')}
          />
          <div className={styles.triggerExtra}>
            {(['mention', 'always', 'never'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={agentTrigger === mode ? styles.pillActive : styles.pill}
                onClick={() => setAgentTrigger(mode)}
              >
                {mode === 'mention' ? t('triggerMention')
                  : mode === 'always' ? t('triggerAlways') : t('triggerNever')}
              </button>
            ))}
          </div>
        </div>

        {/* Required wording: these settings are about appearance, not authorization. */}
        <p className={styles.notice}>{t('createNotice')}</p>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
      </div>
    </Modal>
  )
}
