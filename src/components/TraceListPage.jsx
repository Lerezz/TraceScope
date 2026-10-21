import { useMemo, useState } from 'react'
import StatsCards from './StatsCards.jsx'
import { Reveal } from '../hooks/useReveal.jsx'
import { fmtMs, fmtNum, fmtCost, timeAgo, cx } from '../utils/format.js'
import { IconChevron } from './icons.jsx'

const SEG = [
  { key: 'all', label: '全部' },
  { key: 'ok', label: '成功' },
  { key: 'error', label: '错误' },
]

export default function TraceListPage({ traces, onOpen }) {
  const [status, setStatus] = useState('all')

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (status !== 'all' && (t.tree.status === 'error') !== (status === 'error')) return false
      return true
    })
  }, [traces, status])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Traces</h1>
          <p className="page-sub">LLM 网关 · 模型调用轨迹（含主 / 子 Agent 层级）</p>
        </div>
      </div>

      <StatsCards traces={traces} />

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="状态筛选">
          {SEG.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={status === s.key}
              className={cx('seg-btn', status === s.key && 'active')}
              onClick={() => setStatus(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">{filtered.length} 条 Trace</span>
      </div>

      <Reveal>
        <div className="card trace-table" role="table" aria-label="Trace 列表">
          <div className="thead" role="row">
            <span role="columnheader">TRACE</span>
            <span role="columnheader">状态</span>
            <span role="columnheader" className="th-num col-spans">SPANS</span>
            <span role="columnheader" className="col-model">模型</span>
            <span role="columnheader" className="th-num">延迟</span>
            <span role="columnheader" className="th-num col-tokens">TOKENS</span>
            <span role="columnheader" className="th-num col-cost">费用</span>
            <span role="columnheader" className="th-num">时间</span>
          </div>
          {filtered.map((t) => {
            const s = t._stats
            const err = t.tree.status === 'error'
            const models = s.models.slice(0, 2)
            return (
              <button
                key={t.id}
                className="trace-row"
                role="row"
                onClick={() => onOpen(t.id)}
                aria-label={`打开 Trace ${t.name}`}
              >
                <span className="cell" role="cell">
                  <div className="trace-name">{t.name}</div>
                  <div className="trace-sub">
                    <span className="tid">{t.id}</span>
                    <span className="tq">{t.query}</span>
                  </div>
                </span>
                <span className="cell" role="cell">
                  <span className="status-txt">
                    <i className={cx('dot', err ? 'dot-err' : 'dot-ok')} />
                    {err ? '失败' : '成功'}
                  </span>
                </span>
                <span className="cell cell-num col-spans" role="cell">{s.spans}</span>
                <span className="cell col-model" role="cell">
                  <span className="model-chips">
                    {models.map((m) => <span key={m} className="chip chip-model">{m}</span>)}
                    {s.models.length > 2 && <span className="chip">+{s.models.length - 2}</span>}
                  </span>
                </span>
                <span className={cx('cell cell-num', err && 'err')} role="cell">{fmtMs(s.duration)}</span>
                <span className="cell cell-num col-tokens" role="cell">{fmtNum(s.tok)}</span>
                <span className="cell cell-num col-cost" role="cell">{fmtCost(s.cost)}</span>
                <span className="cell cell-time" role="cell">{timeAgo(t.ts)}</span>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="empty-state">没有匹配的 Trace，试试调整筛选或时间范围。</div>
          )}
        </div>
      </Reveal>

      <p className="page-foot">TraceScope · Mock 数据演示 · 亮色工程台</p>
    </div>
  )
}
