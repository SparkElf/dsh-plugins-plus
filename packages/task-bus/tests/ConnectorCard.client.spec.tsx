// @vitest-environment jsdom
/**
 * Connector card behavior: the server state is the only source of the enabled
 * flag, capability rows appear only while enabled, a capability the account
 * may not use never renders, and the disabled state links to the skill center.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The installed primitives barrel imports a workspace-path helper this test
// environment does not resolve. These three stand-ins keep the control
// semantics the assertions read (switch role/name/state and buttons).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = (props: Record<string, unknown>) => (
    <button type="button" {...props}>{props.children as React.ReactNode}</button>
  )
  const Tag = (props: Record<string, unknown>) => <span>{props.children as React.ReactNode}</span>
  const Switch = (props: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => { props.onChange(!props.checked) }}
    />
  )
  return { Button, Tag, Switch }
})

import { ConnectorCard, ConnectorDisabledState } from '../src/client/ConnectorCard.tsx'
import type { ConnectorState } from '../src/client/connector-state.ts'

// React reads this flag to allow act() outside a test renderer.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

/** Render one React node into the shared root and flush effects. */
function render(node: React.ReactNode): void {
  act(() => { root.render(node) })
}

/** Find one button by its accessible name. */
function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
  if (match === undefined) throw new Error('button not found: ' + label)
  return match
}

/** Click one button inside act(). */
function click(label: string): void {
  act(() => { button(label).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

const enabledState: ConnectorState = {
  enabled: true,
  capabilities: { 'approval.push': true, 'task.writeback': false },
  reasons: { 'task.writeback': '当前连接未开通回写' },
}

function card(state: ConnectorState | null, handlers: Partial<Parameters<typeof ConnectorCard>[0]> = {}): React.ReactElement {
  return (
    <ConnectorCard
      state={state}
      loading={false}
      error={null}
      busy={false}
      taskCount={0}
      onSetEnabled={() => undefined}
      onToggleCapability={() => undefined}
      onReload={() => undefined}
      {...handlers}
    />
  )
}

describe('ConnectorCard', () => {
  it('hides capability rows while the connector is disabled', () => {
    render(card({ enabled: false, capabilities: { 'approval.push': true } }))
    expect(container.textContent).toContain('万相AI中台连接器')
    expect(container.querySelector('[data-connector-capabilities]')).toBeNull()
    expect(container.querySelector('[data-capability-id]')).toBeNull()
    expect(container.querySelector('[data-connector-enabled="false"]')).toBeTruthy()
  })

  it('renders one row per permitted capability with its own switch and reason', () => {
    render(card(enabledState, { taskCount: 2 }))
    expect(container.querySelectorAll('[data-capability-id]').length).toBe(2)
    expect(container.querySelector('[data-capability-id="approval.push"]')?.textContent).toContain('接收审批任务')
    expect(container.querySelector('[data-capability-id="task.writeback"]')?.textContent).toContain('当前连接未开通回写')
    expect(container.textContent).toContain('该连接器任务 2 条')
  })

  it('does not render a capability absent from the Host answer', () => {
    render(card({ enabled: true, capabilities: { 'approval.push': true } }))
    expect(container.querySelector('[data-capability-id="admin.only"]')).toBeNull()
    expect(container.querySelectorAll('[data-capability-id]').length).toBe(1)
  })

  it('sends the enable and capability writes upward', () => {
    const onSetEnabled = vi.fn()
    const onToggleCapability = vi.fn()
    render(card(enabledState, { onSetEnabled, onToggleCapability }))
    click('停用 万相AI中台连接器')
    expect(onSetEnabled).toHaveBeenCalledWith(false)
    click('停用 接收审批任务')
    expect(onToggleCapability).toHaveBeenCalledWith('approval.push', false)
  })

  it('shows the Host read failure and a retry action', () => {
    const onReload = vi.fn()
    render(card(null, { error: '连接器状态读取失败（500）', onReload }))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('连接器状态读取失败')
    click('重试')
    expect(onReload).toHaveBeenCalled()
  })
})

describe('ConnectorDisabledState', () => {
  it('links to the skill center', () => {
    const onOpenSkillCenter = vi.fn()
    render(<ConnectorDisabledState onOpenSkillCenter={onOpenSkillCenter} />)
    expect(container.textContent).toContain('连接器未启用')
    click('前往技能中心启用')
    expect(onOpenSkillCenter).toHaveBeenCalled()
  })
})