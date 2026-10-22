import { useEffect, useState } from 'react'
import { cx, fmtMs, fmtNum, fmtCost } from '../utils/format.js'
import { TYPE_ICON, TYPE_LABEL } from './SpanTree.jsx'
import { IconClose, IconCopy, IconCheck, IconBranch } from './icons.jsx'

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'meta', label: '元数据' },
  { key: 'json', label: 'RAW JSON' },
]

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={cx('copy-btn', copied && 'copied')}
      aria-label={copied ? '已复制' : '复制 JSON'}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用时静默 */ }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <IconCheck width={13} height={13} /> : <IconCopy width={13} height={13} />}
    </button>
  )
}

// JSON 块：默认限高滚动，可展开全量
function JsonBlock({ data, clampHeight = 260 }) {
  const [open, setOpen] = useState(false)
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const isLong = text.length > 600
  return (
    <div>
      <div className={cx('json-view', isLong && !open && 'clamp')} style={isLong && !open ? { maxHeight: clampHeight } : undefined}>
        <CopyBtn text={text} />
        <pre>{text}</pre>
      </div>
      {isLong && (
        <button className="clamp-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : `展开全量（${text.length.toLocaleString('en-US')} 字符）`}
        </button>
      )}
    </div>
  )
}

// 单条消息：默认折叠（限高 + 渐隐），点击按钮独立展开全量 / 再点收起
function MessageBlock({ role, kind, content }) {
  const [open, setOpen] = useState(false)
  const isText = typeof content === 'string'
  const isLong = isText ? content.length > 240 : JSON.stringify(content || {}).length > 600
  const label = role === 'user' && kind === 'tool_result' ? 'tool result' : role
  return (
    <div className={`msg role-${role}${kind === 'tool_result' ? ' kind-tool' : ''}`}>
      <span className="msg-role">{label}</span>
      <div className={cx('msg-body', isLong && !open && 'clamp')}>
        {isText ? content : <pre className="msg-json">{JSON.stringify(content, null, 2)}</pre>}
      </div>
      {isLong && (
        <button className="clamp-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : `展开全量（${(isText ? content.length : JSON.stringify(content).length).toLocaleString('en-US')} 字符）`}
        </button>
      )}
    </div>
  )
}

// 输入/输出渲染：system + messages 数组（每条独立展开）；对象 → JSON；字符串 → 单条消息
// system 全文经 trace.systems 去重表按 systemHash 解析（兼容 mock 数据的 input.system 直填）
function PayloadView({ data, systems }) {
  if (data == null) return <div className="empty-hint">无内容</div>
  const sys =
    (systems && data.systemHash != null && systems[data.systemHash]) ||
    (typeof data.system === 'string' && data.system.trim() ? data.system : null)
  const msgs = Array.isArray(data.messages) ? data.messages : null

  if (sys || msgs) {
    return (
      <div>
        {sys && <MessageBlock role="system" content={sys} />}
        {msgs?.map((m, i) => (
          <MessageBlock key={i} role={m.role || 'text'} kind={m.msgKind} content={m.content} />
        ))}
      </div>
    )
  }
  if (typeof data === 'object') return <JsonBlock data={data} />
  return <MessageBlock role="text" content={String(data)} />
}

function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.map(([k, v, cls]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd className={cls}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function OverviewTab({ span }) {
  const rows = [
    ['类型', TYPE_LABEL[span.type]],
    ['状态', span.status === 'error' ? '失败' : '成功', span.status === 'error' ? 'err' : 'ok'],
    ['相对开始', `T+${fmtMs(span.start)}`],
    ['持续时间', fmtMs(span.end - span.start)],
    ['子调用', `${span.children?.length || 0} 个 Span`],
  ]
  if (span.model) rows.push(['模型', span.model])
  if (span.provider) rows.push(['Provider', span.provider])
  if (span.tokensIn != null) {
    rows.push(['Tokens In', fmtNum(span.tokensIn)])
    rows.push(['Tokens Out', fmtNum(span.tokensOut || 0)])
  }
  if (span.cost != null) rows.push(['费用', fmtCost(span.cost || 0)])
  if (span.metadata?.retry_of) rows.push(['重试自', span.metadata.retry_of])

  // 快速通道：本次调用的用户指令与模型输出（长内容可点开全量）
  const userMsg = [...(span.input?.messages || [])]
    .reverse()
    .find((m) => m.role === 'user' && m.msgKind !== 'tool_result')
  const outText =
    typeof span.output === 'string' ? span.output : typeof span.output?.text === 'string' ? span.output.text : null
  const toolNames = Array.isArray(span.output?.tool_uses) && span.output.tool_uses.map((t) => t.name).filter(Boolean)

  return (
    <div>
      <KV rows={rows} />
      {span.status === 'error' && span.error && <div className="error-box">{span.error}</div>}
      {userMsg?.content && (
        <div className="ovr-sec">
          <div className="ovr-title">用户输入</div>
          <MessageBlock role="user" content={userMsg.content} />
        </div>
      )}
      {(outText || toolNames?.length) && (
        <div className="ovr-sec">
          <div className="ovr-title">模型输出</div>
          {outText ? (
            <MessageBlock role="assistant" content={outText} />
          ) : (
            <div className="ovr-tools">决策调用：{toolNames.join(' / ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function DetailPanel({ entry, onClose, mobileOpen, systems }) {
  // 默认展开「概览」：概览已内含用户输入 + 模型输出快览
  const [tab, setTab] = useState('overview')
  const span = entry?.span
  useEffect(() => setTab('overview'), [span?.id])

  if (!span) {
    return (
      <aside className="detail-panel" aria-label="Span 详情">
        <div className="panel-empty">
          <IconBranch width={26} height={26} />
          <p>在左侧选择任意 Span<br />查看输入 / 输出与耗时详情</p>
        </div>
      </aside>
    )
  }

  const path = entry.path // 祖先链（含自身）→ 面包屑体现层级
  const rawJson = JSON.stringify({ ...span, children: undefined }, null, 2)

  return (
    <>
      <div className={cx('panel-backdrop', mobileOpen && 'show')} onClick={onClose} aria-hidden />
      <aside className={cx('detail-panel', mobileOpen && 'open')} aria-label="Span 详情">
        <div className="panel-head">
          <div className="panel-head-top">
            <nav className="crumbs" aria-label="调用链路">
              {path.map((s, i) => {
                const PIcon = TYPE_ICON[s.type]
                return (
                  <span key={s.id} style={{ display: 'contents' }}>
                    {i > 0 && <span className="crumb-sep">/</span>}
                    <span className={cx('crumb', i === path.length - 1 && 'current')} title={s.name}>
                      <PIcon width={11} height={11} />
                      <b>{s.name}</b>
                    </span>
                  </span>
                )
              })}
            </nav>
            <button className="panel-close" onClick={onClose} aria-label="关闭详情面板">
              <IconClose width={14} height={14} />
            </button>
          </div>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                className={cx('tab', tab === t.key && 'active')}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body">
          {tab === 'overview' && <OverviewTab span={span} />}
          {tab === 'input' && <PayloadView data={span.input} systems={systems} />}
          {tab === 'output' && (
            span.status === 'error' && span.output == null ? (
              <div className="error-box">{span.error || '调用失败，无输出'}</div>
            ) : (
              <PayloadView data={span.output} systems={systems} />
            )
          )}
          {tab === 'meta' && (
            Object.keys(span.metadata || {}).length ? (
              <KV rows={Object.entries(span.metadata).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])} />
            ) : (
              <div className="empty-hint">无元数据</div>
            )
          )}
          {tab === 'json' && <JsonBlock data={JSON.parse(rawJson)} clampHeight={420} />}
        </div>
      </aside>
    </>
  )
}
