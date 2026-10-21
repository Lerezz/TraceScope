import { useCountUp, Reveal } from '../hooks/useReveal.jsx'
import { fmtNum, fmtPct } from '../utils/format.js'
import { IconZap, IconCoins, IconClock, IconAlert, IconWallet } from './icons.jsx'

function Stat({ label, value, format, icon: Icon, tint, delta }) {
  const v = useCountUp(value)
  return (
    <div className="card card-hover stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${tint || ''}`}><Icon width={15} height={15} /></span>
      </div>
      <div className="stat-value">{format(v)}</div>
      <div className="stat-delta" dangerouslySetInnerHTML={{ __html: delta }} />
    </div>
  )
}

export default function StatsCards({ traces }) {
  const total = traces.length
  const errors = traces.filter((t) => t.tree.status === 'error').length
  let tok = 0, cost = 0, dur = 0
  traces.forEach((t) => {
    const s = t._stats
    tok += s.tok
    cost += s.cost
    dur += s.duration
  })
  const avg = total ? dur / total : 0

  return (
    <div className="stats-grid">
      <Reveal delay={0}><Stat label="请求数" value={total} format={(v) => fmtNum(Math.round(v))} icon={IconZap} delta="<span class='up'>+12.4%</span> 较昨日" /></Reveal>
      <Reveal delay={0.06}><Stat label="TOKENS 消耗" value={tok} format={(v) => fmtNum(Math.round(v))} icon={IconCoins} tint="tint-llm" delta="<span class='up'>+8.2%</span> 较昨日" /></Reveal>
      <Reveal delay={0.12}><Stat label="平均延迟" value={avg / 1000} format={(v) => `${v.toFixed(1)}s`} icon={IconClock} delta="<span class='up'>−6.1%</span> P50 4.2s" /></Reveal>
      <Reveal delay={0.18}><Stat label="错误率" value={total ? errors / total : 0} format={(v) => fmtPct(v)} icon={IconAlert} tint={errors ? 'tint-err' : 'tint-ok'} delta={errors ? `${errors} 条失败 Trace` : '无失败'} /></Reveal>
      <Reveal delay={0.24}><Stat label="总费用" value={cost} format={(v) => `$${v.toFixed(4)}`} icon={IconWallet} tint="tint-warn" delta="<span class='up'>+5.3%</span> 较昨日" /></Reveal>
    </div>
  )
}
