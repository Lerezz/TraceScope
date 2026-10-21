import { useEffect, useMemo, useState } from 'react'
import TopBar from './components/TopBar.jsx'
import TraceListPage from './components/TraceListPage.jsx'
import TraceDetailPage from './components/TraceDetailPage.jsx'
import { TRACES } from './data/mock.js'
import { treeStats } from './utils/trace.js'
import { fetchLiveTraces } from './api/client.js'

// Mock 数据预计算统计
TRACES.forEach((t) => { t._stats = treeStats(t.tree) })

const RANGE_MS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }

export default function App() {
  const [view, setView] = useState({ name: 'list' })
  const [range, setRange] = useState('24h')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(null) // 网关实时 traces；null = 网关不可用/无数据
  const [source, setSource] = useState('mock') // 'live' | 'mock'

  // 启动探测：网关有数据则自动切到实时
  useEffect(() => {
    let alive = true
    ;(async () => {
      const t = await fetchLiveTraces()
      if (alive && t) {
        setLive(t)
        setSource('live')
      }
    })()
    return () => { alive = false }
  }, [])

  // 实时模式：每 4s 轮询网关（与 Claude Code 对话时新 Trace 自动出现；数据被清空时回退 Mock）
  useEffect(() => {
    if (source !== 'live') return
    const id = setInterval(async () => {
      const t = await fetchLiveTraces()
      if (t) setLive(t)
      else {
        setLive(null)
        setSource('mock')
      }
    }, 4000)
    return () => clearInterval(id)
  }, [source])

  // 当前数据源（live / mock），统一预计算统计，避免下游读到未初始化的 _stats
  const active = useMemo(() => {
    const src = source === 'live' && live ? live : TRACES
    return src.map((t) => (t._stats ? t : { ...t, _stats: treeStats(t.tree) }))
  }, [source, live])

  const rangedTraces = useMemo(
    () => active.filter((t) => Date.now() - t.ts <= RANGE_MS[range]),
    [active, range],
  )

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rangedTraces
    return rangedTraces.filter((t) =>
      [t.id, t.name, t.query, t.user, ...t._stats.models].join(' ').toLowerCase().includes(q),
    )
  }, [rangedTraces, query])

  const openTrace = (id) => {
    setView({ name: 'detail', id })
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
  }
  const goHome = () => setView({ name: 'list' })
  const toggleSource = () => {
    if (source === 'live') setSource('mock')
    else if (live) setSource('live')
  }

  return (
    <>
      <div className="app-bg" aria-hidden />
      <TopBar
        query={query}
        setQuery={setQuery}
        range={range}
        setRange={setRange}
        showSearch={view.name === 'list'}
        onHome={goHome}
        source={source}
        liveAvailable={!!live}
        onToggleSource={toggleSource}
      />
      {view.name === 'list' ? (
        <div key="list"><TraceListPage traces={searched} onOpen={openTrace} /></div>
      ) : (
        <div key={view.id}>
          <TraceDetailPage
            trace={active.find((t) => t.id === view.id) ?? TRACES[0]}
            onBack={goHome}
          />
        </div>
      )}
    </>
  )
}
