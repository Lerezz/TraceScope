#!/usr/bin/env node
// ============ LLM 网关：Claude Code → Anthropic 透传 + Trajectory 记录 ============
//
// 用法 A（真实链路）:
//   npm run gateway
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
//   （API key 由 claude 请求头透传，或网关侧 export GW_ANTHROPIC_KEY=sk-ant-...）
//
// 用法 B（无真实 key 演示）:
//   npm run gateway:demo     # GW_FAKE=1，内置模拟上游
//   npm run simulate         # 模拟一轮「主 Agent → Task 子 Agent → 工具」会话
//
// 前端: Vite dev server 已把 /api 代理到本网关（见 vite.config.js）

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildTraces, costOf } from './tree-builder.mjs'
import { fakeRespond } from './test/fake-upstream.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const FAKE = process.env.GW_FAKE === '1'

// 读取 claude.settings：上游地址 / 兜底鉴权（可用 GW_UPSTREAM / GW_ANTHROPIC_KEY 覆盖）
function readClaudeSettings() {
  for (const p of [
    path.join(__dirname, '..', 'claude.settings'),
    path.join(process.env.HOME || '', '.claude', 'settings.json'),
  ]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 尝试下一个 */ }
  }
  return null
}
const SETTINGS_ENV = readClaudeSettings()?.env || {}
// 防自环：settings 里的 BASE_URL 若已指向本网关则不可作为上游
const isValidUpstream = (u) => !!u && !/\/\/(localhost|127\.0\.0\.1)/.test(u)
const UPSTREAM =
  process.env.GW_UPSTREAM ||
  SETTINGS_ENV.GW_UPSTREAM ||
  (isValidUpstream(SETTINGS_ENV.ANTHROPIC_BASE_URL) ? SETTINGS_ENV.ANTHROPIC_BASE_URL : null) ||
  'https://api.anthropic.com'
// 客户端未携带鉴权头时的兜底 token（Authorization: Bearer）
const FALLBACK_TOKEN = SETTINGS_ENV.ANTHROPIC_AUTH_TOKEN
const DATA_DIR = path.join(__dirname, 'data')
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl')
const MAX_RECORDS = 2000

// ---------- 记录存储 ----------
const records = []
fs.mkdirSync(DATA_DIR, { recursive: true })
if (fs.existsSync(RECORDS_FILE)) {
  for (const line of fs.readFileSync(RECORDS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* 忽略损坏行 */ }
  }
}
function persist(rec) {
  records.push(rec)
  while (records.length > MAX_RECORDS) records.shift()
  fs.appendFile(RECORDS_FILE, JSON.stringify(rec) + '\n', () => {})
}
console.log(`[gateway] 启动 port=${PORT} upstream=${FAKE ? '内置模拟' : UPSTREAM} 历史=${records.length} 条`)

// ---------- 工具 ----------
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10)
const trunc = (s, n = 300) =>
  s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s)

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[tool_use:${b.name}]` : b.type === 'tool_result' ? textOf(b.content) : `[${b.type}]`))
      .join(' ')
  return String(content)
}

function parseSession(body) {
  const uid = body?.metadata?.user_id || ''
  const m = /_session_(.+)$/.exec(uid)
  if (m) return m[1]
  // 兜底：system + 首条用户消息的指纹作为会话键
  const firstUser = body?.messages?.find((x) => x.role === 'user')
  return 'anon-' + sha1(textOf(body?.system || '') + '|' + textOf(firstUser?.content || ''))
}

// 消息预览：区分纯文本 / tool_result（前端按 kind 渲染角色标签）
function msgKind(m) {
  const c = m?.content
  if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return 'tool_result'
    return 'text'
  }
  return 'text'
}

function makeRecord(body, t0) {
  const msgs = body.messages || []
  // CC 2.1.x 会在消息末尾追加 role=system 的提醒（如 <total_tokens>…），判定轮次 / 工具结果时应忽略
  let last = null
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'system') { last = msgs[i]; break }
  }
  const lastBlocks = Array.isArray(last?.content) ? last.content : []
  const lastIsToolResult =
    last?.role === 'user' && lastBlocks.some((b) => b.type === 'tool_result')

  const systemText = textOf(body.system)
  const preview =
    msgs.length <= 4
      ? msgs
      : [...msgs.slice(0, 2), { role: '…', content: `…共 ${msgs.length} 条消息…` }, ...msgs.slice(-2)]
  // 会话开头的首条 user 消息全文（跨会话子 Agent 归因用：任务 prompt 常在 CLAUDE.md 提醒之后，2000 字截断会丢失）
  const firstUserFull =
    msgs.length <= 3 ? trunc(textOf(msgs.find((m) => m?.role === 'user')?.content), 8000) : undefined

  return {
    kind: 'messages',
    ts: t0,
    duration: 0,
    status: 'ok',
    sessionId: parseSession(body),
    userHash: sha1(body?.metadata?.user_id || 'unknown-user'),
    newTurn: !lastIsToolResult,
    query: lastIsToolResult ? '' : trunc(textOf(last?.content), 200),
    model: body.model,
    stream: !!body.stream,
    systemHash: sha1(systemText),
    systemPreview: trunc(systemText, 6000), // 全量上限：超长 system prompt 截断
    firstUserFull,
    // 注意：不能匹配宽泛的 "You are an agent"——CC 2.1.x 主 Agent 的 system 同样包含该句
    subagentHint: /agent for Claude Code/i.test(systemText),
    toolsOffered: (body.tools || []).map((t) => t.name).slice(0, 14),
    messagesPreview: preview.map((m) => ({
      role: m.role,
      msgKind: msgKind(m),
      content: trunc(textOf(m.content), 2000), // 单条消息全量上限
    })),
    toolResults: lastBlocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ toolUseId: b.tool_use_id, isError: !!b.is_error, preview: trunc(textOf(b.content), 220) })),
    // 响应侧（逐步填充）
    requestId: null,
    stopReason: null,
    usage: {},
    textOut: '',
    toolUses: [],
    error: null,
    cost: 0,
    // 辅助请求判定：无工具定义且消息很短（如标题生成），不进 Trace 视图
    aux: !(body.tools || []).length && msgs.length <= 2,
  }
}

// ---------- SSE 解析（边转发边采集 usage / tool_use / 文本） ----------
function makeSSECollector(rec) {
  let buf = ''
  let curTool = null
  const handle = (data) => {
    switch (data.type) {
      case 'message_start':
        rec.requestId = data.message?.id || rec.requestId
        rec.model = data.message?.model || rec.model
        rec.usage = { ...data.message?.usage }
        break
      case 'content_block_start':
        if (data.content_block?.type === 'tool_use')
          curTool = { id: data.content_block.id, name: data.content_block.name, _json: '' }
        break
      case 'content_block_delta': {
        const d = data.delta || {}
        if (d.type === 'text_delta' && rec.textOut.length < 800) rec.textOut += d.text || ''
        if (d.type === 'input_json_delta' && curTool) curTool._json += d.partial_json || ''
        break
      }
      case 'content_block_stop':
        if (curTool) {
          let input = curTool._json
          try { input = JSON.parse(curTool._json || '{}') } catch { /* 保留原文 */ }
          rec.toolUses.push({ id: curTool.id, name: curTool.name, input })
          curTool = null
        }
        break
      case 'message_delta':
        rec.usage = { ...rec.usage, ...data.usage }
        rec.stopReason = data.delta?.stop_reason || rec.stopReason
        break
      case 'error':
        rec.status = 'error'
        rec.error = trunc(data.error?.message || JSON.stringify(data.error), 300)
        break
    }
  }
  return {
    push(str) {
      buf += str.replace(/\r/g, '')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try { handle(JSON.parse(payload)) } catch { /* 非 JSON 忽略 */ }
          }
        }
      }
    },
  }
}

function finalize(rec, t0) {
  rec.duration = Date.now() - t0
  rec.cost = costOf(rec.model, rec.usage)
  rec.textOut = trunc(rec.textOut, 800)
  persist(rec)
}

// ---------- 请求转发 ----------
// 上游 URL 拼接：保留 base 的路径（如 bigmodel 的 /api/anthropic），不能用 new URL(path, base)——那会丢弃 base path
const upstreamUrl = (reqUrl) => UPSTREAM.replace(/\/+$/, '') + reqUrl
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function forwardHeaders(req) {
  const pick = ['content-type', 'accept', 'x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta']
  const h = {}
  for (const k of pick) { const v = req.headers[k]; if (v) h[k] = v }
  if (!h['x-api-key'] && !h.authorization) {
    if (process.env.GW_ANTHROPIC_KEY) h['x-api-key'] = process.env.GW_ANTHROPIC_KEY
    else if (FALLBACK_TOKEN) h.authorization = `Bearer ${FALLBACK_TOKEN}`
  }
  return h
}

async function handleMessages(req, res) {
  const t0 = Date.now()
  const rawBody = await readBody(req)
  let body = null
  try { body = JSON.parse(rawBody.toString('utf8')) } catch { /* 非 JSON 直接透传 */ }

  const rec = body ? makeRecord(body, t0) : null
  const collector = body?.stream ? makeSSECollector(rec) : null

  let status = 502, headers = {}, streamBody = null, jsonText = ''
  try {
    if (FAKE) {
      const out = fakeRespond(body)
      status = out.status
      headers = out.headers
      if (body?.stream) streamBody = out.sseText
      else jsonText = out.jsonText
    } else {
      const up = await fetch(upstreamUrl(req.url), {
        method: 'POST',
        headers: { ...forwardHeaders(req), 'content-length': String(rawBody.length) },
        body: rawBody,
      })
      status = up.status
      for (const k of ['content-type', 'anthropic-version', 'request-id']) {
        const v = up.headers.get(k); if (v) headers[k] = v
      }
      if (body?.stream) streamBody = up.body
      else jsonText = await up.text()
    }
  } catch (e) {
    if (rec) { rec.status = 'error'; rec.error = trunc(String(e?.message || e), 300); finalize(rec, t0) }
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'gateway_upstream_error', message: String(e?.message || e) } }))
    return
  }

  if (status >= 400 && rec && !rec.error) { rec.status = 'error'; rec.error = trunc(jsonText || `HTTP ${status}`, 300) }

  // ---- 流式：边转发边采集 ----
  if (streamBody) {
    headers['cache-control'] = 'no-cache'
    let aborted = false
    req.on('close', () => { aborted = true })
    res.writeHead(status, headers)
    try {
      if (typeof streamBody === 'string') {
        collector.push(streamBody)
        res.write(streamBody)
      } else {
        const reader = streamBody.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          collector.push(chunk.toString('utf8'))
          if (!aborted) res.write(chunk)
        }
      }
    } catch (e) {
      if (rec && !rec.error) { rec.status = 'error'; rec.error = trunc(String(e?.message || e), 200) }
    }
    res.end()
    if (rec) finalize(rec, t0)
    return
  }

  // ---- 非流式 ----
  res.writeHead(status, headers)
  res.end(jsonText)
  if (rec) {
    try {
      const j = JSON.parse(jsonText)
      rec.requestId = j.id || rec.requestId
      rec.usage = j.usage || {}
      rec.stopReason = j.stop_reason
      rec.textOut = trunc((j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '), 800)
      rec.toolUses = (j.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }))
      if (j.error) { rec.status = 'error'; rec.error = trunc(j.error.message || JSON.stringify(j.error), 300) }
    } catch { /* 非 JSON 响应 */ }
    finalize(rec, t0)
  }
}

// ---------- 其它路径：透明透传 ----------
async function passthrough(req, res) {
  try {
    const raw = await readBody(req)
    const up = await fetch(upstreamUrl(req.url), {
      method: req.method,
      headers: { ...forwardHeaders(req), 'content-type': req.headers['content-type'] },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
    })
    const h = {}
    up.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v })
    res.writeHead(up.status, h)
    if (up.body) {
      const reader = up.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e?.message || e) }))
  }
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (url.startsWith('/api/')) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v))

    if (url === '/api/health' && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, records: records.length, fake: FAKE, upstream: FAKE ? 'fake' : UPSTREAM }))
      return
    }
    if (url === '/api/traces' && req.method === 'GET') {
      res.end(JSON.stringify({ generatedAt: Date.now(), traces: buildTraces(records) }))
      return
    }
    if (url === '/api/traces' && req.method === 'DELETE') {
      records.length = 0
      fs.writeFile(RECORDS_FILE, '', () => {})
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  if (req.method === 'POST' && url.startsWith('/v1/messages')) {
    await handleMessages(req, res)
    return
  }
  if (FAKE) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found', message: '模拟上游仅支持 POST /v1/messages' } }))
    return
  }
  await passthrough(req, res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[gateway] ✅ http://127.0.0.1:${PORT}`)
  console.log(`[gateway] 接入 Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude`)
  console.log('[gateway] 前端数据:         GET /api/traces')
})
