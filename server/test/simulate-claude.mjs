#!/usr/bin/env node
// ============ 模拟 Claude Code 客户端 ============
// 按真实交互序列向网关发送 4 个请求，覆盖：
// 主 Agent 首次请求(Task) → 子 Agent 首次请求(Grep) → 子 Agent 工具结果 → 主 Agent 汇总

const GW = process.env.GW_URL || 'http://127.0.0.1:8787'
const SESSION = 's' + Math.random().toString(36).slice(2, 12)
const USER_ID = `user_sim01_account_acc0001_session_${SESSION}`

const SYS_MAIN =
  'You are Claude Code, Anthropic\'s official CLI for Claude. You are an interactive CLI tool...' + ' '.repeat(50)
const SYS_SUB =
  'You are an agent for Claude Code - Claude\'s command line tool. You execute a well-defined, scoped task...'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 极简 SSE 客户端解析
async function callMessages({ system, messages, stream = true }) {
  const res = await fetch(GW + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-sim0000',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      stream,
      system,
      metadata: { user_id: USER_ID },
      tools: [
        { name: 'Bash', description: 'run shell', input_schema: { type: 'object' } },
        { name: 'Grep', description: 'search', input_schema: { type: 'object' } },
        { name: 'Agent', description: 'spawn subagent', input_schema: { type: 'object' } },
      ],
      messages,
    }),
  })
  if (stream) {
    const text = await res.text()
    return parseSSE(text)
  }
  return res.json()
}

function parseSSE(text) {
  let msg = { text: '', toolUses: [], model: null, stop_reason: null, usage: {} }
  let curTool = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    let d
    try { d = JSON.parse(line.slice(5).trim()) } catch { continue }
    if (d.type === 'message_start') { msg.model = d.message?.model; msg.usage = { ...d.message?.usage } }
    if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') curTool = { ...d.content_block, _json: '' }
    if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') msg.text += d.delta.text
    if (d.delta?.type === 'input_json_delta' && curTool) curTool._json += d.delta.partial_json
    if (d.type === 'content_block_stop' && curTool) {
      curTool.input = JSON.parse(curTool._json || '{}')
      delete curTool._json
      msg.toolUses.push(curTool)
      curTool = null
    }
    if (d.type === 'message_delta') { msg.stop_reason = d.delta?.stop_reason; msg.usage = { ...msg.usage, ...d.usage } }
  }
  return msg
}

const asUserText = (m) => ({ role: 'user', content: [{ type: 'text', text: m }] })
const asAssistant = (msg) => ({ role: 'assistant', content: msg.toolUses.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })) })
const asToolResult = (id, content, isError) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content }] })
// CC 2.1.x 会在每条请求末尾追加 role=system 的提醒消息，模拟该行为以覆盖网关的忽略逻辑
const asSysReminder = () => ({ role: 'system', content: `<total_tokens>${14998990 - Math.floor(Math.random() * 1e4)} tokens left</total_tokens>` })

async function main() {
  console.log(`[sim] 目标网关 ${GW}  session=${SESSION}`)

  // R1 主 Agent：用户提问 → 决策调用 Agent（委派子 Agent）
  const m1 = [asUserText('帮我看下这个项目的网关核心实现在哪，并总结它做了什么'), asSysReminder()]
  const r1 = await callMessages({ system: SYS_MAIN, messages: m1 })
  console.log(`[sim] R1 主Agent → ${r1.stop_reason} ${r1.toolUses.map((t) => t.name).join(',') || r1.text.slice(0, 30)}`)
  await sleep(120)

  const task = r1.toolUses[0]
  const taskPrompt = task.input.prompt

  // R2 子 Agent：接收任务 → 决策调用 Grep
  const m2 = [asUserText(taskPrompt), asSysReminder()]
  const r2 = await callMessages({ system: SYS_SUB, messages: m2 })
  console.log(`[sim] R2 子Agent → ${r2.stop_reason} ${r2.toolUses.map((t) => t.name).join(',')}`)
  await sleep(150)

  // R3 子 Agent：Grep 结果 → 总结
  const grep = r2.toolUses[0]
  const m3 = [...m2, asAssistant(r2), asToolResult(grep.id, 'server/gateway.mjs:88 http.createServer\nserver/gateway.mjs:143 handleMessages\nserver/tree-builder.mjs:152 buildTraces'), asSysReminder()]
  const r3 = await callMessages({ system: SYS_SUB, messages: m3 })
  console.log(`[sim] R3 子Agent → ${r3.stop_reason} ${r3.text.slice(0, 40)}…`)
  await sleep(130)

  // R4 主 Agent：Agent 结果 → 最终回答
  const m4 = [...m1, asAssistant(r1), asToolResult(task.id, r3.text), asSysReminder()]
  const r4 = await callMessages({ system: SYS_MAIN, messages: m4 })
  console.log(`[sim] R4 主Agent → ${r4.stop_reason} ${r4.text.slice(0, 40)}…`)

  console.log('[sim] ✅ 一轮「主 Agent → 子 Agent → 工具」会话已注入网关')
}

main().catch((e) => { console.error('[sim] 失败:', e.message); process.exit(1) })
