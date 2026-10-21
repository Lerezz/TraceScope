// ============ 层级重建：原始请求记录 → 前端可消费的 Trace 树 ============
// 结构：sessionId → 轮次(turn) → root(agent) → llm / tool / subagent(span)
// 层级推断策略：
//   1. session 从 metadata.user_id 的 `_session_` 后缀解析
//   2. 新轮次 = 有效末条消息（忽略尾部 system 提醒）为纯用户文本（而非 tool_result）
//   3. 子 Agent（同会话，旧版 Task）：响应含 Task tool_use；其后 system 指纹变化且任务未关闭的请求归入子 Agent
//   4. 子 Agent（跨会话，CC 2.1.x Agent 异步委派）：子 Agent 在独立 session 中运行，
//      通过「委派 prompt ↔ 子会话首条消息」精确匹配，历史数据回退到任务特征关键词评分归因
//   5. 工具 span = 上一个请求的 tool_use 与下一个请求 tool_result 之间的时间窗
//   6. 后台 Agent（同 user 的 aux 请求，如 CC 的 security monitor）并入该用户最近一条 Trace

const trunc = (s, n = 300) =>
  s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s)
const norm = (s) => String(s || '').replace(/\s+/g, '')

// 委派子 Agent 的工具名：Task（旧版 Claude Code）/ Agent（CC 2.1.x+，异步）
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

const nodeEnd = (n) => Math.max(n.end || 0, ...n.children.map(nodeEnd), 0)

// 汇总 root 的结束时间与整体状态（子 Agent / 后台 Agent 挂载后可重复调用）
function sealRoot(root) {
  root.end = root.children.reduce((m, c) => Math.max(m, nodeEnd(c)), 0)
  const walk = (n) => [n, ...n.children.flatMap(walk)]
  root.status = walk(root).some((n) => n.status === 'error') ? 'error' : 'ok'
}

// ---- 单条记录流的渲染（主会话与子会话通用，支持跨会话子流递归嵌套）----
// recs: 本会话记录；subs: Map<spawnId, { tu, subSid, recs, subs, node }>（跨会话子流，node 在遍历中创建）
function emitStream(recs, baseSysHash, t0, subs) {
  const children = []
  let curSub = null // 同会话子 Agent（旧版 Task 风格）
  let prevMain = null
  let prevSub = null

  for (const r of recs) {
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
      // 主链请求若带回了 Task/Agent 的 tool_result → 关闭同会话子 Agent 容器
      if (curSub && resolved.has(curSub.taskId)) {
        curSub.node.end = r.ts - t0
        curSub = null
        prevSub = null
      }
      if (prevMain) attachToolSpans(prevMain, { children }, resolved, healed, t0)
      children.push(llmSpan(r, t0))
      prevMain = r
    }

    // 跨会话子 Agent（CC 2.1.x Agent 异步委派）：每个委派独立容器，天然支持并行
    if (subs) {
      for (const tu of (r.toolUses || []).filter((t) => isSpawn(t.name) && subs.has(t.id))) {
        const entry = subs.get(tu.id)
        const subType = tu.input?.subagent_type || tu.input?.agent_type || 'subagent'
        entry.node = {
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
          metadata: { agent: subType, task_tool_use_id: tu.id, spawned_by: tu.name, sub_session: entry.subSid },
          children: [],
        }
        children.push(entry.node)
      }
    }

    // 同会话子 Agent（旧版 Task 风格）：响应含委派 tool_use 时开启容器
    if (!curSub) {
      const tu = (r.toolUses || []).find((t) => isSpawn(t.name) && !(subs && subs.has(t.id)))
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
        children.push(curSub.node)
      }
    }
  }

  // 跨会话子流：递归渲染并填充容器
  if (subs) {
    for (const entry of subs.values()) {
      if (!entry.node) continue
      const inner = emitStream(entry.recs, entry.recs[0].systemHash, t0, entry.subs)
      entry.node.children.push(...inner.children)
      entry.node.start = Math.min(entry.node.start, ...inner.children.map((c) => c.start))
      entry.node.end = Math.max(entry.node.end, inner.maxEnd)
      const lastLlm = [...entry.node.children].reverse().find((g) => g.type === 'llm')
      entry.node.output = typeof lastLlm?.output === 'string' ? trunc(lastLlm.output, 300) : ''
    }
  }
  // 同会话子 Agent 容器的输出 = 其最后一个 llm 的文本
  for (const c of children)
    if (c.type === 'subagent' && !c.metadata?.sub_session) {
      const last = [...c.children].reverse().find((g) => g.type === 'llm')
      c.output = typeof last?.output === 'string' ? trunc(last.output, 300) : ''
    }

  return { children, maxEnd: children.reduce((m, c) => Math.max(m, nodeEnd(c)), 0) }
}

function buildTurn(recs, sid, turnIdx, traceId, subs) {
  const t0 = recs[0].ts
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

  const { children, maxEnd } = emitStream(recs, recs[0].systemHash, t0, subs)
  root.children = children
  root.output = (() => {
    const last = [...children].reverse().find((c) => c.type === 'llm')
    return typeof last?.output === 'string' ? trunc(last.output, 400) : root.output
  })()
  root.end = maxEnd
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

// ---- 跨会话子 Agent 归因 ----
// CC 2.1.x 的 Agent 工具为异步委派：子 Agent 在独立 session（anon- 指纹键）中运行，
// 与父会话无显式关联。归因两级：
//   Tier 1（精确）：委派 prompt 前缀出现在子会话首条 user 消息全文中（网关记录 firstUserFull）
//   Tier 2（启发）：任务特征关键词（任务号/端口/专有词，剔除多候选共通词）加权评分，子会话前 3 条记录权重 ×3
const SUB_SYS_MARKER = /cc_is_subagent=true|agent for Claude Code/i
const isSubSession = (first) => SUB_SYS_MARKER.test(first.systemPreview || '') || !!first.subagentHint

function recText(r) {
  return [
    r.query,
    r.textOut,
    ...(r.messagesPreview || []).map((m) => m.content),
    JSON.stringify((r.toolUses || []).map((t) => t.input)),
  ].join(' ')
}

function distinctiveTokens(prompts) {
  const df = new Map()
  const per = new Map()
  for (const [id, p] of prompts) {
    const set = new Set()
    const s = String(p || '')
    for (const m of s.matchAll(/T-\d+/g)) set.add(m[0])
    for (const m of s.matchAll(/(?:\d{1,3}\.){3}\d{1,3}/g)) set.add(m[0])
    for (const m of s.matchAll(/\d{2,5}/g)) if (+m[0] >= 20) set.add(m[0])
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_-]{3,}/g)) set.add(m[0].toLowerCase())
    for (const m of s.matchAll(/[\u4e00-\u9fa5]{4,}/g)) set.add(m[0])
    per.set(id, set)
    for (const t of set) {
      if (!df.has(t)) df.set(t, new Set())
      df.get(t).add(id)
    }
  }
  for (const set of per.values()) for (const t of set) if (df.get(t).size > 1) set.delete(t)
  return per
}

function attributeSubSessions(sessions) {
  // sessions: Map<sid, recs>（按 ts 升序）
  const spawns = new Map() // spawnId -> { tu, parentSid, ts, closedTs }
  for (const [sid, recs] of sessions) {
    for (const r of recs) {
      for (const tu of r.toolUses || [])
        if (isSpawn(tu.name) && r.status !== 'error') spawns.set(tu.id, { tu, parentSid: sid, ts: r.ts, closedTs: null })
      for (const t of r.toolResults || []) {
        const sp = spawns.get(t.toolUseId)
        if (sp) sp.closedTs = r.ts
      }
    }
  }
  const subSids = [...sessions.keys()].filter((sid) => isSubSession(sessions.get(sid)[0]))
  const subOf = new Map() // subSid -> spawnId

  // Tier 1：prompt 精确匹配
  const pending = []
  for (const sid of subSids) {
    const first = sessions.get(sid)[0]
    const full = norm(first.firstUserFull || '') + norm((first.messagesPreview || []).map((m) => m.content).join(' '))
    let hit = null
    for (const [id, sp] of spawns) {
      if (sp.parentSid === sid) continue
      const head = norm(sp.tu.input?.prompt || '').slice(0, 200)
      if (head && full.includes(head)) {
        hit = id
        break
      }
    }
    if (hit) subOf.set(sid, hit)
    else pending.push(sid)
  }

  // Tier 2：关键词评分（历史记录 prompt 被 CLAUDE.md 提醒挤出 2000 字截断时）
  if (pending.length && spawns.size) {
    const tokens = distinctiveTokens([...spawns.entries()].map(([id, sp]) => [id, sp.tu.input?.prompt]))
    const boundSpawn = new Set(subOf.values())
    const pairs = []
    for (const sid of pending) {
      const subRecs = sessions.get(sid)
      const first = subRecs[0]
      for (const [id, sp] of spawns) {
        if (sp.parentSid === sid || boundSpawn.has(id)) continue
        // 时间窗：委派发出 ≤ 子会话开始（+宽限）；异步 ack 后短暂宽限内启动的也算
        if (sp.ts > first.ts + 5000) continue
        if (sp.closedTs != null && first.ts > sp.closedTs + 30000) continue
        let score = 0
        const toks = tokens.get(id) || new Set()
        subRecs.slice(0, 12).forEach((r, i) => {
          const txt = norm(recText(r))
          const w = i < 3 ? 3 : 1 // 执行者前几条记录最贴任务目标
          for (const t of toks) if (txt.includes(t)) score += w
        })
        if (score > 0) pairs.push({ score, sid, spawnId: id })
      }
    }
    pairs.sort((a, b) => b.score - a.score)
    const usedSub = new Set()
    for (const p of pairs) {
      if (usedSub.has(p.sid) || boundSpawn.has(p.spawnId)) continue
      subOf.set(p.sid, p.spawnId)
      boundSpawn.add(p.spawnId)
      usedSub.add(p.sid)
    }
  }

  // 反查表：父会话 -> Map<spawnId, subSid>（支持嵌套：子会话亦可作为父）
  const subsByParent = new Map()
  for (const [subSid, spawnId] of subOf) {
    const parentSid = spawns.get(spawnId)?.parentSid
    if (parentSid == null || parentSid === subSid) continue
    if (!subsByParent.has(parentSid)) subsByParent.set(parentSid, new Map())
    subsByParent.get(parentSid).set(spawnId, subSid)
  }
  return { spawns, subOf, subsByParent }
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
  const sessions = new Map()
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
    if (!sessions.has(r.sessionId)) sessions.set(r.sessionId, [])
    sessions.get(r.sessionId).push(r)
  }

  // ---- 跨会话子 Agent 归因 ----
  const { spawns, subOf, subsByParent } = attributeSubSessions(sessions)

  const traces = []
  const topSids = [...sessions.keys()].filter((sid) => !subOf.has(sid))
  for (const sid of topSids) {
    const recs = sessions.get(sid)
    // ---- 轮次切分（仅本会话记录；异步子流不参与切分，挂到委派所在轮次）----
    const turns = []
    const openTasks = []
    const spawnTurn = new Map() // spawnId -> turnIdx
    let mainSysHash = null
    let prevRec = null
    const closesTask = (r, id) =>
      (r.toolResults || []).some((t) => t.toolUseId === id) ||
      (!(r.toolResults || []).length &&
        !!effToolResultPreview(r) &&
        (prevRec?.toolUses || []).some((t) => t.id === id && isSpawn(t.name)))
    for (const r of recs) {
      for (let i = openTasks.length - 1; i >= 0; i--) if (closesTask(r, openTasks[i])) openTasks.splice(i, 1)
      const isSubLike = mainSysHash != null && r.systemHash !== mainSysHash && openTasks.length > 0
      const startsNew = effNewTurn(r) && openTasks.length === 0 && !isSubLike
      if (startsNew || turns.length === 0) {
        turns.push([])
        if (startsNew) mainSysHash = r.systemHash
      }
      turns[turns.length - 1].push(r)
      if (r.status !== 'error')
        for (const tu of r.toolUses || [])
          if (isSpawn(tu.name)) {
            openTasks.push(tu.id)
            spawnTurn.set(tu.id, turns.length - 1)
          }
      prevRec = r
    }
    turns.forEach((t, i) => {
      // 本轮发出的委派 → 绑定的跨会话子流
      const subs = new Map()
      for (const [spawnId, subSid] of subsByParent.get(sid) || []) {
        if (spawnTurn.get(spawnId) !== i) continue
        subs.set(spawnId, {
          tu: spawns.get(spawnId).tu,
          subSid,
          recs: sessions.get(subSid),
          subs: subsByParent.get(subSid) || new Map(),
          node: null,
        })
      }
      traces.push(buildTurn(t, sid, i, `tr_${sid.slice(0, 8)}_${i + 1}`, subs))
    })
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
