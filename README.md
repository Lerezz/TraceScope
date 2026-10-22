# TraceScope

> LLM 网关 × Agent 调用轨迹（Trajectory）观测台 —— 把 Claude Code 的每一轮对话重建成可观测的层级树。

一个零依赖后端（Node 原生 http）+ React 前端的轻量组合：网关透传 Anthropic 兼容 API 并旁路记录调用，前端以「层级树 + 瀑布时间线 + 消息流」展示主 Agent / 子 Agent / 工具调用之间的层级与并行关系。

## 功能特性

- **Anthropic 兼容网关**：`POST /v1/messages` 全透传（含 SSE 流式），边转发边采集 tokens（含 cache 读写）、tool_use、stop_reason、耗时与错误
- **层级重建**：session → 会话轮次 → 主 Agent → Task/Agent 子 Agent / 后台 Agent → LLM / 工具，自动识别并行执行、失败与网关重试
- **Trajectory 视图**
  - 层级树：缩进 + 彩色缩进连线（父级类型色）+ 类型徽章三重编码
  - 瀑布时间线：共享时间原点的 Gantt 条，直接看出子 Agent 并行
  - 本轮对话消息流：SYS / USER / CALL / RESULT / AI 序列概览，点击条目定位到对应 Span
  - 详情面板：面包屑调用链路、概览 / 输入 / 输出 / 元数据 / RAW JSON 五个 Tab，每条消息可独立展开全量
- **实时 + Mock 双数据源**：网关有数据自动切换实时（4s 轮询），无数据回退 Mock 演示
- **持久化**：记录落盘 `server/data/records.jsonl`，网关重启不丢

## 架构

```
Claude Code ──ANTHROPIC_BASE_URL──▶ 网关(:8787) ──透传──▶ Anthropic 兼容上游
                                      │ 旁路记录（SSE 抓取 usage / tool_use）
前端(:5173) ◀──/api 代理 + 轮询──────┘ server/data/records.jsonl
```

## 快速开始

环境要求：Node.js ≥ 20（本机无 Node 时可用 [nvm](https://github.com/nvm-sh/nvm) 安装）。

```bash
npm install

# ① 前端（Mock 数据即可浏览）
npm run dev                 # http://localhost:5173

# ② 演示网关（无真实 API key，内置模拟上游）
npm run gateway:demo        # 另一个终端
npm run simulate            # 注入一轮「主 Agent → Task 子 Agent → 工具」模拟会话

# ③ 真实接入 Claude Code
npm run gateway             # 网关读取 claude.settings 的上游与 token
./claude-via-gateway.sh     # 通过网关启动 claude
```

## Claude Code 接入配置

复制 `claude.settings.example` 为 `claude.settings` 并填入你的 token：

| 字段 | 说明 |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | 上游 API token（网关透传/兜底使用） |
| `ANTHROPIC_BASE_URL` | Claude Code 指向的地址（本网关时为 `http://127.0.0.1:8787`） |
| `GW_UPSTREAM` | 网关转发的真实上游（如 `https://open.bigmodel.cn/api/anthropic`） |
| `ANTHROPIC_DEFAULT_*_MODEL` | haiku / sonnet / opus 槽位映射到的模型名 |

> `claude.settings` 含密钥，已在 `.gitignore` 中排除，**请勿提交到仓库**。直连上游地址可备份在 `ANTHROPIC_BASE_URL_BAK`。

## 数据与 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic 兼容端点，透传 + 记录 |
| GET | `/api/traces` | 输出前端可直接消费的层级 Trace 树 |
| DELETE | `/api/traces` | 清空全部记录（内存 + 文件） |
| GET | `/api/health` | 健康检查 |

## 层级重建原理

1. **session**：从 `metadata.user_id` 的 `_session_` 后缀提取（无则按 system + 首条消息指纹）
2. **轮次（turn）**：有效末条消息为纯用户文本 && 无未闭合 Task/Agent && 非子 Agent 接任务 → 新轮次（忽略 CC 2.1.x 追加在末尾的 `system` 提醒消息，如 `<total_tokens>`）
3. **子 Agent（同会话，旧版 Task）**：响应含 `Task` tool_use 时开启容器；其后 system 指纹变化且任务未闭合的请求归入其下，收到对应 tool_result 时闭合
4. **子 Agent（跨会话，CC 2.1.x Agent 异步委派）**：子 Agent 在独立 session 中运行，先按「委派 prompt ↔ 子会话首条消息全文」精确匹配，历史数据回退到任务特征关键词评分归因；多个并行委派各自成容器。WebSearch 搜索子会话按「搜索词 ↔ 主会话 WebSearch tool_use」精确匹配并入父 Trace
5. **工具 span**：上一请求 tool_use 与下一请求 tool_result 之间的时间窗，自动推导并行
6. **后台 Agent**：同用户的无工具辅助请求（如 CC 的 security monitor）逐条归因并入对应 Trace：与主会话共用 session 直接归位；monitor 的 transcript 开场即被审查会话的开场指令，据此归到该会话「开场所在」的链；识别不出归属的独立成后台 Trace，绝不按时间强挂（避免其它会话的审查记录灌进任务 Trace）
7. **轮次来源标注**：每条 Trace 标注来源（用户输入 / 跨会话消息 / 系统通知 / 状态摘要 / 搜索 Agent / 子 Agent / 后台），区分真人输入与 CC 自动注入
8. **会话链归并**：一次真人输入开启对话链，其后由自动注入触发的轮次（跨会话回传 / 系统通知等，跨多个 session）并入同一条大 Trace，每轮作为「轮次」容器——一夜自主运行 = 一条 Trace。**多终端并行对话时**，自动轮次按「session 亲和 → 链内独有关键词（任务号/端口/路径词）内容归因」归回原对话链，不会被最新开启的终端对话吸走

## 项目结构

```
├── DESIGN.md                 # 前端设计规范（亮色工程台 / L2 交互）
├── claude.settings.example   # 配置模板（真实配置 claude.settings 不入库）
├── claude-via-gateway.sh     # 通过网关启动 Claude Code
├── server/
│   ├── gateway.mjs           # 网关：透传 + SSE 采集 + 持久化
│   ├── tree-builder.mjs      # 层级重建 + 计费估算
│   └── test/                 # 模拟上游 / 模拟 Claude 客户端
└── src/                      # React 前端（Vite）
    ├── components/           # 层级树 / 详情面板 / 对话流 等
    ├── data/mock.js          # Mock 数据
    └── utils/trace.js        # 树统计 / 对话流提取
```

## 安全注意

- `claude.settings`（token）与 `server/data/`（真实会话内容）均已 gitignore，请勿强行提交
- GLM 系列模型计价未接入，费用按 $0 显示
- 前端设计规范见 [DESIGN.md](./DESIGN.md)
