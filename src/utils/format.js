// 格式化工具
export const cx = (...a) => a.filter(Boolean).join(' ')

export const fmtMs = (ms) =>
  ms >= 1000 ? `${+(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`

export const fmtNum = (n) => n.toLocaleString('en-US')

export const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

export const fmtCost = (c) => `$${c.toFixed(4)}`

export const fmtPct = (p) => `${(p * 100).toFixed(1)}%`

export function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
