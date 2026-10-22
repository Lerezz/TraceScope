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

// 展示层消息预览裁剪：历史记录在长会话中保留了「开头前 2 条」（跨任务的陈年内容，如别的任务的枚举输出），
// 裁掉省略标记之前的头部，只留标记与近尾上下文——轮次消息流不再掺入其它任务的内容
function tailPreview(r) {
  const pv = r.messagesPreview || []
  const marker = pv.findIndex((m) => m.role === '…')
  return marker >= 0 ? pv.slice(marker) : pv
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

// system prompt 去重表：同一会话内所有 span 共享一份 system 全文，span 只带 systemHash 引用
// （每次 buildTraces 重建，最终挂到每条 trace 的 systems 字段，前端按需取用）
let SYSTEMS = new Map()

function llmSpan(r, t0) {
  const { start, end } = rel(r, t0)
  if (r.systemPreview) SYSTEMS.set(r.systemHash, r.systemPreview)
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
    input: { systemHash: r.systemHash, messages: tailPreview(r) },
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
    if (isSpawn(tu.name) || tu.name === 'WebSearch') {
      // 委派/搜索工具条插到子容器之前，保持「调用→子Agent→结果」视觉顺序
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

    // 跨会话子流（CC 2.1.x Agent 异步委派 / WebSearch 搜索子会话）：每个委派独立容器，天然支持并行
    if (subs) {
      for (const tu of (r.toolUses || []).filter((t) => subs.has(t.id))) {
        const entry = subs.get(tu.id)
        const isWs = tu.name === 'WebSearch'
        const subType = tu.input?.subagent_type || tu.input?.agent_type || 'subagent'
        entry.node = {
          id: `sub-${tu.id}`,
          type: 'subagent',
          name: isWs ? `搜索 Agent · ${trunc(tu.input?.query, 26)}` : `子 Agent · ${subType}`,
          status: 'ok',
          start: r.ts - t0 + (r.duration || 0),
          end: r.ts - t0 + (r.duration || 0),
          input: isWs
            ? { query: trunc(tu.input?.query, 200) }
            : {
                subagent_type: subType,
                description: trunc(tu.input?.description, 160),
                prompt: trunc(tu.input?.prompt, 400),
              },
          output: '',
          metadata: {
            agent: isWs ? 'web-search' : subType,
            task_tool_use_id: tu.id,
            spawned_by: tu.name,
            sub_session: entry.subSid,
          },
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
    sessionId: sid,
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
  // spawns 索引两类"子会话来源"：Task/Agent 委派（agent）、WebSearch 工具调用（websearch）
  const spawns = new Map() // spawnId -> { tu, parentSid, ts, closedTs, kind }
  for (const [sid, recs] of sessions) {
    for (const r of recs) {
      for (const tu of r.toolUses || [])
        if ((isSpawn(tu.name) || tu.name === 'WebSearch') && r.status !== 'error')
          spawns.set(tu.id, { tu, parentSid: sid, ts: r.ts, closedTs: null, kind: isSpawn(tu.name) ? 'agent' : 'websearch' })
      for (const t of r.toolResults || []) {
        const sp = spawns.get(t.toolUseId)
        if (sp) sp.closedTs = r.ts
      }
    }
  }
  const subOf = new Map() // subSid -> spawnId

  // ---- WebSearch 子会话：首条 query 以固定模板开头，按搜索词与主会话 WebSearch tool_use 精确匹配 ----
  const WS_PREFIX = /^Perform a web search for the query:?\s*/i
  const normQ = (s) => String(s || '').replace(/[\s'"“”]+/g, '')
  for (const [sid, recs] of sessions) {
    const first = recs[0]
    if (!WS_PREFIX.test(first.query || '')) continue
    const term = normQ(first.query.replace(WS_PREFIX, ''))
    if (!term) continue
    let best = null
    for (const [id, sp] of spawns) {
      if (sp.kind !== 'websearch' || sp.parentSid === sid) continue
      if (normQ(sp.tu.input?.query) !== term) continue
      if (sp.ts > first.ts + 5000) continue
      if (sp.closedTs != null && first.ts > sp.closedTs + 30000) continue
      if (!best || sp.ts > best.ts) best = sp // 同词多次搜索时取时间上最近（≤ 子会话开始）
    }
    if (best) subOf.set(sid, best.tu.id)
  }

  // ---- Agent 子会话（system 含子 Agent 标记）：两级归因 ----
  const subSids = [...sessions.keys()].filter((sid) => !subOf.has(sid) && isSubSession(sessions.get(sid)[0]))

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

// ---- 轮次来源标注：区分真人输入与 CC 自动注入（跨会话消息 / 系统通知 / 状态摘要 / 搜索子会话）----
const ORIGIN_RULES = [
  ['cross-session', /Another Claude session sent/i],
  ['system', /SYSTEM NOTIFICATION|user stepped away|<system-reminder>/i],
  ['summary', /^Describe your most recent action/i],
  ['websearch', /^Perform a web search/i],
  // 任务下发/自动化探测模板：多 Agent 系统（如 pentest 编排）拉起角色会话的首条消息
  ['task', /^Begin penetration testing against|^What time is it|^reply OK$|^ping$/i],
]
function originOf(query, subFlag) {
  for (const [k, re] of ORIGIN_RULES) if (re.test(query || '')) return k
  return subFlag ? 'subagent' : 'user'
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
    origin: 'background',
    tree: root,
  }
}

// ---- 会话链归并：真人输入开链，其后自动注入触发的轮次（跨会话回传 / 系统通知 / 摘要等）并入同一条 Trace ----
// 一夜自主运行 = 一条大 Trace，每轮作为「轮次」容器（type: turn）
// 并行多终端时：同 session 的轮次按亲和归回原链；全新 session 按「链内独有关键词」内容归因，
// 避免上一个终端对话的自动轮次被并进最新开启的对话链

// session 文本指纹（归因用）：前 40 条记录拼接去空白——任务号 / 端口 / 路径词等身份信号集中于此
function makeSidText(sessions) {
  const cache = new Map()
  return (sid) => {
    if (!cache.has(sid)) {
      const recs = (sessions.get(sid) || []).slice(0, 40)
      cache.set(sid, norm(recs.map(recText).join(' ')))
    }
    return cache.get(sid)
  }
}

// 并行歧义消解：以「候选之间独有」的关键词给新内容评分，命中最多的候选胜出；无命中返回 null
function pickByContent(texts, newText) {
  if (texts.size < 2 || !newText) return null
  const per = distinctiveTokens([...texts.entries()])
  let best = null
  let bestScore = 0
  for (const key of texts.keys()) {
    let score = 0
    for (const tk of per.get(key) || []) if (newText.includes(tk)) score++
    if (score > bestScore) { bestScore = score; best = key }
  }
  return bestScore > 0 ? best : null
}

// monitor 的 transcript 首行形如 <transcript> {"user":"开启新战役…"}——即被审查会话的开场指令，
// 据此识别「它在审查谁」；非 transcript 输入返回 null
function reviewedOpening(r) {
  const c = String(r.messagesPreview?.[0]?.content || '')
  if (!/^<transcript>/i.test(c.trim())) return null
  const m = /"user"\s*:\s*"([^"]{6,160})/.exec(c)
  return m ? norm(m[1]) : null
}
const TURN_LABEL = {
  user: '用户输入',
  'cross-session': '跨会话消息',
  system: '系统通知',
  summary: '状态摘要',
  websearch: '搜索 Agent',
  subagent: '子 Agent',
  background: '后台',
  task: '任务下发',
}
function offsetTree(n, off) {
  n.start += off
  n.end += off
  n.children.forEach((c) => offsetTree(c, off))
  return n
}
function mergeChains(traces, sidText) {
  const sorted = [...traces].sort((a, b) => a.ts - b.ts)
  const chains = []
  const chainBySid = new Map() // sessionId → 最近所属链（同 session 真人续问会开新链，映射随之更新）
  for (const t of sorted) {
    let chain
    if (t.origin === 'user' || !chains.length) {
      chain = [t]
      chains.push(chain)
    } else {
      // 自动注入的轮次：优先归回本 session 已在的链；全新 session 且多链并行时按内容归因，
      // 均无命中才回退到最后一条链（原行为，仅单链场景）
      chain = chainBySid.get(t.sessionId)
      if (!chain) {
        const texts = new Map(
          chains.map((c) => [c, [...new Set(c.map((x) => x.sessionId))].map(sidText).join(' ')]),
        )
        chain = pickByContent(texts, sidText(t.sessionId)) || chains[chains.length - 1]
      }
      chain.push(t)
    }
    chainBySid.set(t.sessionId, chain)
  }
  const out = []
  for (const turns of chains) {
    if (turns.length === 1) {
      out.push(turns[0])
      continue
    }
    const anchor = turns[0]
    const t0 = anchor.ts
    const sids = new Set(turns.map((t) => t.sessionId).filter(Boolean))
    const root = {
      id: `${anchor.id}-chainroot`,
      type: 'agent',
      name: `Claude Code · 对话链（${turns.length} 轮）`,
      status: 'ok',
      start: 0,
      end: 0,
      input: { messages: [{ role: 'user', content: anchor.query }] },
      output: '',
      metadata: { agent: 'claude-code', chain_turns: turns.length, chain_sessions: sids.size },
      children: [],
    }
    const systems = {}
    turns.forEach((t, i) => {
      Object.assign(systems, t.systems || {})
      offsetTree(t.tree, t.ts - t0)
      t.tree.type = 'turn'
      t.tree.name = `第 ${i + 1} 轮 · ${TURN_LABEL[t.origin] || t.origin}`
      t.tree.metadata = { ...(t.tree.metadata || {}), turn: i + 1, origin: t.origin }
      root.children.push(t.tree)
    })
    root.end = root.children.reduce((m, c) => Math.max(m, nodeEnd(c)), 0)
    const walk = (n) => [n, ...n.children.flatMap(walk)]
    root.status = walk(root).some((n) => n.status === 'error') ? 'error' : 'ok'
    const lastLlm = [...root.children]
      .reverse()
      .flatMap((c) => [...c.children].reverse())
      .find((n) => n.type === 'llm')
    root.output = typeof lastLlm?.output === 'string' ? trunc(lastLlm.output, 400) : ''
    out.push({
      id: anchor.id,
      // 链内无真人输入（整段自主运行）时用自主任务链命名，避免拿注入消息当标题
      name: anchor.origin === 'user' ? anchor.name : `Claude Code · 自主任务链（${turns.length} 轮）`,
      ts: t0,
      user: anchor.user,
      conv: `对话链 · ${turns.length} 轮 · ${sids.size} 会话`,
      query: anchor.query,
      origin: 'user',
      sessionIds: [...sids],
      systems,
      tree: root,
    })
  }
  return out
}

export function buildTraces(records) {
  SYSTEMS = new Map()
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

  let traces = []
  // 跨会话子流对象（递归）：{ tu, subSid, recs, subs(嵌套), node(渲染时创建) }
  const buildSubStream = (spawnId, subSid) => ({
    tu: spawns.get(spawnId)?.tu,
    subSid,
    recs: sessions.get(subSid) || [],
    subs: buildSubsOf(subSid),
    node: null,
  })
  const buildSubsOf = (parentSid) => {
    const m = new Map()
    for (const [spawnId, subSid] of subsByParent.get(parentSid) || [])
      m.set(spawnId, buildSubStream(spawnId, subSid))
    return m
  }
  const topSids = [...sessions.keys()].filter((sid) => !subOf.has(sid))
  for (const sid of topSids) {
    const recs = sessions.get(sid)
    const sessionSubs = subsByParent.get(sid) || new Map()
    const subFlag = isSubSession(recs[0])
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
        for (const tu of r.toolUses || []) {
          if (isSpawn(tu.name)) {
            openTasks.push(tu.id)
            spawnTurn.set(tu.id, turns.length - 1)
          } else if (sessionSubs.has(tu.id)) {
            spawnTurn.set(tu.id, turns.length - 1) // WebSearch 等绑定了子会话的工具
          }
        }
      prevRec = r
    }
    turns.forEach((t, i) => {
      // 本轮发出的委派 → 绑定的跨会话子流（递归构建，支持子会话再嵌套）
      const subs = new Map()
      for (const [spawnId, subSid] of sessionSubs) {
        if (spawnTurn.get(spawnId) !== i) continue
        subs.set(spawnId, buildSubStream(spawnId, subSid))
      }
      const tr = buildTurn(t, sid, i, `tr_${sid.slice(0, 8)}_${i + 1}`, subs)
      tr.origin = originOf(tr.query, subFlag)
      traces.push(tr)
    })
  }

  // ---- 会话链归并：真人输入开链，其后自动触发的轮次并入同一条 Trace（并行多链按 session/内容归因） ----
  const sidText = makeSidText(sessions)
  traces = mergeChains(traces, sidText)

  // ---- 后台 Agent 并入：逐条归因 ----
  // CC 的 security monitor 是全局后台进程，输入即被审查会话的累积 transcript：
  //   ① 与主会话共用 session → 直接归位
  //   ② transcript 开场 = 被审查会话的开场指令 → 归到该会话「开场所在」的链（取最早，不随审查时间漂移）
  //   monitor 识别不出被审查会话时不强挂（独立成后台 Trace），避免把其它会话的审查记录灌进任务 Trace；
  //   非 monitor 辅助请求回退：③ 独有关键词内容指纹 → ④ 时间最近前置 Trace
  const traceSids = (t) => t.sessionIds || (t.sessionId ? [t.sessionId] : [])
  const attached = new Set()
  for (const [user, auxRecs] of auxByUser) {
    const mine = traces.filter((t) => t.user === user).sort((a, b) => a.ts - b.ts)
    if (!mine.length) continue
    // 预计算各 Trace 的文本与「Trace 之间独有」关键词（每 user 一次）
    const texts = new Map(mine.map((t) => [t, traceSids(t).map(sidText).join(' ')]))
    const tokens = mine.length >= 2 ? distinctiveTokens([...texts.entries()]) : new Map()
    for (const r of auxRecs) {
      const cands = mine.filter((t) => t.ts <= r.ts)
      if (!cands.length) continue // 早于所有 Trace：无处可挂，走独立后台 Trace
      // ① session 亲和：后台任务与主会话共用 session 时直接归位
      const sidHits = cands.filter((t) => traceSids(t).includes(r.sessionId))
      let target = sidHits[sidHits.length - 1]
      // ② monitor：transcript 开场匹配被审查会话的开场，归到该会话最早的链
      const cap = reviewedOpening(r)
      if (!target && cap)
        target = cands.find((t) => traceSids(t).some((s) => sidText(s).includes(cap)))
      if (!target) {
        if (cap) continue // monitor 但识别不出归属：独立成后台 Trace，不按时间强挂
        // ③ 内容指纹
        if (cands.length >= 2) {
          const txt = norm(recText(r))
          let bestScore = 0
          for (const t of cands) {
            let score = 0
            for (const tk of tokens.get(t) || []) if (txt.includes(tk)) score++
            if (score > bestScore) { bestScore = score; target = t }
          }
          if (!bestScore) target = null
        }
        // ④ 时间兜底
        if (!target) target = cands[cands.length - 1]
      }
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

  // system prompt 全文去重：按 trace 实际用到的 systemHash 建表（span 内仅引用，显著缩小响应体）
  const walkAll = (n) => [n, ...n.children.flatMap(walkAll)]
  for (const t of traces) {
    const used = new Set()
    for (const n of walkAll(t.tree)) if (n.type === 'llm' && n.input?.systemHash != null) used.add(n.input.systemHash)
    const tbl = {}
    for (const h of used) if (SYSTEMS.has(h)) tbl[h] = SYSTEMS.get(h)
    t.systems = tbl
  }

  return traces.sort((a, b) => b.ts - a.ts)
}
