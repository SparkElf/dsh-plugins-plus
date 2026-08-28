import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name for the DataOps-managed Settings contribution. */
export const name = 'dataops-managed'

/**
 * Keep the Host seat intentionally empty because DataOps owns the broker process.
 * @param _ctx - DSH Host context retained for the installable bundle contract.
 */
export function apply(_ctx: Context): void {}
