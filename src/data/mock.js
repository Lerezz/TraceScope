// ============ Mock 数据 ============
// 时间均为相对 Trace 起点的毫秒数；span 字段：
// { id, name, type: agent|subagent|llm|tool, status, start, end,
//   model?, provider?, tokensIn?, tokensOut?, cost?,
//   input?, output?, error?, metadata?, children? }

let _n = 0
const sp = (o) => ({
  id: o.id ?? `sp_${(++_n).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  status: 'ok',
  children: [],
  metadata: {},
  ...o,
})

const NOW = Date.now()

/* ---------- Trace 1（主角）：主 Agent 编排，两个子 Agent 并行 ---------- */
const heroTree = sp({
  id: 'root',
  type: 'agent',
  name: '主 Agent · 任务编排 Orchestrator',
  start: 0,
  end: 34240,
  input: {
    messages: [
      { role: 'system', content: '你是工程分析编排 Agent。将复杂任务拆解为子任务，并行调度子 Agent，最后汇总输出。' },
      { role: 'user', content: '帮我分析 trajectory-analyse 这个仓库的架构，评估测试覆盖情况，并给出重构建议。' },
    ],
  },
  output:
    '已完成全链路分析：\n1. 架构层面：engine.js 承担了 7 个模块的公共依赖，建议拆分为 parser / emitter / store 三层。\n2. 测试层面：整体覆盖率 61.4%，trace 序列化模块缺口最大（38.2%）。\n3. 重构建议：优先补齐序列化模块的快照测试，再做 engine 拆分，预计降低 40% 回归风险。',
  metadata: { agent: 'orchestrator', session: 'sess_a91f0c', gateway_route: 'llm-gw-prod', turn: 3 },
  children: [
    sp({
      id: 'g1', type: 'llm', name: '意图识别与任务拆解', start: 400, end: 3120,
      model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 1284, tokensOut: 356, cost: 0.0089,
      input: {
        messages: [
          { role: 'system', content: '任务规划器：把用户请求拆解为可并行的子任务，输出 JSON 计划。' },
          { role: 'user', content: '帮我分析 trajectory-analyse 这个仓库的架构，评估测试覆盖情况，并给出重构建议。' },
        ],
      },
      output:
        '任务计划：\n[并行 A] 代码架构分析 → 子 Agent·arch-analyst\n[并行 B] 测试覆盖评估 → 子 Agent·coverage-analyst\n[串行] 汇总生成重构建议 → claude-sonnet-4.5',
      metadata: { temperature: 0.2, finish_reason: 'tool_calls' },
    }),
    sp({
      id: 't1', type: 'tool', name: 'memory.load_context', start: 3180, end: 3960,
      input: { session: 'sess_a91f0c', window: 12 },
      output: { messages_loaded: 12, files_touched: ['src/App.jsx', 'src/trace/engine.js'], cache: 'hit' },
      metadata: { tool: 'memory', driver: 'redis' },
    }),
    /* ---- 子 Agent A：代码架构分析（与 B 并行） ---- */
    sp({
      id: 'sa1', type: 'subagent', name: '子 Agent · 代码架构分析', start: 4420, end: 22760,
      input: { task: '分析仓库模块结构与依赖关系', handoff_from: 'orchestrator' },
      output: '架构分析完成：识别出 3 个高耦合模块，engine.js 为核心瓶颈，详见子报告。',
      metadata: { agent: 'arch-analyst', model_policy: ['gpt-4o-mini', 'claude-sonnet-4.5'], spawned_by: 'g1#plan' },
      children: [
        sp({
          id: 'a1', type: 'llm', name: '加载分析指令', start: 4640, end: 6880,
          model: 'gpt-4o-mini', provider: 'openai', tokensIn: 2104, tokensOut: 312, cost: 0.0013,
          input: { messages: [{ role: 'system', content: '你是代码架构分析师，按指令逐步读取仓库并产出依赖结论。' }, { role: 'user', content: '任务：分析 trajectory-analyse 仓库的模块结构与依赖关系。' }] },
          output: '指令解析完成。计划：list_tree → read 关键文件 → parse_imports → 输出结论。',
          metadata: { temperature: 0.1 },
        }),
        sp({
          id: 'a2', type: 'tool', name: 'fs.list_tree --depth 3', start: 7020, end: 8060,
          input: { path: '.', depth: 3, exclude: ['node_modules', 'dist'] },
          output: '42 个文件 / 6 个目录；src/trace/ 占 68% 代码量；入口 src/main.jsx。',
          metadata: { tool: 'fs' },
        }),
        sp({
          id: 'a3', type: 'tool', name: 'fs.read_file src/App.jsx', start: 8180, end: 10360,
          input: { path: 'src/App.jsx' }, output: '读取成功，412 行。',
          metadata: { tool: 'fs' },
        }),
        sp({
          id: 'a4', type: 'tool', name: 'fs.read_file src/trace/engine.js', start: 8220, end: 10180,
          input: { path: 'src/trace/engine.js' }, output: '读取成功，1,208 行。',
          metadata: { tool: 'fs' },
        }),
        sp({
          id: 'a5', type: 'llm', name: '分析模块依赖关系', start: 10540, end: 15240,
          model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 9842, tokensOut: 1874, cost: 0.0264,
          input: { messages: [{ role: 'user', content: '基于已读取的 App.jsx 与 engine.js，输出模块依赖图与耦合热点。' }] },
          output: '依赖分析：engine.js 被 7 个模块引用（扇入 7）；SpanTree ↔ DetailPanel 存在循环引用；建议引入 trace/repository 中间层。',
          metadata: { temperature: 0.3, cached_prefix: '8.2k' },
        }),
        sp({
          id: 'a6', type: 'tool', name: 'ast.parse_imports', start: 15380, end: 16760,
          input: { targets: ['src/**/*.js?(x)'] },
          output: { modules: 18, edges: 47, cycles: 1, hot: 'src/trace/engine.js (in:7 out:12)' },
          metadata: { tool: 'ast' },
        }),
        sp({
          id: 'a7', type: 'llm', name: '生成架构评估结论', start: 16980, end: 22540,
          model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 11236, tokensOut: 2214, cost: 0.0311,
          input: { messages: [{ role: 'user', content: '结合 AST 结果生成架构评估报告（要点式）。' }] },
          output: '架构评估：\n· 分层：UI → Tree → Engine 三层清晰，但 Engine 职责过重（解析/发射/存储混杂）。\n· 耦合：1 处循环依赖；engine.js 扇入 7。\n· 建议：拆分 parser / emitter / store，接口收敛到 repository。',
          metadata: { temperature: 0.2 },
        }),
      ],
    }),
    /* ---- 子 Agent B：测试覆盖分析（与 A 并行） ---- */
    sp({
      id: 'sb1', type: 'subagent', name: '子 Agent · 测试覆盖分析', start: 4420, end: 26180,
      input: { task: '运行测试并评估覆盖率缺口', handoff_from: 'orchestrator' },
      output: '覆盖率评估完成：61.4%，序列化模块缺口最大；期间触发 1 次限流并成功重试。',
      metadata: { agent: 'coverage-analyst', model_policy: ['deepseek-v3'], spawned_by: 'g1#plan' },
      children: [
        sp({
          id: 'b1', type: 'llm', name: '解析测试任务', start: 4660, end: 7340,
          model: 'deepseek-v3', provider: 'deepseek', tokensIn: 1980, tokensOut: 298, cost: 0.0007,
          input: { messages: [{ role: 'user', content: '运行仓库测试并解读覆盖率，标注缺口最大的三个模块。' }] },
          output: '计划：run_tests --coverage → 读取 lcov → 输出缺口排序。',
          metadata: { temperature: 0.1 },
        }),
        sp({
          id: 'b2', type: 'tool', name: 'shell.run_tests --coverage', start: 7520, end: 13180,
          input: { cmd: 'npm test -- --coverage', timeout_ms: 30000 },
          output: { passed: 118, failed: 2, skipped: 4, coverage_total: '61.4%', duration_s: 5.4 },
          metadata: { tool: 'shell', exit_code: 0 },
        }),
        sp({
          id: 'b3', type: 'tool', name: 'fs.read_file coverage/lcov.info', start: 13320, end: 14020,
          input: { path: 'coverage/lcov.info' }, output: '读取成功，38 KB。',
          metadata: { tool: 'fs' },
        }),
        sp({
          id: 'b4', type: 'llm', name: '评估覆盖率缺口', start: 14260, end: 20780,
          model: 'deepseek-v3', provider: 'deepseek', tokensIn: 8452, tokensOut: 1532, cost: 0.0041,
          input: { messages: [{ role: 'user', content: '基于 lcov 数据输出缺口排序与影响面评估。' }] },
          output: '缺口排序：trace/serializer 38.2% < trace/engine 54.1% < components/DetailPanel 66.7%。序列化模块无任何快照测试，回归风险最高。',
          metadata: { temperature: 0.2 },
        }),
        sp({
          id: 'b5', type: 'llm', name: '生成覆盖报告', start: 21020, end: 21640, status: 'error',
          model: 'deepseek-v3', provider: 'deepseek', tokensIn: 4102, tokensOut: 0, cost: 0,
          input: { messages: [{ role: 'user', content: '汇总为覆盖报告（markdown）。' }] },
          error: 'HTTP 429 Too Many Requests · provider=deepseek (retryable, backoff 460ms)',
          metadata: { retryable: true, attempt: 1, backoff_ms: 460 },
        }),
        sp({
          id: 'b6', type: 'llm', name: '生成覆盖报告（重试）', start: 22100, end: 26020,
          model: 'deepseek-v3', provider: 'deepseek', tokensIn: 4102, tokensOut: 1876, cost: 0.0022,
          input: { messages: [{ role: 'user', content: '汇总为覆盖报告（markdown）。' }] },
          output: '覆盖报告：整体 61.4%。建议优先补齐 serializer 快照测试（缺口 38.2%），其次 engine 的分支覆盖。',
          metadata: { retry_of: 'b5', attempt: 2, gateway_retry: true },
        }),
      ],
    }),
    sp({
      id: 'g2', type: 'llm', name: '汇总报告 · 生成重构建议', start: 27020, end: 33460,
      model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 14532, tokensOut: 3148, cost: 0.0412,
      input: {
        messages: [
          { role: 'user', content: '子报告 A（架构）：engine.js 拆分为 parser/emitter/store…' },
          { role: 'user', content: '子报告 B（覆盖）：61.4%，serializer 缺口最大…' },
          { role: 'system', content: '合并两份子报告，输出最终重构建议（含优先级与风险）。' },
        ],
      },
      output:
        '## 重构建议\n### P0 · 补齐 serializer 快照测试\n缺口 38.2%，任何 schema 变更都在裸奔。预计 2 人日。\n### P1 · 拆分 engine.js\n引入 trace/repository 收敛接口，消除循环依赖。预计 5 人日。\n### P2 · DetailPanel 数据下沉\n将 span 解析逻辑移入 selector 层，组件只做展示。',
      metadata: { temperature: 0.4, finish_reason: 'stop' },
    }),
  ],
})

/* ---------- 其余 Trace（工厂生成的小型层级） ---------- */
const T2 = sp({
  type: 'agent', name: 'RAG 问答 Agent', start: 0, end: 8420,
  input: { messages: [{ role: 'user', content: '网关限流策略支持按模型维度配置吗？' }] },
  output: '支持。在 gateway.yaml 的 rate_limit.models 下按模型设置独立 QPS 与并发上限……',
  metadata: { agent: 'rag-qa', session: 'sess_77b2e1' },
  children: [
    sp({ type: 'tool', name: 'retriever.search_knowledge_base', start: 380, end: 1980, input: { query: '网关限流 模型维度 配置', top_k: 5 }, output: { hits: 5, top_score: 0.92, sources: ['docs/ratelimit.md', 'docs/config.yaml'] }, metadata: { tool: 'retriever', store: 'qdrant' } }),
    sp({ type: 'llm', name: '生成回答', start: 2100, end: 8300, model: 'qwen-max', provider: 'aliyun', tokensIn: 3268, tokensOut: 742, cost: 0.0031, input: { messages: [{ role: 'user', content: '基于检索结果回答限流配置问题。' }] }, output: '支持按模型维度配置：在 rate_limit.models 中为每个模型声明 qps 与并发上限……', metadata: { temperature: 0.3 } }),
  ],
})

const T3 = sp({
  type: 'agent', name: '代码评审 Agent · 多文件 PR', start: 0, end: 18900,
  input: { messages: [{ role: 'user', content: '评审 PR #482：gateway 重试逻辑改造' }] },
  output: '评审完成：2 个子 Agent 并行评审前后端，后端发现 1 处 schema 源连接问题（已切备用节点）。',
  metadata: { agent: 'reviewer', pr: 482 },
  children: [
    sp({
      type: 'subagent', name: '子 Agent · 前端评审', start: 420, end: 9860,
      input: { task: '评审前端 diff' }, output: '前端无阻塞问题，2 条建议。',
      metadata: { agent: 'fe-reviewer' },
      children: [
        sp({ type: 'llm', name: 'diff 解读', start: 640, end: 3120, model: 'gpt-4o-mini', provider: 'openai', tokensIn: 3420, tokensOut: 512, cost: 0.0021, input: { messages: [{ role: 'user', content: '解读前端 diff。' }] }, output: '改动集中在 TraceTable 组件与样式。', metadata: {} }),
        sp({ type: 'tool', name: 'git.diff --stat', start: 3260, end: 3980, input: { pr: 482, scope: 'frontend' }, output: '8 files changed, +212 −96。', metadata: { tool: 'git' } }),
        sp({ type: 'llm', name: '生成前端评审意见', start: 4160, end: 9700, model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 6820, tokensOut: 1104, cost: 0.0192, input: { messages: [{ role: 'user', content: '输出前端评审意见。' }] }, output: '1) 行高建议抽为 token；2) 空态插画可复用。无阻塞。', metadata: {} }),
      ],
    }),
    sp({
      type: 'subagent', name: '子 Agent · 后端评审', start: 420, end: 14760,
      input: { task: '评审后端 diff 与 SQL' }, output: '后端 1 处 schema introspection 连接失败，切换备用节点后完成。',
      metadata: { agent: 'be-reviewer' },
      children: [
        sp({ type: 'llm', name: 'API 变更解析', start: 660, end: 4240, model: 'deepseek-v3', provider: 'deepseek', tokensIn: 4180, tokensOut: 690, cost: 0.0018, input: { messages: [{ role: 'user', content: '解析 API 变更。' }] }, output: '新增 /v1/traces/:id/waterfall 接口。', metadata: {} }),
        sp({ type: 'tool', name: 'db.explain_plan', start: 4420, end: 7680, input: { sql: 'SELECT * FROM spans WHERE trace_id = $1' }, output: 'Index Scan using idx_trace_id, cost 0.31..48.2', metadata: { tool: 'db' } }),
        sp({ type: 'tool', name: 'db.schema_introspect', start: 7860, end: 8640, status: 'error', input: { source: 'db-replica-2' }, error: 'ECONNREFUSED · db-replica-2:5432 (host down)', output: null, metadata: { tool: 'db', failover: true } }),
        sp({ type: 'tool', name: 'db.schema_introspect（备用节点）', start: 8720, end: 10980, input: { source: 'db-primary' }, output: { tables: 12, columns: 148 }, metadata: { tool: 'db', failover_from: 'db-replica-2' } }),
        sp({ type: 'llm', name: '生成后端评审意见', start: 11160, end: 14700, model: 'deepseek-v3', provider: 'deepseek', tokensIn: 5240, tokensOut: 986, cost: 0.0026, input: { messages: [{ role: 'user', content: '输出后端评审意见。' }] }, output: '重试退避建议改用指数+jitter；schema 查询加只读副本熔断。', metadata: {} }),
      ],
    }),
    sp({ type: 'llm', name: '汇总评审结论', start: 15200, end: 18800, model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 3120, tokensOut: 842, cost: 0.0121, input: { messages: [{ role: 'user', content: '合并前后端评审结论。' }] }, output: '总体通过；2 条非阻塞建议 + 1 条失败切换记录。', metadata: {} }),
  ],
})

const T4 = sp({
  type: 'agent', name: 'SQL 生成 Agent', start: 0, end: 5260,
  input: { messages: [{ role: 'user', content: '查最近 7 天延迟 P95 最高的 5 个模型' }] },
  output: '已生成并执行只读 SQL，返回 5 行。',
  metadata: { agent: 'sqlgen', readonly: true },
  children: [
    sp({ type: 'llm', name: 'SQL 生成', start: 300, end: 2600, model: 'deepseek-v3', provider: 'deepseek', tokensIn: 890, tokensOut: 214, cost: 0.0004, input: { messages: [{ role: 'user', content: '生成只读 SQL。' }] }, output: 'SELECT model, percentile_cont(0.95) … GROUP BY model ORDER BY p95 DESC LIMIT 5', metadata: {} }),
    sp({ type: 'tool', name: 'db.execute (readonly)', start: 2740, end: 4020, input: { mode: 'readonly', max_rows: 100 }, output: { rows: 5, fields: ['model', 'p95_ms'], top: 'gemini-2.0-flash · 4210ms' }, metadata: { tool: 'db' } }),
    sp({ type: 'llm', name: '结果解读', start: 4160, end: 5180, model: 'gpt-4o-mini', provider: 'openai', tokensIn: 640, tokensOut: 186, cost: 0.0003, input: { messages: [{ role: 'user', content: '解读查询结果。' }] }, output: 'gemini-2.0-flash P95 最高，主要由 429 重试放大。', metadata: {} }),
  ],
})

const T5 = sp({
  type: 'agent', name: '周报生成 Agent · 三段流水线', start: 0, end: 41000,
  input: { messages: [{ role: 'user', content: '生成本周工程周报' }] },
  output: '周报已生成：Git 活动 / 任务进展 / 润色三段完成。',
  metadata: { agent: 'weekly-report' },
  children: [
    sp({
      type: 'subagent', name: '子 Agent · Git 活动分析', start: 400, end: 12400,
      input: { task: '归纳本周提交' }, output: '本周 43 commits，主题集中在 trace 树性能。',
      metadata: { agent: 'git-analyst' },
      children: [
        sp({ type: 'tool', name: 'git.log --since 7d', start: 620, end: 2100, input: { since: '7d', author: '*' }, output: '43 commits / 6 authors。', metadata: { tool: 'git' } }),
        sp({ type: 'llm', name: '归纳提交主题', start: 2300, end: 12200, model: 'qwen-plus', provider: 'aliyun', tokensIn: 5210, tokensOut: 1340, cost: 0.0027, input: { messages: [{ role: 'user', content: '按主题聚类本周提交。' }] }, output: '三类：树渲染优化(19) / 面板重构(16) / 修 bug(8)。', metadata: {} }),
      ],
    }),
    sp({
      type: 'subagent', name: '子 Agent · 任务系统汇总', start: 12600, end: 24800,
      input: { task: '汇总任务进展' }, output: '12 项完成 / 3 项进行中 / 1 项阻塞。',
      metadata: { agent: 'task-analyst' },
      children: [
        sp({ type: 'tool', name: 'task.query_my_items', start: 12820, end: 14040, input: { range: 'week' }, output: { done: 12, doing: 3, blocked: 1 }, metadata: { tool: 'lark-task' } }),
        sp({ type: 'llm', name: '进展提炼', start: 14260, end: 24600, model: 'deepseek-v3', provider: 'deepseek', tokensIn: 3980, tokensOut: 872, cost: 0.0021, input: { messages: [{ role: 'user', content: '提炼任务进展要点。' }] }, output: '核心进展：层级树 MVP 完成；阻塞：设计稿待评审。', metadata: {} }),
      ],
    }),
    sp({
      type: 'subagent', name: '子 Agent · 文风润色', start: 25000, end: 36400,
      input: { task: '草稿生成与润色' }, output: '周报定稿完成。',
      metadata: { agent: 'polisher' },
      children: [
        sp({ type: 'llm', name: '草稿生成', start: 25220, end: 31400, model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 6120, tokensOut: 1480, cost: 0.0182, input: { messages: [{ role: 'user', content: '合并素材生成周报草稿。' }] }, output: '草稿 v1 完成，六个小节。', metadata: {} }),
        sp({ type: 'llm', name: '润色定稿', start: 31600, end: 36300, model: 'claude-sonnet-4.5', provider: 'anthropic', tokensIn: 6840, tokensOut: 1620, cost: 0.0204, input: { messages: [{ role: 'user', content: '按团队文风润色定稿。' }] }, output: '定稿：语气收敛、数据加粗、去掉口语。', metadata: { temperature: 0.5 } }),
      ],
    }),
    sp({ type: 'llm', name: '最终排版输出', start: 37200, end: 40800, model: 'gpt-4o-mini', provider: 'openai', tokensIn: 2140, tokensOut: 980, cost: 0.0014, input: { messages: [{ role: 'user', content: '输出 markdown 周报。' }] }, output: '# 周报 W42 …', metadata: {} }),
  ],
})

const T6 = sp({
  type: 'agent', name: '客服意图分类', start: 0, end: 1240,
  input: { messages: [{ role: 'user', content: '我的额度为什么突然用完了' }] },
  output: 'intent=billing.quota_exhausted, confidence=0.96',
  metadata: { agent: 'intent-clf' },
  children: [
    sp({ type: 'llm', name: '意图分类', start: 180, end: 1160, model: 'gpt-4o-mini', provider: 'openai', tokensIn: 214, tokensOut: 8, cost: 0.0001, input: { messages: [{ role: 'user', content: '分类：billing/support/other' }] }, output: 'billing.quota_exhausted', metadata: { latency_slo: '800ms' } }),
  ],
})

const T7 = sp({
  type: 'agent', name: '文档摘要 Agent', start: 0, end: 6800,
  input: { messages: [{ role: 'user', content: '总结 docs/api.md' }] },
  output: 'API 文档摘要：5 个端点，2 个鉴权方式。',
  metadata: { agent: 'summarizer' },
  children: [
    sp({ type: 'tool', name: 'fs.read_file docs/api.md', start: 200, end: 1300, input: { path: 'docs/api.md' }, output: '读取成功，18 KB。', metadata: { tool: 'fs' } }),
    sp({ type: 'llm', name: '生成摘要', start: 1440, end: 6700, model: 'qwen-max', provider: 'aliyun', tokensIn: 5820, tokensOut: 640, cost: 0.0044, input: { messages: [{ role: 'user', content: '输出结构化摘要。' }] }, output: '5 端点 / 2 鉴权 / 限流说明。', metadata: {} }),
  ],
})

const T8 = sp({
  type: 'agent', name: '数据清洗流水线', start: 0, end: 9020, status: 'error',
  input: { messages: [{ role: 'user', content: '清洗并导入 2026Q3 CSV' }] },
  output: null,
  error: '流水线失败：db.batch_upsert 写入超时，已回滚。',
  metadata: { agent: 'etl', source: 'uploads/2026q3.csv' },
  children: [
    sp({ type: 'tool', name: 'fs.read_csv uploads/2026q3.csv', start: 240, end: 2200, input: { path: 'uploads/2026q3.csv' }, output: { rows: 48210, cols: 14 }, metadata: { tool: 'fs' } }),
    sp({ type: 'tool', name: 'transform.validate_schema', start: 2360, end: 4900, input: { schema: 'v3' }, output: { valid: 48188, invalid: 22 }, metadata: { tool: 'transform' } }),
    sp({ type: 'tool', name: 'db.batch_upsert', start: 5040, end: 8900, status: 'error', input: { batch: 500, table: 'raw_events' }, error: 'ETIMEDOUT · upstream db write timeout (12s), 已回滚 96 个批次', output: null, metadata: { tool: 'db', batches: 96, rolled_back: true } }),
  ],
})

/* ---------- Trace 列表 ---------- */
export const TRACES = [
  { id: 'tr_9f27ac', name: '仓库架构分析 · 主 Agent 编排', ts: NOW - 3 * 60e3, user: 'u_li_dev', conv: '会话 #4821 · 第 3 轮', query: '帮我分析 trajectory-analyse 这个仓库的架构…', tree: heroTree },
  { id: 'tr_4b81de', name: 'RAG 知识库问答', ts: NOW - 18 * 60e3, user: 'u_wang_ops', conv: '会话 #4819 · 第 1 轮', query: '网关限流策略支持按模型维度配置吗？', tree: T2 },
  { id: 'tr_c23a90', name: '代码评审 · PR #482', ts: NOW - 74 * 60e3, user: 'u_zhang_fe', conv: ' webhook · pr#482 ', query: '评审 PR #482：gateway 重试逻辑改造', tree: T3 },
  { id: 'tr_7e55f1', name: 'SQL 生成与执行', ts: NOW - 3 * 3600e3, user: 'u_li_dev', conv: '会话 #4802 · 第 1 轮', query: '查最近 7 天延迟 P95 最高的 5 个模型', tree: T4 },
  { id: 'tr_a10c3b', name: '周报生成 · 三段流水线', ts: NOW - 6 * 3600e3, user: 'u_sched_cron', conv: '定时任务 · 每周五 18:00', query: '生成本周工程周报', tree: T5 },
  { id: 'tr_d9847e', name: '客服意图分类', ts: NOW - 9 * 3600e3, user: 'u_bot_cs', conv: '队列 · cs-inbound', query: '我的额度为什么突然用完了', tree: T6 },
  { id: 'tr_5f2c68', name: '文档摘要', ts: NOW - 26 * 3600e3, user: 'u_wang_ops', conv: '会话 #4790 · 第 2 轮', query: '总结 docs/api.md', tree: T7 },
  { id: 'tr_e71102', name: '数据清洗流水线（失败）', ts: NOW - 31 * 3600e3, user: 'u_sched_etl', conv: '定时任务 · 每日 02:00', query: '清洗并导入 2026Q3 CSV', tree: T8 },
]
