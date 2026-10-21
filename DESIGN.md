# DESIGN.md

> 一个把「多步 Agent 调用链」看穿到底的亮色工程观测台 —— 层级即结构，颜色即语义，时间即证据。

## 1. Visual Theme & Atmosphere

**Style**: Clean Engineering Console（亮色简洁工程台）
**Keywords**: 克制、结构化、高信息密度、语义色彩、纸感白、网格感、可信赖
**Tone**: 安静专业的开发者工具 — NOT 花哨营销页、渐变堆砌、赛博霓虹
**Feel**: 像一张摊开在白色绘图桌上的系统调用图纸，树状层级是主干，颜色是批注笔。

**Interaction Tier**: L2 流畅交互
**Dependencies**: CSS + IntersectionObserver（无 GSAP / 无 Lenis，工具页保证滚动原生）

**产品定位**: LLM 网关的 Trajectory 分析前端。核心场景：一轮对话中主 Agent 调用子 Agent、串并行多步执行，需要把**层级关系**（谁调用谁、耗时分布、输入输出）讲清楚。

**核心页面结构**:
1. Traces 列表页 —— 总览统计卡片 + 请求(会话)表格
2. Trace 详情页 —— 左：层级树(带瀑布时间条)；右：Span 详情面板。这是全站灵魂。

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds */
  --bg: #f7f8fa;                    /* 页面背景，纸感浅灰 */
  --surface: #ffffff;               /* 卡片/面板 */
  --surface-alt: #f2f4f7;           /* 次级表面、代码块底 */
  --surface-hover: #f6f7fb;         /* 行 hover 表面 */

  /* Borders */
  --border: #e5e8ee;
  --border-hover: #d4d9e3;

  /* Text */
  --text: #16181d;
  --text-secondary: #5d6470;
  --text-tertiary: #9aa1ad;

  /* Accent */
  --accent: #4f46e5;                /* Indigo 600：CTA、链接、选中态 */
  --accent-hover: #4338ca;
  --accent-soft: #eef0fe;           /* 选中行/标签底色 */
  --accent-rgb: 79, 70, 229;

  /* RGB variants for rgba() */
  --bg-rgb: 247, 248, 250;
  --text-rgb: 22, 24, 29;

  /* Semantic */
  --success: #12b76a;
  --error: #f04438;
  --warning: #f79009;
  --success-rgb: 18, 183, 106;
  --error-rgb: 240, 68, 56;

  /* Span 类型语义色 —— 层级关系的视觉基石 */
  --span-agent: #7c3aed;            /* Agent / Root span：紫 */
  --span-agent-rgb: 124, 58, 237;
  --span-llm: #2563eb;              /* LLM Generation：蓝 */
  --span-llm-rgb: 37, 99, 235;
  --span-tool: #d97706;             /* Tool Call：琥珀 */
  --span-tool-rgb: 217, 119, 6;
  --span-subagent: #0e9384;         /* Sub-Agent：青绿 */
  --span-subagent-rgb: 14, 147, 132;
}
```

**Color Rules:**
- 所有颜色通过 CSS 变量引用，代码中禁止硬编码 hex（mock 文案除外）。
- Span 类型色只用于「类型标识」：左侧图标、缩进连线、类型徽章、瀑布条。同屏同时出现的类型色 ≤ 5 种。
- 页面全局强调色只有 indigo 一族；span 类型色是语义标注，不算装饰色。
- 层级深度用连线 + 缩进表达，不用背景色深浅表达（避免「彩条墙」）。

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| 页面标题 H1 | Inter + Noto Sans SC | 20px | 700 | 1.3 | -0.01em |
| 区块标题 H2 | Inter + Noto Sans SC | 15px | 600 | 1.5 | 0 |
| 卡片/面板标题 H3 | Inter + Noto Sans SC | 13px | 600 | 1.5 | 0.01em |
| UI 正文 | Inter + Noto Sans SC | 14px | 400 | 1.7 | 0.01em |
| 阅读型内容（模型输出） | Noto Sans SC | 15px | 400 | 1.8 | 0.02em |
| Label/辅助 | Inter + Noto Sans SC | 12px | 500 | 1.5 | 0.04em |
| Mono/代码/ID/耗时 | JetBrains Mono | 12px | 400 | 1.7 | 0 |

```css
--font-sans: 'Inter', 'Noto Sans SC', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
--font-mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
```

**Typography Rules:**
- 数字（耗时、token、cost、ID）一律 mono 字体 + `font-variant-numeric: tabular-nums`。
- 中文行高 ≥ 1.7；阅读型内容 ≥ 15px。
- 标题不加渐变、不加投影（克制工程风，按 text-decoration 决策表：非 Landing 无 Hero）。
- **NEVER use**: Roboto / Arial / Times / 系统默认无兜底的字体栈、斜体中文。

## 4. Component Stylings

### Buttons
```css
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 8px;
  font: 500 13px/1 var(--font-sans); cursor: pointer;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  transition: background .18s ease, border-color .18s ease, box-shadow .18s ease, transform .12s ease;
}
.btn:hover { background: var(--surface-alt); border-color: var(--border-hover); }
.btn:active { transform: scale(.97); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }

.btn-primary {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-primary:active { transform: scale(.97); }
.btn-primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 4px rgba(var(--accent-rgb), .15); }
.btn-primary:disabled { opacity: .45; }

.btn-ghost { border-color: transparent; background: transparent; color: var(--text-secondary); }
.btn-ghost:hover { background: var(--surface-alt); color: var(--text); }
```

### Cards（统计卡）
```css
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 16px 18px;
  transition: box-shadow .25s ease, transform .25s ease, border-color .25s ease;
}
.card:hover { border-color: var(--border-hover); box-shadow: 0 4px 16px rgba(var(--text-rgb), .05); }
```

### Table Row（Traces 列表）
```css
.row {
  display: grid; align-items: center;
  border-bottom: 1px solid var(--border); cursor: pointer;
  transition: background .15s ease;
}
.row:hover { background: var(--surface-hover); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
```

### Span 类型徽章
```css
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  height: 20px; padding: 0 8px; border-radius: 999px;
  font: 500 11px/1 var(--font-sans); letter-spacing: .02em;
}
.badge-agent    { color: var(--span-agent);    background: rgba(var(--span-agent-rgb), .09); }
.badge-llm      { color: var(--span-llm);      background: rgba(var(--span-llm-rgb), .08); }
.badge-tool     { color: var(--span-tool);     background: rgba(var(--span-tool-rgb), .09); }
.badge-subagent { color: var(--span-subagent); background: rgba(var(--span-subagent-rgb), .09); }
```

### 树节点行（核心组件）
```css
.span-row {
  position: relative; display: flex; align-items: center; gap: 10px;
  height: 40px; padding: 0 14px 0 0; cursor: pointer;
  transition: background .15s ease;
}
.span-row:hover { background: var(--surface-hover); }
.span-row.selected {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}
.span-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* 缩进连线：每层一条 1px 竖线，颜色随类型淡色 */
.indent-guide { width: 1px; align-self: stretch; background: var(--border); margin-right: 14px; }
```

### Tabs（详情面板）
```css
.tab {
  padding: 8px 2px; margin-right: 18px; font: 500 13px/1 var(--font-sans);
  color: var(--text-tertiary); border-bottom: 2px solid transparent; cursor: pointer;
  transition: color .18s ease, border-color .18s ease;
}
.tab:hover { color: var(--text-secondary); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
```

### Links
```css
.link { color: var(--accent); text-decoration: none; border-radius: 4px; transition: color .15s ease; }
.link:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }
```

### 瀑布时间条
```css
.waterfall-bar {
  position: absolute; top: 50%; transform: translateY(-50%);
  height: 8px; border-radius: 4px; opacity: .85;
  transform-origin: left center;
}
```

### 输入框
```css
.input {
  height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--surface);
  font: 400 13px/1 var(--font-sans); color: var(--text);
  transition: border-color .18s ease, box-shadow .18s ease;
}
.input:hover { border-color: var(--border-hover); }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), .12); }
```

## 5. Layout Principles

**App Shell:**
- 顶栏 56px fixed，含 Logo、环境选择、搜索、时间范围。
- 内容区最大宽度 1680px 居中，左右 padding 24px。

**Trace 详情三栏（桌面）:**
```css
.trace-layout { display: grid; grid-template-columns: minmax(0,1fr) 420px; gap: 16px; }
/* 树区内部：名称+层级 | 瀑布时间轴，时间轴列固定比例 38% */
```

**Spacing Scale:**
- 区块间距: 24px；卡片间距: 16px；卡片内边距: 16-18px
- 表格行高: 44px；树节点行高: 40px；紧凑节奏，信息密度优先

**Stats Grid:**
```css
.stats-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 16px; }
```

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无阴影，1px border | 卡片、表格常态 |
| Subtle | `0 4px 16px rgba(22,24,29,.05)` | 卡片 hover |
| Raised | `0 8px 30px rgba(22,24,29,.10)` | 右侧详情面板、下拉浮层 |
| Overlay | `0 16px 48px rgba(22,24,29,.16)` | 模态/toast |

规则：亮色简洁风阴影只做「层级暗示」不做「氛围」，禁止大范围彩色投影。

## 7. Animation & Interaction

**Motion Philosophy**: 信息优先的微动效 —— 只动 opacity / transform / 高度，节奏 150-700ms，绝不抢走对 trace 的注意力。
**Tier**: L2

### Entrance Animation
```css
@keyframes fadeInUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes barGrow  { from { transform: scaleX(0) translateY(-50%); } to { transform: scaleX(1) translateY(-50%); } }
.reveal { opacity: 0; transform: translateY(16px); transition: opacity .6s cubic-bezier(.16,1,.3,1), transform .6s cubic-bezier(.16,1,.3,1); }
.reveal.in-view { opacity: 1; transform: none; }
```
- 列表行、统计卡入场：fadeInUp + 60ms 阶梯 stagger（JS 设 transition-delay）。
- 瀑布时间条：进入视口后 `barGrow` 依次生长（300ms + 索引延迟），transform-origin: left。

### Expand / Collapse（树层级展开）
```css
@keyframes popIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.span-children[data-open="true"] > * { animation: popIn .28s cubic-bezier(.16,1,.3,1) both; }
.span-children[data-open="true"] > *:nth-child(n) { animation-delay: calc(var(--i, 0) * 45ms); }
.chevron { transition: transform .22s cubic-bezier(.16,1,.3,1); }
.chevron[data-open="true"] { transform: rotate(90deg); }
```

### Hover & Focus
- 树行 hover：背景 `--surface-hover`；选中行：`--accent-soft` + 左侧 2px accent 竖条。
- 统计卡 hover：边框加深 + Subtle 阴影。
- 按钮：hover 变色 / active scale(.97) / focus-visible 2px 描边。

### Scroll Behavior
- 页面原生滚动；区块用 IntersectionObserver reveal（一次性 unobserve）。
- 顶栏滚动后加毛玻璃 `backdrop-filter: blur(10px)`（≤14px 达标）。

### 数字计数器
- 统计卡数字进入视口 count-up（800ms, rAF），reduce-motion 时直接显示终值。

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

## 8. Do's and Don'ts

### Do
- 层级关系必须三重编码：缩进 + 连线 + 类型色，纯视觉即可判断父子。
- 耗时/token/cost/ID 一律 mono + tabular-nums。
- 瀑布时间条与树行严格同网格对齐，时间轴共享同一时间原点。
- 错误 span 用 `--error` 描边 + 图标，但文字保持可读对比度。
- 空/加载态给占位说明，不留白屏。
- 中文 UI 术语与英文技术术语混排时（Trace / Span / Token），术语保持英文不硬翻。

### Don't
- ❌ 不用背景色深浅表达层级深度（用缩进+连线）。
- ❌ 不做滚动劫持（Lenis/scroll-jack）、不做 pin。
- ❌ 不用大面积渐变、彩色投影、发光效果（亮色工程风禁用 glow）。
- ❌ 不用 emoji 当图标（一律内联 SVG）。
- ❌ 不在移动端塞三栏 —— 折叠为单列，详情面板变抽屉。
- ❌ 瀑布条不做持续动画（只在入场生长一次）。
- ❌ 不用纯色块占位图（本工具基本无位图，背景用网格纹理 CSS 绘制）。
- ❌ 不硬编码任何 hex 颜色值（必须走 CSS 变量）。
- ❌ 类型色不兼任按钮/链接强调色（语义与操作分离）。

## 9. Responsive Behavior

**Breakpoints:**
| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1200px | 三栏：树+瀑布 / 详情面板 420px |
| Small Desktop | 900–1200px | 详情面板收窄 360px；统计卡 3+2 |
| Tablet | 640–900px | 详情面板变底部抽屉（点击 span 弹出）；瀑布条隐藏，保留纯树 |
| Mobile | < 640px | 单列；统计卡 2 列×3 行；表格简化（隐藏次要列） |

**Touch Targets:** 最小 44×44px（树行 40px 高 + 12px 纵向点击余量，移动端行高提至 44px）。
**Collapsing Strategy:** 先藏时间轴、再收详情面板为抽屉、最后简化表格列 —— 层级树永远最后被保护。

```css
@media (max-width: 900px) {
  .trace-layout { grid-template-columns: 1fr; }
  .waterfall-col { display: none; }
}
@media (max-width: 640px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .span-row { height: 44px; }
}
```
