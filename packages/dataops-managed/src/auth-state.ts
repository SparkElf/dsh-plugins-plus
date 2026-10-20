/**
 * Whether the stored DataOps credential is still accepted, observed rather than guessed.
 *
 * Every DataOps call this plugin makes already knows the answer: a 401 is the server saying the
 * caller's session has ended. Those answers used to be swallowed at each call site — each one
 * returned `undefined` and moved on — which turned "your session expired" into "this feature
 * happens to be empty". That is the failure this module removes: the calls still degrade
 * gracefully, but the reason is recorded once, in a place the interface can read.
 *
 * The state is deliberately tiny and stuck in this process. It is not a token cache and it does
 * not decide authorization — DataOps remains the only authority. It exists because a person
 * looking at the workspace cannot see a 401 that was handled three layers down, and "sign in
 * again" is only actionable if it is shown while it is still true.
 *
 * @module auth-state
 */

/** What the last DataOps answer said about the stored credential. */
export type AuthState = 'unknown' | 'valid' | 'expired'

let state: AuthState = 'unknown'

/**
 * Record that a DataOps call was accepted.
 *
 * Called on any non-401 answer, including ones that carry a refusal for another reason: a 403
 * says the session is fine and the permission is not, so it must not raise the sign-in prompt.
 */
export const noteAccepted = (): void => {
  state = 'valid'
}

/** Record that DataOps refused the credential, which means the session is over. */
export const noteExpired = (): void => {
  state = 'expired'
}

/**
 * Read the current observation.
 *
 * @returns `unknown` before any call has completed, then what the last one said.
 */
export const currentAuthState = (): AuthState => state

/**
 * Test-only reset, so one case cannot leak its observation into the next.
 */
export const resetAuthState = (): void => {
  state = 'unknown'
}
