// 实时数据源客户端：从网关拉取 Trace（失败返回 null，前端回退 Mock）
export async function fetchLiveTraces() {
  try {
    const r = await fetch('/api/traces', { headers: { accept: 'application/json' } })
    if (!r.ok) return null
    const d = await r.json()
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
