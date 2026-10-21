import { useMemo, useState } from 'react'
import SpanTree from './SpanTree.jsx'
import DetailPanel from './DetailPanel.jsx'
import { flatten, treeStats, orderMap, extractConversation } from '../utils/trace.js'
import { fmtMs, fmtNum, fmtCost, cx } from '../utils/format.js'
import { Reveal } from '../hooks/useReveal.jsx'
import { IconArrowLeft, IconUser } from './icons.jsx'

const CONV_ROLE_LABEL = { system: 'SYS', user: 'USER', assistant: 'AI', tool_call: 'CALL', tool: 'RESULT' }

const fmtTick = (ms) => `${+(ms / 1000).toFixed(1)}s`

export default function TraceDetailPage({ trace, onBack }) {
  const root = trace.tree
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [selectedId, setSelectedId] = useState(root.id)
  const [mobileOpen, setMobileOpen] = useState(false)

  const { stats, orders, maxDepth } = useMemo(() => {
    const flat = flatten(root)
    return {
      stats: treeStats(root),
      orders: orderMap(root),
      maxDepth: Math.max(...flat.map((f) => f.depth)),
    }
  }, [root])

  const selected = useMemo(
    () => flatten(root).find((f) => f.span.id === selectedId) ?? { span: root, path: [root] },
    [root, selectedId],
  )

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const collapseAll = () => setCollapsed(new Set(flatten(root).filter((f) => f.span.children?.length).map((f) => f.span.id)))
  const expandAll = () => setCollapsed(new Set())

  const onSelect = (node) => {
    setSelectedId(node.id)
    setMobileOpen(true)
  }

  const err = root.status === 'error'
  const treeCtx = { collapsed, onToggle: toggle, selectedId, onSelect, total: root.end, orders }

  // 本轮对话消息流（从 llm span 提取），点击可定位到对应 Span
  const conversation = useMemo(() => extractConversation(root), [root])
  const [convOpen, setConvOpen] = useState(true)
  const focusSpan = (spanId) => {
    if (!spanId) return
    setSelectedId(spanId)
    requestAnimationFrame(() => {
      document.querySelector(`[data-sid="${spanId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  return (
    <div className="page">
      <div className="back-row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft width={13} height={13} /> 返回 Traces
        </button>
      </div>

      <Reveal>
        <div className="card trace-header">
          <div className="th-top">
            <h1 className="trace-title">{trace.name}</h1>
            <span className={`status-badge ${err ? 'err' : 'ok'}`}>
              <i className={`dot ${err ? 'dot-err' : 'dot-ok'}`} />
              {err ? '失败' : '成功'}
            </span>
            <span className="th-id">{trace.id}</span>
          </div>
          <div className="th-query">
            <IconUser width={15} height={15} />
            <p>{trace.query}{trace.conv ? `（${trace.conv}）` : ''}</p>
          </div>
          <div className="th-meta">
            <div className="th-stat"><b>{fmtMs(stats.duration)}</b><span>总耗时</span></div>
            <div className="th-stat"><b>{stats.spans}</b><span>SPANS</span></div>
            <div className="th-stat"><b>{fmtNum(stats.tok)}</b><span>TOKENS</span></div>
            <div className="th-stat"><b>{fmtCost(stats.cost)}</b><span>费用</span></div>
            <div className="th-stat"><b>{stats.models.length}</b><span>模型</span></div>
            <div className="th-stat"><b className={stats.errors ? 'err' : ''}>{stats.errors || '0'}</b><span>错误</span></div>
          </div>
          <div className="th-chips">
            <span className="chip">层级深度 {maxDepth + 1}</span>
            <span className="chip">{stats.sub} 子 Agent</span>
            <span className="chip">{stats.llm} LLM 调用</span>
            <span className="chip">{stats.tool} 工具调用</span>
            {stats.models.map((m) => <span key={m} className="chip chip-model">{m}</span>)}
          </div>
        </div>
      </Reveal>

      <div className="trace-layout">
        <Reveal delay={0.08}>
          <div className="card tree-card" aria-label="调用层级树">
            <div className="tree-toolbar">
              <div>
                <div className="tree-title">调用层级 · Span 树</div>
                <div className="tree-sub">缩进连线 = 父级类型色 · 右侧为共享时间原点的瀑布图</div>
              </div>
              <div className="tree-actions">
                <button className="btn btn-sm" onClick={expandAll}>展开全部</button>
                <button className="btn btn-sm" onClick={collapseAll}>全部收起</button>
              </div>
            </div>
            {/* 本轮对话消息流：快速定位这轮做了什么，点击条目跳转对应 Span */}
            <section className="conv-strip" aria-label="本轮对话">
              <div className="conv-head">
                <span className="conv-title">本轮对话</span>
                <span className="conv-count">{conversation.length} 条消息 · 点击可定位到对应 Span</span>
                <button className="btn btn-ghost btn-sm conv-toggle" onClick={() => setConvOpen((o) => !o)}>
                  {convOpen ? '收起' : '展开'}
                </button>
              </div>
              {convOpen && conversation.length > 0 && (
                <div className="conv-list">
                  {conversation.map((c, i) => (
                    <button
                      key={i}
                      className={`conv-item r-${c.role}`}
                      onClick={() => focusSpan(c.spanId)}
                      title={c.text}
                    >
                      <span className="conv-role">{CONV_ROLE_LABEL[c.role] || c.role}</span>
                      <span className="conv-text">{c.text || '（空）'}</span>
                    </button>
                  ))}
                </div>
              )}
              {convOpen && conversation.length === 0 && (
                <div className="conv-empty">未提取到消息（该 Trace 无 LLM 调用）</div>
              )}
            </section>
            <div className="axis-row">
              <div className="axis-tree">调用链路</div>
              <div className="axis-wf">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className="tick" style={{ left: `${i * 25}%` }}>
                    {fmtTick((root.end * i) / 4)}
                  </span>
                ))}
              </div>
            </div>
            <SpanTree root={root} ctx={treeCtx} />
            <div className="tree-toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
              <div className="legend">
                <span className="lg-agent"><i />Agent</span>
                <span className="lg-subagent"><i />Sub-Agent</span>
                <span className="lg-llm"><i />LLM</span>
                <span className="lg-tool"><i />Tool</span>
                <span className="lg-err"><i />错误</span>
              </div>
              <div className="tree-sub">T+ 表示相对 Trace 起点</div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.16}>
          <DetailPanel entry={selected} onClose={() => setMobileOpen(false)} mobileOpen={mobileOpen} />
        </Reveal>
      </div>

      <p className="page-foot">TraceScope · Mock 数据演示 · 亮色工程台</p>
    </div>
  )
}
