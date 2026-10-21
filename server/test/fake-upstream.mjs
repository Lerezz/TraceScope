// ============ 模拟上游：无真实 Anthropic key 时的可演示后端 ============
// 按请求特征返回脚本化响应，覆盖「主 Agent → Task 子 Agent → 工具」完整链路

let _n = 0
const uid = (p) => `${p}_${(++_n).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`

function sysText(body) {
  return typeof body?.system === 'string' ? body.system : textJoin(body?.system)
}
function textJoin(sys) {
  if (!sys) return ''
  return sys.map((b) => b.text || '').join('\n')
}

function decide(body) {
  const isSub = /agent for Claude Code|You are an agent/i.test(sysText(body))
  const msgs = body.messages || []
  const hasAnyToolResult = msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
  const lastBlocks = Array.isArray(msgs[msgs.length - 1]?.content) ? msgs[msgs.length - 1].content : []
  const lastIsToolResult = lastBlocks.some((b) => b.type === 'tool_result')

  if (isSub) {
    if (lastIsToolResult)
      return {
        stop_reason: 'end_sequence',
        blocks: [{ type: 'text', text: '分析完成：核心实现在 server/gateway.mjs（透传与记录）与 server/tree-builder.mjs（层级重建）。网关按 session 切分轮次，用 Task tool_use 推断子 Agent 边界。' }],
        usage: { input_tokens: 1420, output_tokens: 96 },
      }
    return {
      stop_reason: 'tool_use',
      blocks: [{ type: 'tool_use', id: uid('toolu'), name: 'Grep', input: { pattern: 'createServer', path: 'server', output_mode: 'content' } }],
      usage: { input_tokens: 980, output_tokens: 84 },
    }
  }
  if (!hasAnyToolResult)
    return {
      stop_reason: 'tool_use',
      blocks: [{ type: 'tool_use', id: uid('toolu'), name: 'Task', input: { subagent_type: 'code-searcher', description: '在仓库中定位网关核心实现文件', prompt: '搜索 server 目录，找到 HTTP server 创建与消息记录的位置并总结。' } }],
      usage: { input_tokens: 2860, output_tokens: 152 },
    }
  return {
    stop_reason: 'end_sequence',
    blocks: [{ type: 'text', text: '已通过子代理定位并总结：网关在 /v1/messages 上做 SSE 透传，边转发边采集 usage 与 tool_use；层级树按「session → 轮次 → 子 Agent → 工具」重建，可直接在前端 Trajectory 视图中观测。' }],
    usage: { input_tokens: 4310, output_tokens: 138 },
  }
}

// 生成完整 SSE 文本（与 Anthropic 事件序列一致）
function toSSE(msgId, model, blocks, stop, usage) {
  const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`
  let s = ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens || 0, cache_read_input_tokens: 512, cache_creation_input_tokens: 0, output_tokens: 1 } } })
  blocks.forEach((b, i) => {
    s += ev('content_block_start', { index: i, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } })
    if (b.type === 'text') s += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } })
    else for (const part of chunkJson(JSON.stringify(b.input))) s += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: part } })
    s += ev('content_block_stop', { index: i })
  })
  s += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens || 1 } })
  s += ev('message_stop')
  return s
}
function chunkJson(str, n = 40) {
  const out = []
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n))
  return out
}

export function fakeRespond(body) {
  const { stop_reason, blocks, usage } = decide(body)
  const model = body.model || 'claude-sonnet-4-5-20250929'
  const msgId = uid('msg')
  const headers = { 'content-type': body?.stream ? 'text/event-stream; charset=utf-8' : 'application/json', 'request-id': uid('req') }
  if (body?.stream) {
    return { status: 200, headers, sseText: toSSE(msgId, model, blocks, stop_reason, usage) }
  }
  const message = { id: msgId, type: 'message', role: 'assistant', model, content: blocks, stop_reason, stop_sequence: null, usage }
  return { status: 200, headers, jsonText: JSON.stringify(message) }
}
