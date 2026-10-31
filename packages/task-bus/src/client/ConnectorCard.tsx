/**
 * The Task Center's connector card: one connector, its server-owned enabled
 * state, and — while enabled — the capability rows this account may use.
 *
 * @module @sparkelf/dsh-task-bus/client/ConnectorCard
 */
import type { ReactNode } from 'react'
import { Button, Switch, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { colors } from './theme.ts'
import {
  CONNECTOR_NAME,
  visibleCapabilities,
  type ConnectorState,
} from './connector-state.ts'

/** Inputs the Task Center supplies. */
export interface ConnectorCardProps {
  state: ConnectorState | null
  loading: boolean
  error: string | null
  busy: boolean
  /** Rows the current capability filter selects. */
  taskCount: number
  onSetEnabled(enabled: boolean): void
  onToggleCapability(capabilityId: string, enabled: boolean): void
  onReload(): void
}

/** Status label and tone for the card header. */
function statusOf(state: ConnectorState | null, loading: boolean, error: string | null): { label: string; tone: TagTone } {
  if (loading && state === null) return { label: '同步中', tone: 'neutral' }
  if (error !== null) return { label: '连接异常', tone: 'danger' }
  if (state?.enabled !== true) return { label: '未启用', tone: 'neutral' }
  return { label: '已连接', tone: 'success' }
}

/** Draw the connector glyph the card header carries. */
function ConnectorGlyph(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15" />
    </svg>
  )
}

/**
 * Render the connector card.
 * @param props - server state, write handlers, and the current task count.
 * @returns the card.
 */
export function ConnectorCard({
  state, loading, error, busy, taskCount, onSetEnabled, onToggleCapability, onReload,
}: ConnectorCardProps): ReactNode {
  const status = statusOf(state, loading, error)
  const enabled = state?.enabled === true
  const capabilities = visibleCapabilities(state)
  return (
    <article
      data-connector-card={CONNECTOR_NAME}
      data-connector-enabled={enabled}
      style={{
        width: '100%',
        minWidth: 0,
        border: '1px solid ' + colors.line,
        borderRadius: 12,
        background: colors.panelAlt,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden="true" style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: '#2563eb', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <ConnectorGlyph />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>{CONNECTOR_NAME}</div>
          <div style={{ marginTop: 2, fontSize: 10, color: colors.muted }}>DataOps</div>
        </div>
        <Tag tone={status.tone}>{status.label}</Tag>
      </div>

      <div style={{ fontSize: 11, lineHeight: 1.55, color: colors.muted }}>
        接收万相AI中台的审批任务
      </div>

      {loading && state === null ? (
        <div style={{ fontSize: 11, color: colors.muted }}>正在读取连接器状态…</div>
      ) : null}
      {error === null ? null : (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: colors.danger }}>
          <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
          <Button size="sm" variant="ghost" disabled={loading} onClick={onReload}>重试</Button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 28 }}>
        <span style={{ fontSize: 12, color: colors.muted }}>
          {enabled ? '已启用，任务中心只读取该连接器的任务' : '未启用，任务中心不读取外部任务'}
        </span>
        <Switch
          checked={enabled}
          disabled={busy || loading}
          label={(enabled ? '停用 ' : '启用 ') + CONNECTOR_NAME}
          onChange={(next) => { onSetEnabled(next) }}
        />
      </div>

      {enabled ? (
        <div data-connector-capabilities style={{ borderTop: '1px solid ' + colors.line, paddingTop: 8, display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 10, color: colors.muted }}>能力</div>
          {capabilities.length === 0 ? (
            <div style={{ fontSize: 11, color: colors.muted, padding: '6px 0' }}>
              当前账号没有可用的连接器能力，请联系管理员开通
            </div>
          ) : capabilities.map(capability => {
            const unavailable = capability.unavailableReason !== undefined
            return (
              <div
                key={capability.id}
                data-capability-id={capability.id}
                data-capability-enabled={capability.enabled}
                style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, padding: '4px 0', borderTop: '1px solid ' + colors.line }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: colors.text }}>{capability.label}</div>
                  {capability.description === undefined ? null : (
                    <div style={{ marginTop: 1, fontSize: 10, color: colors.muted }}>{capability.description}</div>
                  )}
                  {capability.unavailableReason === undefined ? null : (
                    <div style={{ marginTop: 2, fontSize: 10, color: colors.warning }}>
                      暂不可用 · {capability.unavailableReason}
                    </div>
                  )}
                </div>
                <Switch
                  checked={capability.enabled}
                  disabled={busy || unavailable}
                  label={(capability.enabled ? '停用 ' : '启用 ') + capability.label}
                  onChange={(next) => { onToggleCapability(capability.id, next) }}
                />
              </div>
            )
          })}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto', fontSize: 10, color: colors.muted }}>
        <span>{enabled ? '该连接器任务 ' + String(taskCount) + ' 条' : '启用后在此查看连接器任务'}</span>
        <Button size="sm" variant="ghost" disabled={loading} onClick={onReload}>刷新状态</Button>
      </div>
    </article>
  )
}

/**
 * The disabled connector's empty state, with the one path that can enable it.
 * @param props.onOpenSkillCenter - select the skill center's connector tab.
 * @returns the empty state.
 */
export function ConnectorDisabledState({ onOpenSkillCenter }: { onOpenSkillCenter(): void }): ReactNode {
  return (
    <div
      data-connector-disabled-state
      style={{ display: 'grid', justifyItems: 'center', gap: 8, padding: '36px 20px 40px', color: colors.muted, textAlign: 'center' }}
    >
      <span style={{ display: 'inline-flex', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, background: colors.panelAlt, color: colors.muted }}>
        <ConnectorGlyph />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>连接器未启用</span>
      <span style={{ maxWidth: 380, fontSize: 12, lineHeight: 1.6 }}>
        在技能中心的连接器页面启用「{CONNECTOR_NAME}」后，这里会显示它接收的审批任务。
      </span>
      <Button size="sm" variant="outline" onClick={onOpenSkillCenter}>前往技能中心启用</Button>
    </div>
  )
}