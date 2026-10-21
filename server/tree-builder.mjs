// ============ 层级重建：原始请求记录 → 前端可消费的 Trace 树 ============
// 结构：sessionId → 轮次(turn) → root(agent) → llm / tool / subagent(span)
// 层级推断策略：
//   1. session 从 metadata.user_id 的 `_session_` 后缀解析
//   2. 新轮次 = 请求最后一条消息是纯用户文本（而非 tool_result）
//   3. 子 Agent = 响应含 Task tool_use；其后 system 指纹变化且 Task 未关闭的请求归入子 Agent
//   4. 工具 span = 上一个请求的 tool_use 与下一个请求 tool_result 之间的时间窗

const trunc = (s, n = 300) =>
  s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s)

// 计费（每百万 token：[输入, 输出]，缓存读 0.1x / 写 1.25x）
function priceOf(model) {
  const m = model || ''
  if (/^glm/i.test(m)) return [0, 0] // GLM 系列定价未接入，暂记 0（flash 档平台免费）
  if (/opus/.test(m)) return [15, 75]
  if (/haiku/.test(m)) return [1, 5]
  return [3, 15] // sonnet 及未知默认
}
export function costOf(model, u = {}) {
  const [pin, pout] = priceOf(model)
  const inEq = (u.input_tokens || 0) + (u.cache_write || 0) * 1.25 + (u.cache_read || 0) * 0.1
  return (inEq * pin) / 1e6 + ((u.output_tokens || 0) * pout) / 1e6
}

const rel = (r, t0) => ({
  start: r.ts - t0,
  end: r.ts - t0 + (r.duration || 0),
})

function llmSpan(r, t0) {
  const { start, end } = rel(r, t0)
  const tools = r.toolUses.map((t) => t.name).filter((n) => n !== 'Task')
  const hasTask = r.toolUses.some((t) => t.name === 'Task')
  const name =
    r.status === 'error'
      ? '调用失败'
      : r.stopReason === 'tool_use'
        ? hasTask
          ? '调度子 Agent'
          : `决策 · 调用 ${tools.slice(0, 3).join(' / ')}`
        : '生成回复'
  return {
    id: `llm-${r.requestId || r.ts}`,
    type: 'llm',
    name,
    status: r.status || 'ok',
    start,
    end,
    model: r.model,
    provider: 'anthropic',
    tokensIn: (r.usage?.input_tokens || 0) + (r.usage?.cache_read || 0) + (r.usage?.cache_write || 0),
    tokensOut: r.usage?.output_tokens || 0,
    cost: r.cost || 0,
    input: { system: r.systemPreview, messages: r.messagesPreview || [] },
    output: r.toolUses.length
      ? { tool_uses: r.toolUses.map((t) => ({ name: t.name, input: t.input })), text: r.textOut || '' }
      : r.textOut || '',
    error: r.error || undefined,
    metadata: {
      stop_reason: r.stopReason,
      request_id: r.requestId,
      stream: r.stream,
      cache_read: r.usage?.cache_read,
      cache_write: r.usage?.cache_write,
      tools_offered: r.toolsOffered,
    },
    children: [],
  }
}

function toolSpan(tu, result, startRel, endRel, owner) {
  const sub = tu.name === 'Task'
  return {
    id: `tool-${tu.id}`,
    type: 'tool',
    name: sub ? `Task · ${tu.input?.subagent_type || 'subagent'}` : tu.name,
    status: result?.isError ? 'error' : 'ok',
    start: startRel,
    end: endRel,
    input: tu.input,
    output: result ? result.preview : '（结果未捕获）',
    metadata: { tool: tu.name, tool_use_id: tu.id },
    children: [],
    _owner: owner,
  }
}

function attachToolSpans(prevRec, owner, resolved, curRec, t0) {
  for (const tu of prevRec.toolUses || []) {
    if (!resolved.has(tu.id)) continue
    const startRel = prevRec.ts - t0 + (prevRec.duration || 0)
    const endRel = curRec.ts - t0
    const result = (curRec.toolResults || []).find((x) => x.toolUseId === tu.id)
    const span = toolSpan(tu, result, startRel, Math.max(endRel, startRel + 1))
    if (tu.name === 'Task') {
      // Task 工具条插到子 Agent 容器之前，保持「调用→子Agent→结果」视觉顺序
      const idx = owner.children.findIndex((c) => c.metadata?.task_tool_use_id === tu.id)
      if (idx >= 0) owner.children.splice(idx, 0, span)
      else owner.children.push(span)
    } else {
      owner.children.push(span)
    }
  }
}

function buildTurn(recs, sid, turnIdx, traceId) {
  const t0 = recs[0].ts
  const baseSysHash = recs[0].systemHash
  const queryRec = recs.find((r) => r.newTurn)
  const query = trunc(queryRec?.query || recs[0].messagesPreview?.[0]?.content || '', 120)

  const root = {
    id: `${traceId}-root`,
    type: 'agent',
    name: 'Claude Code · 主 Agent',
    status: 'ok',
    start: 0,
    end: 0,
    input: { messages: [{ role: 'user', content: query }] },
    output: '',
    metadata: { agent: 'claude-code', session: sid, turn: turnIdx + 1 },
    children: [],
  }

  let curSub = null // { taskId, node }
  let prevMain = null
  let prevSub = null

  for (const r of recs) {
    const resolved = new Set((r.toolResults || []).map((t) => t.toolUseId))
    const isSub = (r.subagentHint || r.systemHash !== baseSysHash) && curSub

    if (isSub) {
      if (prevSub) attachToolSpans(prevSub, curSub.node, resolved, r, t0)
      const span = llmSpan(r, t0)
      curSub.node.children.push(span)
      curSub.node.end = Math.max(curSub.node.end, span.end)
      prevSub = r
    } else {
      // 主链请求若带回了 Task 的 tool_result → 关闭子 Agent 容器
      if (curSub && resolved.has(curSub.taskId)) {
        curSub.node.end = r.ts - t0
        curSub = null
        prevSub = null
      }
      if (prevMain) attachToolSpans(prevMain, root, resolved, r, t0)
      root.children.push(llmSpan(r, t0))
      prevMain = r
    }

    // 响应中出现 Task tool_use → 开子 Agent 容器
    if (!curSub) {
      const tu = (r.toolUses || []).find((t) => t.name === 'Task')
      if (tu) {
        const subType = tu.input?.subagent_type || 'subagent'
        curSub = {
          taskId: tu.id,
          node: {
            id: `sub-${tu.id}`,
            type: 'subagent',
            name: `子 Agent · ${subType}`,
            status: 'ok',
            start: r.ts - t0 + (r.duration || 0),
            end: r.ts - t0 + (r.duration || 0),
            input: {
              subagent_type: subType,
              description: trunc(tu.input?.description, 160),
              prompt: trunc(tu.input?.prompt, 400),
            },
            output: '',
            metadata: { agent: subType, task_tool_use_id: tu.id, spawned_by: 'Task' },
            children: [],
          },
        }
        root.children.push(curSub.node)
      }
    }
  }

  // 收尾
  if (curSub) curSub.node.end = curSub.node.end || root.end
  for (const c of root.children) if (c.type === 'subagent') root.output = c.output || root.output
  root.end = Math.max(...root.children.flatMap((c) => [c.end, ...c.children.map((g) => g.end)]), 0) || 0
  const walk = (n) => [n, ...n.children.flatMap(walk)]
  root.status = walk(root).some((n) => n.status === 'error') ? 'error' : 'ok'
  root.output = (() => {
    const last = [...root.children].reverse().find((c) => c.type === 'llm')
    return typeof last?.output === 'string' ? trunc(last.output, 400) : root.output
  })()
  // 子 Agent 容器的输出 = 其最后一个 llm 的文本
  for (const c of root.children)
    if (c.type === 'subagent') {
      const last = [...c.children].reverse().find((g) => g.type === 'llm')
      c.output = typeof last?.output === 'string' ? trunc(last.output, 300) : ''
    }

  return {
    id: traceId,
    name: `Claude Code · ${trunc(query, 26) || '会话'}`,
    ts: t0,
    user: recs[0].userHash || 'claude-code',
    conv: `session ${sid.slice(0, 10)} · 第 ${turnIdx + 1} 轮`,
    query,
    tree: root,
  }
}

export function buildTraces(records) {
  const bySession = new Map()
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
    if (r.aux) continue // 辅助请求（如标题生成）不进 Trace 视图
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, [])
    bySession.get(r.sessionId).push(r)
  }
  const traces = []
  for (const [sid, recs] of bySession) {
    // ---- 轮次切分 ----
    // 新轮次 = 末条消息为纯用户文本 && 没有未闭合的 Task && 不是子 Agent 接收任务
    // （子 Agent 的首个请求末条同样是纯文本，需用 Task 开闭状态区分）
    const turns = []
    const openTasks = [] // 已发出但未收到 tool_result 的 Task tool_use id
    let mainSysHash = null
    for (const r of recs) {
      // 先处理本请求闭合的 Task
      for (const t of r.toolResults || []) {
        const i = openTasks.indexOf(t.toolUseId)
        if (i >= 0) openTasks.splice(i, 1)
      }
      const isSubLike =
        r.subagentHint || (mainSysHash != null && r.systemHash !== mainSysHash && openTasks.length > 0)
      const startsNew = r.newTurn && openTasks.length === 0 && !isSubLike
      if (startsNew || turns.length === 0) {
        turns.push([])
        if (startsNew) mainSysHash = r.systemHash
      }
      turns[turns.length - 1].push(r)
      // 本请求响应中发出的新 Task
      if (r.status !== 'error')
        for (const tu of r.toolUses || []) if (tu.name === 'Task') openTasks.push(tu.id)
    }
    turns.forEach((t, i) => {
      const tr = buildTurn(t, sid, i, `tr_${sid.slice(0, 8)}_${i + 1}`)
      if (tr) traces.push(tr)
    })
  }
  return traces.sort((a, b) => b.ts - a.ts)
}
