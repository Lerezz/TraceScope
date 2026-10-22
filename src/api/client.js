// 实时数据源客户端：从网关拉取 Trace（失败返回 null，前端回退 Mock）
// 携带 x-traces-fp 指纹：数据未变化时网关返回空体，这里返回 'unchanged'，
// 调用方据此跳过 setState，避免每 4s 全量解析 MB 级 JSON 与整树重渲染
let lastFp = null

export async function fetchLiveTraces() {
  try {
    const headers = { accept: 'application/json' }
    if (lastFp) headers['x-traces-fp'] = lastFp
    const r = await fetch('/api/traces', { headers })
    if (!r.ok) return null
    const fp = r.headers.get('x-traces-fp')
    if (fp && fp === lastFp) return 'unchanged'
    const d = await r.json()
    if (fp) lastFp = fp
    return Array.isArray(d.traces) && d.traces.length ? d.traces : null
  } catch {
    return null
  }
}

export async function clearLiveTraces() {
  try {
    await fetch('/api/traces', { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}
