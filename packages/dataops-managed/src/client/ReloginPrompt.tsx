/**
 * The "sign in again" prompt shown when this workspace's DataOps session has ended.
 *
 * The failure it reports used to be invisible. Every DataOps call handles a 401 by degrading to
 * an empty result, which is right for one panel but wrong for the operator: settings, shared
 * models and the skill plaza all render as "nothing here" while the real cause is that nobody is
 * signed in any more. This prompt names that state once, with the one action that clears it.
 *
 * It reports and nothing more. It does not retry, expire, or re-authenticate — the portal owns
 * the login form and is the only thing that can issue a session. It also cannot navigate the
 * operator there: the portal is a different origin, so this frame cannot read or drive its
 * window, and the gateway does not forward the browser's origin to the workspace. Guessing a
 * URL from inside here would open the wrong page on some deployments, so the dialog tells the
 * operator which window to switch to instead of pretending it can take them.
 *
 * @module ReloginPrompt
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthState } from '../auth-state.ts'

/** How often to re-read the observed auth state. */
const POLL_MS = 15_000

/** What the Host route answers. */
interface AuthStateReply {
  readonly state?: unknown
}

/**
 * Read the observed credential state from the Host.
 *
 * A failed read says nothing about the credential: this route is served by the same process that
 * serves the page, so an unreachable route means the Web server is busy or restarting, not that
 * anyone was signed out. Returning `undefined` keeps a transient error from raising a sign-in
 * prompt, which would be a lie the operator cannot act on.
 *
 * @returns the reported state, or `undefined` when it could not be read.
 */
const readAuthState = async (): Promise<AuthState | undefined> => {
  try {
    const response = await fetch(new URL('/integrations/dataops/auth-state', window.location.origin), {
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as AuthStateReply
    const state = body.state
    return state === 'expired' || state === 'valid' || state === 'unknown' ? state : undefined
  } catch {
    return undefined
  }
}

/** The copy this prompt needs, bound by its host surface. */
export interface ReloginPromptProps {
  /** Resolve one of the prompt's own strings. */
  readonly t: (key: 'reloginTitle' | 'reloginBody' | 'reloginAction' | 'reloginDismiss') => string
}

/**
 * Watch for an ended DataOps session and say so.
 *
 * @param props.t - localized copy resolver.
 * @returns the dialog while the session is known to have ended, otherwise `null`.
 */
export function ReloginPrompt(props: ReloginPromptProps) {
  const { t } = props
  const [expired, setExpired] = useState(false)
  // Dismissal is per-outage, not permanent: the state stays `expired`, so without this the dialog
  // would reopen on the next poll and trap the operator behind a modal they cannot leave.
  // A session that comes back resets the flag, so the next outage prompts again.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const state = await readAuthState()
      if (cancelled || state === undefined) return
      setExpired(state === 'expired')
      if (state !== 'expired') setDismissed(false)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const dismiss = useCallback((): void => { setDismissed(true) }, [])

  if (!expired || dismissed) return null
  return (
    <Modal
      open
      onClose={dismiss}
      title={t('reloginTitle')}
      closeLabel={t('reloginDismiss')}
      description={t('reloginBody')}
      footer={(
        <>
          <Button onClick={dismiss}>{t('reloginDismiss')}</Button>
          {/* Reloading is the one action this frame can actually take: it re-runs the workspace
              boot and re-syncs the JWT, so a session restored in the portal tab takes effect here
              without the operator hunting for a refresh button. */}
          <Button variant="primary" onClick={() => { window.location.reload() }}>
            {t('reloginAction')}
          </Button>
        </>
      )}
    />
  )
}
