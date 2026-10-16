/**
 * The three per-room dialogs: invite, members, and settings.
 *
 * They share one module because they are one interaction family — each is opened from a
 * room row's context menu, each operates on exactly one room, and each writes through the
 * same store. Splitting them would triple the plumbing without separating anything.
 *
 * The settings dialog carries the required notice: its three switches change where a room
 * appears, not who may reach it. The server enforces permissions; these are preferences.
 *
 * @module @sparkelf/dsh-group-chat/client/RoomDialogs
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { inviteMembers, listMembers, updateRoom, type RoomMember } from './api.ts'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './CreateRoomDialog.module.css'

export interface RoomDialogsProps {
  readonly t: (key: GroupChatKey) => string
  readonly store: RoomStore
}

/**
 * Render whichever room dialog is open.
 * @param props - the copy resolver and the store holding the open dialog.
 * @returns the dialog, or null when none is open.
 */
export function RoomDialogs(props: RoomDialogsProps) {
  const { t, store } = props
  const dialog = store.getState().dialog
  if (dialog === undefined) return null
  const close = (): void => store.setDialog(undefined)
  if (dialog.kind === 'invite') {
    return <InviteDialog t={t} store={store} roomId={dialog.roomId} onClose={close} />
  }
  if (dialog.kind === 'settings') {
    return <SettingsDialog t={t} store={store} roomId={dialog.roomId} onClose={close} />
  }
  return <MembersDialog t={t} roomId={dialog.roomId} onClose={close} />
}

/** Add existing DataOps accounts to a room. */
function InviteDialog(props: {
  t: (key: GroupChatKey) => string
  store: RoomStore
  roomId: string
  onClose: () => void
}) {
  const { t, store, roomId, onClose } = props
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)
  const [done, setDone] = useState(false)

  const submit = async (): Promise<void> => {
    const userIds = input.split(/[\s,;]+/u).map((part) => part.trim()).filter((part) => part.length > 0)
    if (userIds.length === 0 || busy) return
    setBusy(true)
    try {
      await inviteMembers(roomId, userIds)
      await store.refresh()
      setInput('')
      setDone(true)
      setError(undefined)
    } catch (cause) {
      setError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('inviteTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" size="md" disabled={busy || input.trim().length === 0}
                  onClick={() => void submit()}>
            {t('inviteSubmit')}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>{t('inviteTitle')}</span>
          <Input
            value={input}
            autoFocus
            placeholder={t('invitePlaceholder')}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          />
          <span className={styles.hint}>{t('inviteHint')}</span>
        </label>
        {done && <p className={styles.hint}>{t('saved')}</p>}
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
      </div>
    </Modal>
  )
}

/** List a room's members. */
function MembersDialog(props: {
  t: (key: GroupChatKey) => string
  roomId: string
  onClose: () => void
}) {
  const { t, roomId, onClose } = props
  const [members, setMembers] = useState<readonly RoomMember[] | undefined>(undefined)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await listMembers(roomId)
        if (!cancelled) setMembers(next)
      } catch (cause) {
        if (!cancelled) setError(failureOf(cause))
      }
    })()
    return () => { cancelled = true }
  }, [roomId])

  return (
    <Modal open onClose={onClose} title={t('membersTitle')} closeLabel={t('cancel')}
           footer={<div className={styles.footer}><Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button></div>}>
      <div className={styles.body}>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
        {error === undefined && members === undefined && <p className={styles.hint}>{t('loading')}</p>}
        {members !== undefined && (
          <ul className={styles.memberList}>
            {members.map((member) => (
              <li key={member.userId} className={styles.memberRow}>
                <span className={styles.memberName}>{member.displayName}</span>
                {member.owner && <span className={styles.memberBadge}>{t('ownerBadge')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** The room's three policy dimensions. */
function SettingsDialog(props: {
  t: (key: GroupChatKey) => string
  store: RoomStore
  roomId: string
  onClose: () => void
}) {
  const { t, store, roomId, onClose } = props
  const room = store.getState().rooms?.find((candidate) => candidate.id === roomId)
  const [invitePolicy, setInvitePolicy] = useState(room?.invitePolicy ?? 'anyone')
  const [discoverability, setDiscoverability] = useState(room?.discoverability ?? 'discoverable')
  const [agentTrigger, setAgentTrigger] = useState(room?.agentTrigger ?? 'mention')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await updateRoom(roomId, { invitePolicy, discoverability, agentTrigger })
      await store.refresh()
      onClose()
    } catch (cause) {
      setError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('settingsTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" size="md" disabled={busy} onClick={() => void save()}>
            {t('save')}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        {/* Three switches, each a distinct control point: who may invite, who can find the
            room, and whether the agent answers. */}
        <div className={styles.switches}>
          <PolicyRow t={t} label={t('createPolicy')}
                     value={invitePolicy === 'anyone'} onChange={(next) => setInvitePolicy(next ? 'anyone' : 'admin')}
                     onLabel={t('policyAnyone')} offLabel={t('policyAdmin')} />
          <PolicyRow t={t} label={t('createVisibility')}
                     value={discoverability === 'discoverable'} onChange={(next) => setDiscoverability(next ? 'discoverable' : 'invite_only')}
                     onLabel={t('discoverable')} offLabel={t('inviteOnly')} />
        </div>
        <div className={styles.switches} style={{ borderTop: 'none', paddingTop: 0 }}>
          <span className={styles.label}>{t('createTrigger')}</span>
          <div className={styles.triggerExtra}>
            {(['mention', 'always', 'never'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={agentTrigger === mode ? styles.pillActive : styles.pill}
                onClick={() => setAgentTrigger(mode)}
              >
                {mode === 'mention' ? t('triggerMention') : mode === 'always' ? t('triggerAlways') : t('triggerNever')}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.notice}>{t('createNotice')}</p>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
      </div>
    </Modal>
  )
}

/** One two-state policy row, labelled with what each side means. */
function PolicyRow(props: {
  t: (key: GroupChatKey) => string
  label: string
  value: boolean
  onChange: (next: boolean) => void
  onLabel: string
  offLabel: string
}) {
  const { label, value, onChange, onLabel, offLabel } = props
  return (
    <div className={styles.policyRow}>
      <span className={styles.label}>{label}</span>
      <div className={styles.triggerExtra}>
        <button type="button" className={value ? styles.pillActive : styles.pill}
                onClick={() => onChange(true)}>{onLabel}</button>
        <button type="button" className={!value ? styles.pillActive : styles.pill}
                onClick={() => onChange(false)}>{offLabel}</button>
      </div>
    </div>
  )
}
