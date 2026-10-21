// ============ 层级重建：原始请求记录 → 前端可消费的 Trace 树 ============
// 结构：sessionId → 轮次(turn) → root(agent) → llm / tool / subagent(span)
// 层级推断策略：
//   1. session 从 metadata.user_id 的 `_session_` 后缀解析
//   2. 新轮次 = 有效末条消息（忽略尾部 system 提醒）为纯用户文本（而非 tool_result）
//   3. 子 Agent = 响应含 Task/Agent tool_use；其后 system 指纹变化且任务未关闭的请求归入子 Agent
//   4. 工具 span = 上一个请求的 tool_use 与下一个请求 tool_result 之间的时间窗
//   5. 后台 Agent（同 user 的 aux 请求，如 CC 2.1.x 的 security monitor）并入该用户最近一条 Trace

const trunc = (s, n = 300) =>
  s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s)

// 委派子 Agent 的工具名：Task（旧版 Claude Code）/ Agent（CC 2.1.x+）
const SPAWN_TOOLS = new Set(['Task', 'Agent'])
const isSpawn = (name) => SPAWN_TOOLS.has(name)

// ---- 有效末条消息 ----
// CC 2.1.x 会在消息末尾追加 role=system 的提醒（如 <total_tokens>…），判定轮次 / 工具结果时应忽略。
// 从 messagesPreview 末端推导，因此对网关修复前落盘的历史记录同样生效。
function effLastMsg(r) {
  const pv = r.messagesPreview || []
  for (let i = pv.length - 1; i >= 0; i--) {
    const m = pv[i]
    if (m.role !== 'system' && m.role !== '…') return m
  }
  return null
}
const effNewTurn = (r) => {
  const m = effLastMsg(r)
  return !m || m.msgKind !== 'tool_result'
}
const effToolResultPreview = (r) => {
  const m = effLastMsg(r)
  return m?.msgKind === 'tool_result' ? m.content : null
}

// 历史记录修复：尾部 system 提醒曾导致 toolResults 未捕获 → 按同属主上一请求的 tool_use 顺序合成
function healResults(r, prev) {
  if ((r.toolResults || []).length) return r
  const pv = effToolResultPreview(r)
  if (!pv || !prev || !(prev.toolUses || []).length) return r
  return { ...r, toolResults: prev.toolUses.map((tu) => ({ toolUseId: tu.id, isError: false, preview: trunc(pv, 220) })) }
}

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
  const tools = r.toolUses.map((t) => t.name).filter((n) => !isSpawn(n))
  const hasSpawn = r.toolUses.some((t) => isSpawn(t.name))
  const name =
    r.status === 'error'
      ? '调用失败'
      : r.stopReason === 'tool_use'
        ? hasSpawn
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
  const sub = isSpawn(tu.name)
  return {
    id: `tool-${tu.id}`,
    type: 'tool',
    name: sub ? `${tu.name} · ${tu.input?.subagent_type || tu.input?.agent_type || 'subagent'}` : tu.name,
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
    if (isSpawn(tu.name)) {
      // 委派工具条插到子 Agent 容器之前，保持「调用→子Agent→结果」视觉顺序
      const idx = owner.children.findIndex((c) => c.metadata?.task_tool_use_id === tu.id)
      if (idx >= 0) owner.children.splice(idx, 0, span)
      else owner.children.push(span)
    } else {
      owner.children.push(span)
    }
  }
}

// 汇总 root 的结束时间与整体状态（子 Agent / 后台 Agent 挂载后可重复调用）
function sealRoot(root) {
  root.end = Math.max(...root.children.flatMap((c) => [c.end, ...c.children.map((g) => g.end)]), 0) || 0
  const walk = (n) => [n, ...n.children.flatMap(walk)]
  root.status = walk(root).some((n) => n.status === 'error') ? 'error' : 'ok'
}

function buildTurn(recs, sid, turnIdx, traceId) {
  const t0 = recs[0].ts
  const baseSysHash = recs[0].systemHash
  const queryRec = recs.find((r) => r.query && effNewTurn(r))
  const query = trunc(
    queryRec?.query ||
      recs[0].messagesPreview?.find((m) => m.role === 'user' && m.msgKind === 'text')?.content ||
      recs[0].messagesPreview?.[0]?.content ||
      '',
    120,
  )

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
    // 子 Agent 判定：system 指纹与主 Agent 不同 && 存在未闭合容器
    // （不用 subagentHint：CC 2.1.x 主 Agent 的 system 同样含 "You are an agent"）
    const isSub = curSub && r.systemHash !== baseSysHash

    if (isSub) {
      const healed = healResults(r, prevSub)
      const resolved = new Set((healed.toolResults || []).map((t) => t.toolUseId))
      if (prevSub) attachToolSpans(prevSub, curSub.node, resolved, healed, t0)
      const span = llmSpan(r, t0)
      curSub.node.children.push(span)
      curSub.node.end = Math.max(curSub.node.end, span.end)
      prevSub = r
    } else {
      const healed = healResults(r, prevMain)
      const resolved = new Set((healed.toolResults || []).map((t) => t.toolUseId))
      // 主链请求若带回了 Task/Agent 的 tool_result → 关闭子 Agent 容器
      if (curSub && resolved.has(curSub.taskId)) {
        curSub.node.end = r.ts - t0
        curSub = null
        prevSub = null
      }
      if (prevMain) attachToolSpans(prevMain, root, resolved, healed, t0)
      root.children.push(llmSpan(r, t0))
      prevMain = r
    }

    // 响应中出现 Task/Agent tool_use → 开子 Agent 容器
    if (!curSub) {
      const tu = (r.toolUses || []).find((t) => isSpawn(t.name))
      if (tu) {
        const subType = tu.input?.subagent_type || tu.input?.agent_type || 'subagent'
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
            metadata: { agent: subType, task_tool_use_id: tu.id, spawned_by: tu.name },
            children: [],
          },
        }
        root.children.push(curSub.node)
      }
    }
  }

  // 收尾
  if (curSub) curSub.node.end = curSub.node.end || root.end
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
  sealRoot(root)

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

// ---- 后台 Agent：同 user 的 aux 请求（无工具、消息极短），如 CC 2.1.x 的 security monitor ----
function bgAgentName(r) {
  const m = /You are (?:a|an) ([^.,\n;]{2,50})/.exec(r.systemPreview || '')
  return m ? m[1].trim() : 'background'
}

function bgContainer(group, t0, traceId) {
  const name = bgAgentName(group[0])
  const spans = group
    .map((r) => llmSpan(r, t0))
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.max(1, s.end) }))
  const last = spans[spans.length - 1]
  return {
    id: `bg-${group[0].systemHash}-${traceId}`,
    type: 'subagent',
    name: `后台 Agent · ${name}`,
    status: spans.some((s) => s.status === 'error') ? 'error' : 'ok',
    start: Math.min(...spans.map((s) => s.start)),
    end: Math.max(...spans.map((s) => s.end)),
    input: { agent: name, requests: group.length },
    output: typeof last?.output === 'string' ? trunc(last.output, 300) : '',
    metadata: { agent: name, spawned_by: 'background', system_hash: group[0].systemHash },
    children: spans,
  }
}

function buildBackgroundTrace(group) {
  const t0 = group[0].ts
  const name = bgAgentName(group[0])
  const container = bgContainer(group, t0, 'x')
  const root = {
    id: `bg-root-${group[0].systemHash}`,
    type: 'agent',
    name: `后台 Agent · ${name}`,
    status: container.status,
    start: 0,
    end: container.end,
    input: { messages: [{ role: 'user', content: trunc(group[0].query || '', 120) }] },
    output: container.output,
    metadata: { agent: name, spawned_by: 'background' },
    children: [container],
  }
  return {
    id: `tr_bg_${group[0].systemHash.slice(0, 8)}`,
    name: `后台 Agent · ${name}`,
    ts: t0,
    user: group[0].userHash || 'claude-code',
    conv: `session ${String(group[0].sessionId).slice(0, 10)} · 后台`,
    query: trunc(group[0].query || '', 120),
    tree: root,
  }
}

export function buildTraces(records) {
  const sorted = [...records].sort((a, b) => a.ts - b.ts)
  const bySession = new Map()
  const auxByUser = new Map()
  for (const r of sorted) {
    if (r.aux) {
      // 标题生成等一次性辅助请求不展示；其余 aux（如 security monitor）按 user 归档为后台 Agent
      if (!/title/i.test(r.systemPreview || '')) {
        if (!auxByUser.has(r.userHash)) auxByUser.set(r.userHash, [])
        auxByUser.get(r.userHash).push(r)
      }
      continue
    }
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, [])
    bySession.get(r.sessionId).push(r)
  }

  const traces = []
  for (const [sid, recs] of bySession) {
    // ---- 轮次切分 ----
    // 新轮次 = 有效末条消息为纯用户文本 && 没有未闭合的 Task/Agent && 不是子 Agent 接收任务
    // （子 Agent 的首个请求末条同样是纯文本，需用任务开闭状态区分）
    const turns = []
    const openTasks = [] // 已发出但未收到 tool_result 的 Task/Agent tool_use id
    let mainSysHash = null
    let prevRec = null
    const closesTask = (r, id) =>
      (r.toolResults || []).some((t) => t.toolUseId === id) ||
      (!(r.toolResults || []).length &&
        !!effToolResultPreview(r) &&
        (prevRec?.toolUses || []).some((t) => t.id === id && isSpawn(t.name)))
    for (const r of recs) {
      // 先处理本请求闭合的 Task/Agent
      for (let i = openTasks.length - 1; i >= 0; i--) if (closesTask(r, openTasks[i])) openTasks.splice(i, 1)
      const isSubLike = mainSysHash != null && r.systemHash !== mainSysHash && openTasks.length > 0
      const startsNew = effNewTurn(r) && openTasks.length === 0 && !isSubLike
      if (startsNew || turns.length === 0) {
        turns.push([])
        if (startsNew) mainSysHash = r.systemHash
      }
      turns[turns.length - 1].push(r)
      // 本请求响应中发出的新 Task/Agent
      if (r.status !== 'error')
        for (const tu of r.toolUses || []) if (isSpawn(tu.name)) openTasks.push(tu.id)
      prevRec = r
    }
    turns.forEach((t, i) => traces.push(buildTurn(t, sid, i, `tr_${sid.slice(0, 8)}_${i + 1}`)))
  }

  // ---- 后台 Agent 并入同一用户时间上最近的一条 Trace ----
  const attached = new Set()
  for (const [user, auxRecs] of auxByUser) {
    const mine = traces.filter((t) => t.user === user).sort((a, b) => a.ts - b.ts)
    if (!mine.length) continue
    for (const r of auxRecs) {
      const target = [...mine].reverse().find((t) => t.ts <= r.ts) || mine[0]
      ;(target._bg = target._bg || []).push(r)
      attached.add(r)
    }
  }
  for (const trace of traces) {
    if (!trace._bg?.length) continue
    const t0 = trace.ts
    const bySys = new Map()
    for (const r of trace._bg) {
      if (!bySys.has(r.systemHash)) bySys.set(r.systemHash, [])
      bySys.get(r.systemHash).push(r)
    }
    for (const group of bySys.values()) trace.tree.children.push(bgContainer(group, t0, trace.id))
    delete trace._bg
    sealRoot(trace.tree)
  }
  // 无处可挂（该 user 无常规 Trace）→ 后台 Agent 独立成 Trace，避免数据消失
  for (const auxRecs of auxByUser.values()) {
    const bySys = new Map()
    for (const r of auxRecs) {
      if (attached.has(r)) continue
      if (!bySys.has(r.systemHash)) bySys.set(r.systemHash, [])
      bySys.get(r.systemHash).push(r)
    }
    for (const group of bySys.values()) traces.push(buildBackgroundTrace(group))
  }

  return traces.sort((a, b) => b.ts - a.ts)
}
