/**
 * The Task Center surface in the frame-wide overlay.
 *
 * The button is global because a task can arrive while the reader is in any
 * session. The panel only renders cards returned by the Host bridge; it never
 * talks to DataOps directly and never derives a second approval status.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  Modal,
  SegmentedTabs,
  Tag,
  type SegmentedTab,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'uiWorkspace', 'sessions', 'sidebarRight']

interface TaskItem {
  id: string
  sourceType: 'dataops_approval' | 'task_bus'
  title: string
  code?: string
  description?: string | null
  status: string
  statusLabel: string
  priority?: string | null
  tags?: string[]
  source: {
    type: string
    id?: string | null
    label?: string | null
    workflowCode?: string | null
    deepLink?: string | null
  }
  assignee?: { type: string; id: string } | null
  creator?: { type: string; id: string } | null
  actions?: string[]
  dueAt?: string | null
  updatedAt: string
}

const ROUTE = '/dsh-task-bus/api'

const colors = {
  panel: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  panelAlt: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
  text: 'var(--dsw-alias-label-primary, #111827)',
  muted: 'var(--dsw-alias-label-secondary, #6b7280)',
  line: 'var(--dsw-alias-border-l1, #e5e7eb)',
  accent: 'var(--dsw-alias-brand-primary, #2563eb)',
  accentSoft: 'var(--dsw-alias-brand-primary-alpha, #eff6ff)',
  warning: 'var(--dsw-alias-state-warning, #b45309)',
  success: 'var(--dsw-alias-state-success, #047857)',
  danger: 'var(--dsw-alias-state-danger, #b91c1c)',
}

const TASK_BUS_MODAL_CLASS = 'task-bus-center-modal'
const TASK_BUS_STYLE_ID = 'task-bus-center-modal-style'
const TASK_BUS_MODAL_CSS = `
.${TASK_BUS_MODAL_CLASS} {
  width: min(960px, calc(100vw - 64px)) !important;
  height: min(760px, calc(100vh - 64px)) !important;
  gap: 0 !important;
  padding: 0 !important;
}
@media (max-width: 700px) {
  .${TASK_BUS_MODAL_CLASS} {
    width: calc(100vw - 24px) !important;
    height: calc(100vh - 24px) !important;
  }
}
`

const buttonStyle: CSSProperties = {
  border: '1px solid ' + colors.line,
  background: colors.panel,
  color: colors.text,
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 12,
  cursor: 'pointer',
}

const statusTagTone = (status: string): TagTone => {
  if (status === 'completed') return 'success'
  if (status === 'cancelled') return 'neutral'
  if (status === 'blocked') return 'danger'
  if (status === 'pending_confirm' || status === 'returned' || status === 'pending_accept') return 'warning'
  return 'info'
}

const relativeTime = (value: string) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return String(hours) + ' 小时前'
  return String(Math.round(hours / 24)) + ' 天前'
}

const fetchJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(ROUTE + path, { headers: { accept: 'application/json' } })
  const payload = await response.json() as unknown
  if (!response.ok) {
    const message = payload !== null && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : '任务中心请求失败（' + response.status + '）'
    throw new Error(message)
  }
  return payload as T
}


const approvalHref = (raw: string | null): string | null => {
  if (raw === null) return null
  try {
    const target = new URL(raw)
    const referrer = document.referrer ? new URL(document.referrer) : null
    if (referrer !== null && referrer.origin !== target.origin) {
      return referrer.origin + target.pathname + target.search + target.hash
    }
    return target.href
  } catch {
    return raw
  }
}

const TaskCard = ({
  task,
  busy,
  aiBusy,
  onTransition,
  onAiAccept,
  onOpen,
}: {
  task: TaskItem
  busy: boolean
  aiBusy: boolean
  onTransition: (task: TaskItem, action: string) => void
  onAiAccept: (task: TaskItem) => void
  onOpen: (task: TaskItem) => void
}) => {
  const isApproval = task.sourceType === 'dataops_approval'
  const deepLink = approvalHref(task.source.deepLink ?? null)
  return (
    <article
      style={{
        border: '1px solid ' + colors.line,
        borderRadius: 10,
        background: colors.panel,
        padding: '12px 13px',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
            <Tag tone={isApproval ? 'info' : 'neutral'}>
              {isApproval ? (task.source.label ?? 'DataOps 审批') : '任务总线'}
            </Tag>
            {task.tags?.map((tag) => (
              <Tag key={tag} tone="quiet">{tag}</Tag>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 650, color: colors.text, lineHeight: 1.45 }}>
            {task.title}
          </div>
          {task.description ? (
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 4, lineHeight: 1.5 }}>
              {task.description}
            </div>
          ) : null}
        </div>
        <span style={{ flex: 'none' }}><Tag tone={statusTagTone(task.status)}>{task.statusLabel}</Tag></span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, color: colors.muted }}>
        <span>{isApproval ? '审批任务' : '任务'}</span>
        {task.assignee?.id ? <span>受理人：{task.assignee.id}</span> : null}
        <span style={{ marginLeft: 'auto' }}>{relativeTime(task.updatedAt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {isApproval && deepLink ? (
          <Button size="sm" variant="primary" onClick={() => window.open(deepLink, '_blank', 'noopener,noreferrer')}>
            办理
          </Button>
        ) : null}
        {task.status !== 'completed' && task.status !== 'cancelled' ? (
          <Button size="sm" variant="outline" disabled={aiBusy || busy} onClick={() => onAiAccept(task)}>
            {aiBusy ? '受理中…' : 'AI受理'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen(task)}>详情</Button>
        {!isApproval && task.status === 'pending_accept' ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onTransition(task, 'accept')}>受理</Button>
        ) : null}
        {!isApproval && task.status === 'in_progress' ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(task, 'submit')}>提交确认</Button>
        ) : null}
        {!isApproval && task.status === 'pending_confirm' ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onTransition(task, 'complete')}>完成</Button>
        ) : null}
        {!isApproval && task.status !== 'completed' && task.status !== 'cancelled' ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onTransition(task, 'cancel')}>取消</Button>
        ) : null}
      </div>
    </article>
  )
}


interface TaskAttachmentRecord {
  id: string
  originalName: string
  contentType: string
  sizeBytes: number
  kind: string
}

interface FormFieldData {
  key: string
  label: string
  value: unknown
  type?: 'multiline' | 'resources'
  span?: 1 | 2
}

interface FormSectionData {
  title: string
  fields: FormFieldData[]
}

interface TaskDetailPayload {
  id?: number | string
  payload?: {
    form?: Record<string, unknown>
    selectedItems?: Array<Record<string, unknown>>
    resourceAccessRequest?: {
      form?: Record<string, unknown>
      selectedItems?: Array<Record<string, unknown>>
    }
  }
  form?: { sections?: FormSectionData[] }
  attachments?: TaskAttachmentRecord[]
}

const FORM_LABELS: Record<string, string> = {
  applicationMode: '申请方式',
  requestKind: '申请类型',
  requestedPermissions: '申请权限',
  requesterDepartment: '申请人部门',
  requesterPhone: '申请人电话',
  validFrom: '授权开始时间',
  expiresAt: '授权结束时间',
  selectionSummary: '资源摘要',
  code: '应用编码',
  name: '应用名称',
  reason: '申请理由',
  description: '应用说明',
  departmentName: '归属部门',
  departmentCode: '归属部门编码',
  ownerName: '归属负责人',
  ownerPhone: '归属负责人电话',
  constructionUnit: '建设单位',
  constructionOwner: '建设单位负责人',
  constructionOwnerPhone: '建设单位负责人电话',
  operationsUnit: '运维单位',
  operationsOwner: '运维单位负责人',
  operationsOwnerPhone: '运维单位负责人电话',
  requestTime: '申请时间',
  resourceName: '资源名称',
  resourceType: '资源类型',
  accessType: '访问方式',
  accessScope: '访问范围',
  applicationName: '所属应用',
  applicationCode: '应用编码',
  environment: '环境',
  accountCount: '账号数量',
}

const SKIP_FORM_KEYS = new Set([
  'ownerUserId',
  'requesterUserId',
  'requesterDept',
  'existingApplicationId',
  'applicationId',
  'taskType',
])

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const humanizeField = (key: string) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .trim()

const formatFormValue = (key: string, value: unknown): string => {
  if (key === 'applicationMode') {
    if (value === 'EXISTING') return '使用已有应用'
    if (value === 'NEW') return '新建应用'
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') return record.name
    return JSON.stringify(value)
  }
  return String(value)
}

const toFormField = (key: string, value: unknown): FormFieldData => ({
  key,
  label: FORM_LABELS[key] ?? humanizeField(key),
  value,
  ...(key === 'reason' || key === 'description' || key === 'accessScope'
    ? { type: 'multiline' as const, span: 2 as const }
    : {}),
})

const formFields = (form: Record<string, unknown> | undefined): FormFieldData[] => (
  form === undefined
    ? []
    : Object.entries(form)
      .filter(([key, value]) => !SKIP_FORM_KEYS.has(key) && value !== null && value !== undefined && value !== '')
      .map(([key, value]) => toFormField(key, value))
)

const approvalFormSections = (detail: TaskDetailPayload | null): FormSectionData[] => {
  if (detail === null) return []
  const sections: FormSectionData[] = []
  const applicationFields = formFields(detail.payload?.form)
  if (applicationFields.length > 0) sections.push({ title: '申请信息', fields: applicationFields })
  const resourceFields = formFields(detail.payload?.resourceAccessRequest?.form)
  if (resourceFields.length > 0) sections.push({ title: '资源申请', fields: resourceFields })
  const resources = [
    ...(detail.payload?.selectedItems ?? []),
    ...(detail.payload?.resourceAccessRequest?.selectedItems ?? []),
  ]
  if (resources.length > 0) {
    sections.push({
      title: '申请资源',
      fields: [{ key: 'resources', label: '资源', value: resources, type: 'resources', span: 2 }],
    })
  }
  return sections
}

const ResourceValue = ({ items }: { items: Array<Record<string, unknown>> }) => (
  <div style={{ display: 'grid', gap: 5 }}>
    {items.map((item, index) => {
      const label = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : `资源 ${index + 1}`
      const detail = [item.scope, item.urn, item.id].filter((value) => typeof value === 'string' || typeof value === 'number').join(' · ')
      return (
        <div key={String(item.urn ?? item.id ?? index)} style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: colors.text }}>{label}</span>
          {detail ? <span style={{ fontSize: 10, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span> : null}
        </div>
      )
    })}
  </div>
)

const FormDescriptions = ({ sections }: { sections: FormSectionData[] }) => {
  if (sections.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {sections.map((section, sectionIndex) => (
        <section key={section.title + sectionIndex} style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: colors.text, marginBottom: 9 }}>{section.title}</div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '9px 24px' }}>
            {section.fields.map((field) => (
              <div
                key={field.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '94px minmax(0, 1fr)',
                  alignItems: 'start',
                  gap: 8,
                  minWidth: 0,
                  gridColumn: field.span === 2 ? '1 / -1' : undefined,
                }}
              >
                <dt style={{ fontSize: 10, lineHeight: 1.6, color: colors.muted }}>{field.label}</dt>
                <dd style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: colors.text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {field.type === 'resources' && Array.isArray(field.value)
                    ? <ResourceValue items={field.value as Array<Record<string, unknown>>} />
                    : field.value === null || field.value === undefined || field.value === ''
                      ? '—'
                      : formatFormValue(field.key, field.value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

const TaskDetail = ({ task, onBack }: { task: TaskItem; onBack: () => void }) => {
  const isApproval = task.sourceType === 'dataops_approval'
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDetailLoading(true)
    setDetailError(null)
    void fetchJson<{ detail?: TaskDetailPayload }>('/items/' + encodeURIComponent(task.id))
      .then((payload) => { if (alive) setDetail(payload.detail ?? null) })
      .catch((cause) => { if (alive) setDetailError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (alive) setDetailLoading(false) })
    return () => { alive = false }
  }, [task.id])

  const sections = isApproval ? approvalFormSections(detail) : detail?.form?.sections ?? []
  const attachments = detail?.attachments ?? []
  const approvalTaskId = isApproval && typeof detail?.id === 'number' ? detail.id : null
  const attachmentHref = (attachment: TaskAttachmentRecord) => approvalTaskId === null
    ? null
    : ROUTE + '/attachment?taskId=' + encodeURIComponent(String(approvalTaskId))
      + '&attachmentId=' + encodeURIComponent(attachment.id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, lineHeight: 1.45 }}>{task.title}</div>
          <div style={{ marginTop: 3, fontSize: 10, color: colors.muted }}>
            {task.source.label ?? (isApproval ? 'DataOps 审批' : '任务总线')} · {relativeTime(task.updatedAt)}
          </div>
        </div>
        <Tag tone={statusTagTone(task.status)}>{task.statusLabel}</Tag>
      </div>

      {detailLoading ? <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>正在加载表单…</div> : null}
      {detailError ? <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fef2f2', color: colors.danger, fontSize: 11 }}>{detailError}</div> : null}
      {!detailLoading && detailError === null && sections.length > 0 ? <FormDescriptions sections={sections} /> : null}
      {!detailLoading && detailError === null && sections.length === 0 && !isApproval && task.description ? (
        <div style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14, fontSize: 12, lineHeight: 1.6, color: colors.text, whiteSpace: 'pre-wrap' }}>{task.description}</div>
      ) : null}
      {!detailLoading && detailError === null && sections.length === 0 && (isApproval || !task.description) ? (
        <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无表单信息</div>
      ) : null}

      {isApproval || attachments.length > 0 ? (
        <section style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: colors.text, marginBottom: 8 }}>附件</div>
          {attachments.length === 0 ? <div style={{ fontSize: 11, color: colors.muted }}>暂无附件</div> : (
            <div style={{ display: 'grid', gap: 6 }}>
              {attachments.map((attachment) => {
                const href = attachmentHref(attachment)
                return (
                  <div key={attachment.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.originalName}</span>
                    <span style={{ flex: 'none', fontSize: 10, color: colors.muted }}>{formatBytes(attachment.sizeBytes)}</span>
                    {href !== null ? <Button size="sm" variant="ghost" onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>下载</Button> : null}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 2 }}>
        <Button size="sm" variant="ghost" onClick={onBack}>← 返回列表</Button>
        {isApproval && task.source.deepLink ? (
          <Button size="sm" variant="outline" onClick={() => window.open(approvalHref(task.source.deepLink ?? null) ?? '#', '_blank', 'noopener,noreferrer')}>
            打开 DataOps 审批详情
          </Button>
        ) : null}
      </div>
    </div>
  )
}

const CONNECTOR_STORAGE_KEY = 'dsh.task-bus.dataops-connector.enabled'

const DataOpsConnectorCard = ({
  approvalCount,
  connected,
  enabled,
  onEnable,
}: {
  approvalCount: number
  connected: boolean
  enabled: boolean
  onEnable: () => void
}) => {
  const [detailOpen, setDetailOpen] = useState(false)
  const status = !enabled ? '未启用' : connected ? '已连接' : '连接异常'
  const tone: TagTone = !enabled ? 'neutral' : connected ? 'success' : 'danger'
  return (
    <article style={{ width: '100%', minWidth: 0, border: '1px solid ' + colors.line, borderRadius: 12, background: colors.panelAlt, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden="true" style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: '#2563eb', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>万相 AI 中台</div>
          <div style={{ marginTop: 2, fontSize: 10, color: colors.muted }}>DataOps 连接器</div>
        </div>
        <Tag tone={tone}>{status}</Tag>
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.55, color: colors.muted }}>
        接收万相 AI 中台的审批任务
      </div>
      {detailOpen ? (
        <div style={{ borderTop: '1px solid ' + colors.line, paddingTop: 8, display: 'grid', gap: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '68px minmax(0,1fr)', gap: 8, fontSize: 10 }}>
            <span style={{ color: colors.muted }}>协议</span>
            <span style={{ color: colors.text }}>DataOps Task Center API</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '68px minmax(0,1fr)', gap: 8, fontSize: 10 }}>
            <span style={{ color: colors.muted }}>审批任务</span>
            <span style={{ color: colors.text }}>{approvalCount}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '68px minmax(0,1fr)', gap: 8, fontSize: 10 }}>
            <span style={{ color: colors.muted }}>能力</span>
            <span style={{ color: colors.text }}>审批 / 通用任务 / AI 受理</span>
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
        <Button size="sm" variant="ghost" onClick={() => setDetailOpen((value) => !value)}>{detailOpen ? '收起' : '详情'}</Button>
        <Button size="sm" variant={enabled ? 'outline' : 'primary'} disabled={enabled} onClick={onEnable}>{enabled ? '已启用' : '启用'}</Button>
      </div>
    </article>
  )
}

type TaskTab = 'all' | 'mine' | 'personal' | 'group' | 'connectors'

const TaskCenterButton = ({ openSession }: { openSession: (sessionId: string) => void }) => {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TaskTab>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [aiBusyId, setAiBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSource, setDraftSource] = useState('manual')
  const [createBusy, setCreateBusy] = useState(false)
  const [selected, setSelected] = useState<TaskItem | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const [connectorEnabled, setConnectorEnabled] = useState(() => {
    try { return window.localStorage.getItem(CONNECTOR_STORAGE_KEY) === 'true' } catch { return false }
  })
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    if (document.getElementById(TASK_BUS_STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = TASK_BUS_STYLE_ID
    style.textContent = TASK_BUS_MODAL_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, [])

  useEffect(() => {
    const update = () => {
      const collapsed = document.querySelector('[data-sidebar-collapsed="true"]') !== null
      if (collapsed) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const buttons = Array.from(document.querySelectorAll('button'))
      const toggle = buttons.find((button) => /收起侧边栏|Collapse sidebar/i.test((button.getAttribute('aria-label') ?? '').trim()))
      if (!toggle) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const label = (toggle.getAttribute('aria-label') ?? '').trim()
      if (/展开侧边栏|Expand sidebar/i.test(label)) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const rect = toggle.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const next = { left: Math.max(8, rect.left - 36), top: rect.top + (rect.height - 28) / 2 }
      setAnchor((current) => (
        current !== null && Math.abs(current.left - next.left) < 0.5 && Math.abs(current.top - next.top) < 0.5
          ? current
          : next
      ))
    }
    update()
    const timer = window.setInterval(update, 400)
    window.addEventListener('resize', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', update)
    }
  }, [])

  const load = async (silent = false) => {
    if (!connectorEnabled) {
      setTasks([])
      setLoading(false)
      setError(null)
      return
    }
    if (!silent) setLoading(true)
    setError(null)
    try {
      const overview = await fetchJson<{ items: TaskItem[] }>('/overview')
      setTasks([...overview.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const enableConnector = () => {
    setConnectorEnabled(true)
    try { window.localStorage.setItem(CONNECTOR_STORAGE_KEY, 'true') } catch { /* local preference only */ }
  }

  useEffect(() => {
    if (!open) return
    if (!connectorEnabled) {
      setTab('connectors')
      setTasks([])
      setError(null)
      setLoading(false)
      return
    }
    void load()
    const timer = window.setInterval(() => { void load(true) }, 60_000)
    return () => { window.clearInterval(timer) }
  }, [open, connectorEnabled])

  useEffect(() => {
    if (!connectorEnabled) {
      setPendingCount(0)
      return
    }
    let alive = true
    const refresh = async () => {
      try {
        const result = await fetchJson<{ count?: number }>('/count')
        if (alive) setPendingCount(Math.max(0, Math.trunc(Number(result.count) || 0)))
      } catch {
        // The panel's overview error is the visible connection state; the badge keeps its last value.
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 300_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [connectorEnabled])


  const filtered = useMemo(() => tasks.filter((task) => {
    if (tab === 'connectors') return task.sourceType === 'dataops_approval'
    if (tab === 'group') return task.sourceType === 'task_bus' && task.source.type.includes('group')
    if (tab === 'mine') return task.status !== 'completed' && task.status !== 'cancelled'
    if (tab === 'personal') return task.sourceType === 'task_bus' && !task.source.type.includes('group')
    return true
  }), [tasks, tab])

  const actionable = tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled').length
  const tabItems: [SegmentedTab<TaskTab>, ...SegmentedTab<TaskTab>[]] = [
    { value: 'all', id: 'task-bus-tab-all', panelId: 'task-bus-panel-all', label: <span>全部 <span style={{ opacity: 0.55 }}>{tasks.length}</span></span> },
    { value: 'mine', id: 'task-bus-tab-mine', panelId: 'task-bus-panel-mine', label: <span>待我处理 <span style={{ opacity: 0.55 }}>{actionable}</span></span> },
    { value: 'personal', id: 'task-bus-tab-personal', panelId: 'task-bus-panel-personal', label: <span>个人 <span style={{ opacity: 0.55 }}>{tasks.filter((task) => task.sourceType === 'task_bus' && !task.source.type.includes('group')).length}</span></span> },
    { value: 'group', id: 'task-bus-tab-group', panelId: 'task-bus-panel-group', label: <span>群聊 <span style={{ opacity: 0.55 }}>{tasks.filter((task) => task.sourceType === 'task_bus' && task.source.type.includes('group')).length}</span></span> },
    { value: 'connectors', id: 'task-bus-tab-connectors', panelId: 'task-bus-panel-connectors', label: <span>连接器 <span style={{ opacity: 0.55 }}>1</span></span> },
  ]

  const transition = async (task: TaskItem, action: string) => {
    setBusyId(task.id)
    setError(null)
    try {
      await fetch(ROUTE + '/generic/' + encodeURIComponent(task.id.slice(5)) + '/transition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(payload?.error ?? '任务操作失败')
        }
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  const createTask = async () => {
    const title = draftTitle.trim()
    if (!title) return
    setCreateBusy(true)
    setError(null)
    try {
      const response = await fetch(ROUTE + '/generic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, sourceType: draftSource }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? '创建任务失败')
      setDraftTitle('')
      setCreating(false)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreateBusy(false)
    }
  }

  const aiAccept = async (task: TaskItem) => {
    setAiBusyId(task.id)
    setError(null)
    try {
      const response = await fetch(ROUTE + '/ai-accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: task.id }),
      })
      const payload = await response.json() as { sessionId?: string; error?: string }
      if (!response.ok || typeof payload.sessionId !== 'string') {
        throw new Error(payload.error ?? 'AI 受理会话创建失败')
      }
      openSession(payload.sessionId)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAiBusyId(null)
    }
  }

  return (
    <>
      {anchor !== null ? (
        <button
          type="button"
          aria-label="任务中心"
          title="任务中心"
          onClick={() => setOpen((value) => !value)}
          style={{
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            zIndex: 45,
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: actionable > 0 ? colors.accent : colors.muted,
            cursor: 'pointer',
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {pendingCount > 0 ? (
            <span style={{ position: 'absolute', bottom: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 999, background: '#2563eb', color: '#fff', fontSize: 9, lineHeight: '14px', textAlign: 'center' }}>
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          ) : null}
        </button>
      ) : null}

      <Modal open={open} onClose={() => setOpen(false)} title="任务中心" headless className={TASK_BUS_MODAL_CLASS}>
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '22px 24px 12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: colors.text }}>任务中心</h2>
            </div>
            <Button size="sm" variant="outline" disabled={!connectorEnabled} onClick={() => setCreating((value) => !value)}>新建</Button>
            <Button size="sm" variant="ghost" onClick={() => void load()}>刷新</Button>
            <Button size="sm" variant="ghost" aria-label="关闭" title="关闭" onClick={() => setOpen(false)} icon={<IconCloseOutlineRegular size={14} />} style={{ width: 28, padding: 0 }} />
          </header>
          <div style={{ padding: '0 24px 14px', borderBottom: '1px solid ' + colors.line }}>
            <SegmentedTabs items={tabItems} value={tab} onChange={setTab} label="任务中心分类" />
          </div>
          {creating ? (
            <div style={{ margin: '0 24px 12px', padding: 12, border: '1px solid ' + colors.line, borderRadius: 9, display: 'grid', gap: 7 }}>
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="任务标题，例如：整理演示材料"
                autoFocus
                style={{ ...buttonStyle, cursor: 'text', padding: '7px 9px' }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={draftSource} onChange={(event) => setDraftSource(event.target.value)} style={{ ...buttonStyle, padding: '6px 8px' }}>
                  <option value="manual">手工任务</option>
                  <option value="session">会话任务</option>
                  <option value="group">群聊任务</option>
                </select>
                <Button size="sm" variant="primary" disabled={createBusy || draftTitle.trim() === ''} onClick={() => void createTask()}>
                  {createBusy ? '创建中…' : '创建'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>取消</Button>
              </div>
            </div>
          ) : null}
          {error ? <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fef2f2', color: colors.danger, fontSize: 11, margin: '0 24px 12px' }}>{error}</div> : null}
          <div id={'task-bus-panel-' + tab} role="tabpanel" aria-labelledby={'task-bus-tab-' + tab} style={{ padding: '16px 24px 24px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', flex: 1 }}>
            {selected !== null ? (
              <TaskDetail task={selected} onBack={() => setSelected(null)} />
            ) : (
              <>
                {tab === 'connectors' ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 320px))', gap: 10 }}><DataOpsConnectorCard approvalCount={tasks.filter((task) => task.sourceType === 'dataops_approval').length} connected={error === null} enabled={connectorEnabled} onEnable={enableConnector} /></div> : null}
                {loading ? <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>正在加载…</div> : null}
                {!loading && filtered.length === 0 ? <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>{tab === 'connectors' ? (connectorEnabled ? '暂无来自该连接器的任务' : '启用连接器后在此显示任务') : '暂无任务'}</div> : null}
                {!loading && tab === 'connectors' && filtered.length > 0 ? <div style={{ fontSize: 10, color: colors.muted }}>来自该连接器的任务</div> : null}
                {!loading && filtered.map((task) => (
                  <TaskCard key={task.id} task={task} busy={busyId === task.id} aiBusy={aiBusyId === task.id} onTransition={(item, action) => void transition(item, action)} onAiAccept={(item) => void aiAccept(item)} onOpen={setSelected} />
                ))}
              </>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}



interface HistoryEntry {
  key: string
  role: 'user' | 'assistant'
  author: string
  time: number | undefined
  text: string
  jumpId?: string
}

const HISTORY_CONTENT_TYPES = new Set(['user/message', 'assistant/message'])

const historyText = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n').trim()
}

const historyRole = (event: Record<string, unknown>): 'user' | 'assistant' => {
  const data = event.data as Record<string, unknown> | undefined
  return data?.role === 'user' || event.type === 'user/message' ? 'user' : 'assistant'
}

const historyAuthor = (event: Record<string, unknown>, role: 'user' | 'assistant'): string => {
  const data = event.data as Record<string, unknown> | undefined
  const source = data?.source as Record<string, unknown> | undefined
  const memberName = typeof source?.memberName === 'string' ? source.memberName.trim() : ''
  if (memberName !== '') return memberName
  return role === 'user' ? '我' : '助手'
}

const groupHistory = async (roomId: string): Promise<HistoryEntry[]> => {
  const entries: HistoryEntry[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const suffix = cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)
    const response = await fetch('/dsh-group-chat/api/rooms/' + encodeURIComponent(roomId) + '/events' + suffix)
    if (!response.ok) throw new Error('消息记录加载失败')
    const payload = await response.json() as { events?: Array<{ id?: string; event?: Record<string, unknown>; createdAt?: string }>; nextCursor?: string | null; hasMore?: boolean }
    for (const record of payload.events ?? []) {
      const event = record.event
      if (event === undefined || typeof event.type !== 'string' || !HISTORY_CONTENT_TYPES.has(event.type)) continue
      const data = event.data as Record<string, unknown> | undefined
      const role = historyRole(event)
      const text = historyText(data?.content)
      if (text === '') continue
      entries.push({ key: record.id ?? String(event.seq ?? entries.length), role, author: historyAuthor(event, role), time: typeof event.time === 'number' ? event.time : undefined, text, jumpId: record.id })
    }
    if (payload.hasMore !== true || payload.nextCursor === null || payload.nextCursor === undefined) break
    cursor = payload.nextCursor
  }
  return entries.sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
}

const sessionHistory = async (sessionId: string, sessions: unknown): Promise<HistoryEntry[]> => {
  const service = sessions as {
    retain?: (id: string, options: { source: string }) => {
      ready?: Promise<unknown>
      binding?: {
        eventSource?: { getSnapshot(): { entries?: Array<{ type?: string; event?: Record<string, unknown> }> } }
        session?: { loadOlder?: () => Promise<void> }
      }
      release?: () => void
    }
  }
  if (service.retain === undefined) return []
  const reference = service.retain(sessionId, { source: 'gateway' })
  try {
    await reference.ready
    const binding = reference.binding
    if (binding === undefined) return []
    await binding.session?.loadOlder?.().catch(() => undefined)
    const entries = binding.eventSource?.getSnapshot().entries ?? []
    return entries
      .filter((entry): entry is { type: 'event'; event: Record<string, unknown> } => entry.type === 'event' && entry.event !== undefined)
      .filter((entry) => typeof entry.event.type === 'string' && HISTORY_CONTENT_TYPES.has(entry.event.type))
      .map((entry) => {
        const event = entry.event
        const data = event.data as Record<string, unknown> | undefined
        const role = historyRole(event)
        return {
          key: String(event.seq ?? entries.indexOf(entry)),
          role,
          author: historyAuthor(event, role),
          time: typeof event.time === 'number' ? event.time : undefined,
          text: historyText(data?.content),
        }
      })
      .filter((entry) => entry.text !== '')
      .sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
  } finally {
    reference.release?.()
  }
}

const HistoryGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth="1.5">
    <path d="M2.4 6.8A5.6 5.6 0 1 1 2.4 9.2" stroke="currentColor" strokeLinecap="round" />
    <path d="M2.2 3.4v3.4h3.4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 5.4V8l1.9 1.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)


interface FileAttachmentRef {
  attachmentId: string
  name: string
  bytes: number
}

const fileAttachmentIn = (content: unknown, name: string): FileAttachmentRef | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'file') continue
    const attachment = record.attachment as Record<string, unknown> | undefined
    if (attachment?.name === name && typeof attachment.attachmentId === 'string' && typeof attachment.bytes === 'number') {
      return { attachmentId: attachment.attachmentId, name, bytes: attachment.bytes }
    }
  }
  return undefined
}

const sessionFileAttachment = async (sessionId: string, sessions: unknown, name: string): Promise<FileAttachmentRef | undefined> => {
  const service = sessions as {
    retain?: (id: string, options: { source: string }) => {
      ready?: Promise<unknown>
      binding?: {
        eventSource?: { getSnapshot(): { entries?: Array<{ type?: string; event?: Record<string, unknown> }> } }
        session?: { loadOlder?: () => Promise<void> }
      }
      release?: () => void
    }
  }
  if (service.retain === undefined) return undefined
  const reference = service.retain(sessionId, { source: 'gateway' })
  try {
    await reference.ready
    const binding = reference.binding
    if (binding === undefined) return undefined
    const find = (): FileAttachmentRef | undefined => {
      const entries = binding.eventSource?.getSnapshot().entries ?? []
      for (const entry of entries) {
        if (entry.type !== 'event' || entry.event === undefined) continue
        if (entry.event.type !== 'user/message') continue
        const data = entry.event.data as Record<string, unknown> | undefined
        const found = fileAttachmentIn(data?.content, name)
        if (found !== undefined) return found
      }
      return undefined
    }
    let found = find()
    for (let page = 0; page < 5 && found === undefined; page += 1) {
      await binding.session?.loadOlder?.().catch(() => undefined)
      found = find()
    }
    return found
  } finally {
    reference.release?.()
  }
}

const HistoryButton = ({ sessionId, sessions }: { sessionId: string; sessions: unknown }) => {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const isGroup = sessionId.startsWith('group-room-')

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError('')
    const load = isGroup ? groupHistory(sessionId.slice('group-room-'.length)) : sessionHistory(sessionId, sessions)
    void load.then((items) => { if (alive) setEntries(items) })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, isGroup, sessionId, sessions])


  const jump = (entry: HistoryEntry) => {
    setOpen(false)
    window.setTimeout(() => {
      let target: HTMLElement | null = entry.jumpId === undefined
        ? null
        : document.querySelector<HTMLElement>('[data-group-chat-message="' + CSS.escape(entry.jumpId) + '"]')
      if (target === null) {
        const needle = entry.text.slice(0, 80)
        target = [...document.querySelectorAll<HTMLElement>('[data-group-chat-message], [data-slot="conversation.user.text.node"]')]
          .find((element) => (element.innerText ?? '').includes(needle)) ?? null
      }
      if (target === null && (window as unknown as { find: (...args: unknown[]) => boolean }).find(entry.text.slice(0, 80), false, false, true, false, false, false)) {
        const selection = window.getSelection()
        const node = selection?.anchorNode
        target = node instanceof HTMLElement ? node : node?.parentElement ?? null
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (target !== null) {
        target.style.outline = '2px solid #2563eb'
        target.style.outlineOffset = '4px'
        window.setTimeout(() => { target!.style.outline = ''; target!.style.outlineOffset = '' }, 1800)
      }
    }, 80)
  }

  return (
    <>
      <button
        type="button"
        aria-label="消息记录"
        title="消息记录"
        data-session-id={sessionId}
        onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
      >
        <HistoryGlyph />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="消息记录" closeLabel="关闭">
        <div style={{ width: 'min(760px, 82vw)', maxHeight: '62vh', overflowY: 'auto', display: 'grid', gap: 8, padding: '4px 0 8px' }}>
          {loading ? <div style={{ padding: 24, textAlign: 'center', color: colors.muted, fontSize: 12 }}>正在加载消息记录…</div> : null}
          {error !== '' ? <div style={{ padding: 12, color: colors.danger, fontSize: 12 }}>{error}</div> : null}
          {!loading && error === '' && entries.length === 0 ? <div style={{ padding: 24, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无消息记录</div> : null}
          {!loading && error === '' && entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => jump(entry)}
              style={{ display: 'grid', gap: 5, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid ' + colors.line, background: colors.panelAlt, color: colors.text, cursor: 'pointer' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: colors.muted }}>
                <span style={{ fontWeight: 650, color: entry.role === 'user' ? '#2563eb' : colors.text }}>{entry.author}</span>
                {entry.time === undefined ? null : <span>{new Date(entry.time).toLocaleString()}</span>}
                <span style={{ marginLeft: 'auto' }}>跳到该消息</span>
              </span>
              <span style={{ fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{entry.text}</span>
            </button>
          ))}
        </div>
      </Modal>
    </>
  )
}

export const apply = (ctx: Context) => {
  const surface = ctx as unknown as {
    slots: {
      inject(name: string, factory: () => () => void): () => void
      register(options: Record<string, unknown>, component: (props: never) => JSX.Element | null): () => void
    }
    uiWorkspace: { openSession(sessionId: string): void }
  }
  const surfaceWithServices = surface as unknown as {
    sidebarRight?: { openResource?(address: string): void }
    get?: (name: string) => unknown
  }
  const sidebarRight = (surfaceWithServices.sidebarRight ?? surfaceWithServices.get?.('sidebarRight')) as
    { openResource?(address: string): void } | undefined
  // Native file cards are spans owned by the official Chat renderer, so delegate from the
  // document. The active Session header carries its id; group rooms have their own handler.
  ctx.effect(() => {
    const onFileClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest('[data-message-attachments] > *')
      if (!(card instanceof HTMLElement)) return
      const header = document.querySelector<HTMLElement>('button[aria-label="消息记录"][data-session-id]')
      const sessionId = header?.getAttribute('data-session-id') ?? ''
      if (sessionId === '' || sessionId.startsWith('group-room-')) return
      const name = (card.getAttribute('title') ?? card.innerText.split('\n')[0] ?? '').trim()
      if (name === '') return
      void (async () => {
        const attachment = await sessionFileAttachment(sessionId, (ctx as unknown as { sessions: unknown }).sessions, name)
        if (attachment === undefined) return
        const sessionState = (ctx as unknown as {
          sessions?: { list?: { getSnapshot(): { byId?: Record<string, { cwd?: string }> } } }
        }).sessions?.list?.getSnapshot()
        const cwd = sessionState?.byId?.[sessionId]?.cwd ?? ''
        const query = 'attachmentId=' + encodeURIComponent(attachment.attachmentId)
          + '&name=' + encodeURIComponent(attachment.name)
          + '&bytes=' + encodeURIComponent(String(attachment.bytes))
          + (cwd === '' ? '' : '&cwd=' + encodeURIComponent(cwd))
        const response = await fetch(ROUTE + '/attachment-materialize?' + query)
        if (!response.ok) throw new Error('附件预览准备失败')
        const materialized = await response.json() as { path?: string }
        if (typeof materialized.path !== 'string') throw new Error('附件预览路径缺失')
        const address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId)
          + '/' + materialized.path.split('/').map((part) => encodeURIComponent(part)).join('/')
        const right = (ctx as unknown as { sidebarRight?: { openResource?(address: string): void } }).sidebarRight
        if (right?.openResource !== undefined) right.openResource(address)
        else window.open(new URL('/dsh-task-bus/api/attachment-materialize?' + query, window.location.origin).toString(), '_blank', 'noopener,noreferrer')
      })().catch((cause) => { console.error('[task-bus] file preview failed', cause) })
    }
    document.addEventListener('click', onFileClick, true)
    return () => { document.removeEventListener('click', onFileClick, true) }
  }, 'task-bus: native file card preview')
  const Surface = () => <TaskCenterButton openSession={(sessionId) => surface.uiWorkspace.openSession(sessionId)} />
  ctx.effect(() => surface.slots.inject('shell.overlay', () => surface.slots.register(
    { name: 'shell.overlay', id: 'task-bus.center' },
    Surface,
  )), 'task-bus: Task Center overlay')

  // The native header's file-manager jump is the slot this product wants for session history.
  // Hide that one button rather than replacing the whole header seat; every other native
  // control keeps its position and behavior.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'task-bus-history-replaces-file-manager'
    style.textContent = 'button[aria-label="用 文件管理器 打开"] { display: none !important; }\n[data-message-attachments] > * { cursor: pointer; }'
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'task-bus: replace file manager header button')

  ctx.effect(() => surface.slots.inject('conversation.session.header.utilities', () => surface.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'task-bus.history',
    order: -4,
    inject: ((sessionId: string) => ({ sessionId, sessions: (ctx as unknown as { sessions: unknown }).sessions })) as never,
  } as never, HistoryButton as never)), 'task-bus: message history')
}