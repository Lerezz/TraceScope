import { useEffect, useMemo, useState } from 'react'
import StatsCards from './StatsCards.jsx'
import { Reveal } from '../hooks/useReveal.jsx'
import { fmtMs, fmtNum, fmtCost, timeAgo, cx } from '../utils/format.js'
import { originMeta } from '../utils/trace.js'
import { IconChevron } from './icons.jsx'

const SEG = [
  { key: 'all', label: '全部' },
  { key: 'ok', label: '成功' },
  { key: 'error', label: '错误' },
]
const PAGE_SIZES = [10, 20, 50, 100, 200]

export default function TraceListPage({ traces, onOpen }) {
  const [status, setStatus] = useState('all')
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (status !== 'all' && (t.tree.status === 'error') !== (status === 'error')) return false
      return true
    })
  }, [traces, status])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  // 筛选 / 页大小变化后页码越界时自动收敛
  const curPage = Math.min(page, totalPages)
  useEffect(() => {
    setPage(Math.min(page, totalPages))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages, pageSize, status])
  const paged = useMemo(
    () => filtered.slice((curPage - 1) * pageSize, curPage * pageSize),
    [filtered, curPage, pageSize],
  )
  const goto = (p) => {
    setPage(p)
    document.querySelector('.trace-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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
        <div className="pager">
          <label className="pager-size">
            每页
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="每页条数"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>{n} 条</option>
              ))}
            </select>
          </label>
          <button className="btn btn-sm" disabled={curPage <= 1} onClick={() => goto(curPage - 1)}>
            <IconChevron width={12} height={12} style={{ transform: 'rotate(180deg)' }} /> 上一页
          </button>
          <span className="pager-info">{filtered.length ? curPage : 0} / {totalPages} 页 · {filtered.length} 条</span>
          <button className="btn btn-sm" disabled={curPage >= totalPages} onClick={() => goto(curPage + 1)}>
            下一页 <IconChevron width={12} height={12} />
          </button>
        </div>
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
          {paged.map((t) => {
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
                  <div className="trace-name">
                    {t.name}
                    <span className={cx('origin-chip', originMeta(t).cls)}>{originMeta(t).label}</span>
                  </div>
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
