// Trace 树遍历与统计
export function walk(root, fn) {
  fn(root)
  ;(root.children || []).forEach((c) => walk(c, fn))
}

// 扁平化：[{span, depth, path(祖先链含自身)}]
export function flatten(root) {
  const out = []
  ;(function r(node, depth, path) {
    out.push({ span: node, depth, path: [...path, node] })
    ;(node.children || []).forEach((c) => r(c, depth + 1, [...path, node]))
  })(root, 0, [])
  return out
}

export function treeStats(root) {
  let spans = 0, llm = 0, tool = 0, sub = 0, errors = 0, tok = 0, cost = 0
  const models = new Set()
  walk(root, (s) => {
    spans++
    if (s.type === 'llm') {
      llm++
      if (s.model) models.add(s.model)
      tok += (s.tokensIn || 0) + (s.tokensOut || 0)
    }
    if (s.type === 'tool') tool++
    if (s.type === 'subagent') sub++
    if (s.status === 'error') errors++
    cost += s.cost || 0
  })
  return { spans, llm, tool, sub, errors, tok, cost, models: [...models], duration: root.end - root.start }
}

// 全树渲染顺序 → 瀑布条生长动画延迟
export function orderMap(root) {
  const m = new Map()
  let i = 0
  walk(root, (s) => m.set(s.id, i++))
  return m
}

// 从树的 llm span 提取「本轮对话」消息流（按时间排序）
// 条目：{role: system|user|assistant|tool_call|tool, text, spanId}
export function extractConversation(root) {
  const spans = flatten(root)
    .map((f) => f.span)
    .filter((s) => s.type === 'llm')
    .sort((a, b) => a.start - b.start)
  const out = []
  const cut = (s, n = 300) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s))

  // 首个 llm 的 system prompt 作为开头条目
  const sys = spans.find((s) => s.input?.system)?.input?.system
  if (sys) out.push({ role: 'system', text: cut(sys, 160), spanId: spans[0]?.id })

  for (const s of spans) {
    const msgs = s.input?.messages || []
    const last = msgs[msgs.length - 1]
    if (last?.role === 'user' && last.content) {
      if (last.msgKind === 'tool_result') out.push({ role: 'tool', text: cut(last.content), spanId: s.id })
      else if (last.role !== '…') out.push({ role: 'user', text: cut(last.content), spanId: s.id })
    }
    if (typeof s.output === 'string' && s.output) out.push({ role: 'assistant', text: cut(s.output), spanId: s.id })
    else if (s.output?.tool_uses) {
      for (const t of s.output.tool_uses)
        out.push({ role: 'tool_call', text: `${t.name} · ${cut(typeof t.input === 'string' ? t.input : JSON.stringify(t.input), 100)}`, spanId: s.id })
      if (s.output.text) out.push({ role: 'assistant', text: cut(s.output.text), spanId: s.id })
    }
  }
  return out
}
