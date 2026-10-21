import { useEffect, useState } from 'react'
import { IconSearch, IconLogo } from './icons.jsx'

export default function TopBar({ query, setQuery, range, setRange, showSearch, onHome, source, liveAvailable, onToggleSource }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 8)
    addEventListener('scroll', f, { passive: true })
    f()
    return () => removeEventListener('scroll', f)
  }, [])

  return (
    <header className={scrolled ? 'topbar scrolled' : 'topbar'}>
      <div className="topbar-inner">
        <button className="brand" onClick={onHome} aria-label="返回首页">
          <span className="brand-mark"><IconLogo /></span>
          <span className="brand-txt">
            <span className="brand-name">Trajectory</span>
            <span className="brand-sub">LLM GATEWAY 观测台</span>
          </span>
        </button>
        <span className="env-chip"><i className="dot dot-ok" />production</span>
        <button
          className={`src-chip ${source === 'live' ? 'live' : 'mock'}`}
          onClick={onToggleSource}
          disabled={!liveAvailable && source === 'mock'}
          title={liveAvailable ? '点击切换 Mock / 实时网关数据' : '网关暂无数据（启动 gateway 并通过它调用 Claude 后出现）'}
        >
          <i className="dot" />
          {source === 'live' ? '实时网关' : 'Mock 数据'}
        </button>
        <span className="topbar-spacer" />
        {showSearch && (
          <span className="searchbox-wrap">
            <IconSearch width={14} height={14} />
            <input
              className="input searchbox"
              placeholder="搜索 Trace / 模型 / 用户…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索 Trace"
            />
          </span>
        )}
        <span className="select-wrap">
          <select
            className="input select"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            aria-label="时间范围"
          >
            <option value="1h">最近 1 小时</option>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
          </select>
        </span>
        <span className="avatar" aria-hidden>LR</span>
      </div>
    </header>
  )
}
