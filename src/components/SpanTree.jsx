import { cx, fmtMs, fmtTok } from '../utils/format.js'
import { IconChevron, IconAlert, IconCpu, IconLayers, IconSparkles, IconWrench } from './icons.jsx'

export const TYPE_ICON = { agent: IconCpu, subagent: IconLayers, llm: IconSparkles, tool: IconWrench }
export const TYPE_LABEL = { agent: 'Agent', subagent: 'Sub-Agent', llm: 'LLM', tool: 'Tool' }
const TYPE_RGB = {
  agent: 'var(--span-agent-rgb)',
  subagent: 'var(--span-subagent-rgb)',
  llm: 'var(--span-llm-rgb)',
  tool: 'var(--span-tool-rgb)',
}

// 缩进连线颜色 = 祖先类型色（低透明度），一眼看出「谁调用谁」
const guideColor = (t) => `rgba(${TYPE_RGB[t]}, 0.32)`

function SpanRow({ node, guides, ctx, par }) {
  const Icon = TYPE_ICON[node.type]
  const dur = node.end - node.start
  const hasKids = node.children?.length > 0
  const open = !ctx.collapsed.has(node.id)
  const err = node.status === 'error'
  const tok = node.type === 'llm' ? (node.tokensIn || 0) + (node.tokensOut || 0) : null
  const order = ctx.orders.get(node.id) || 0

  const select = () => ctx.onSelect(node)

  return (
    <div
      className={cx('span-row', node.id === ctx.selectedId && 'selected')}
      role="button"
      tabIndex={0}
      data-sid={node.id}
      aria-pressed={node.id === ctx.selectedId}
      aria-label={`${node.name}，${TYPE_LABEL[node.type]}，${fmtMs(dur)}`}
      onClick={select}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select())}
    >
      <div className="tree-cell">
        {guides.map((t, i) => (
          <span key={i} className="indent-guide" style={{ background: guideColor(t) }} />
        ))}
        {hasKids ? (
          <button
            className="chevron"
            data-open={open}
            aria-label={open ? `收起 ${node.name}` : `展开 ${node.name}`}
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); ctx.onToggle(node.id) }}
          >
            <IconChevron width={13} height={13} />
          </button>
        ) : (
          <span className="chevron blank" />
        )}
        <span className={`span-icon ${node.type}`}><Icon width={15} height={15} /></span>
        <span className="span-name">{node.name}</span>
        {err && <span className="span-err-inline"><IconAlert width={13} height={13} /></span>}
        <span className="span-extras">
          {par && <span className="chip chip-par">并行</span>}
          {node.metadata?.retry_of && <span className="chip chip-retry">重试</span>}
          <span className={`badge badge-${node.type}`}>{TYPE_LABEL[node.type]}</span>
        </span>
        {node.model && <span className="chip chip-model" title={node.model}>{node.model}</span>}
        <span className="span-meta">
          {tok != null && <span className="tok">{fmtTok(tok)} tok</span>}
          <span className={cx('dur', err && 'err')}>{fmtMs(dur)}</span>
        </span>
      </div>
      <div className="wf-area">
        <span
          className={cx('wf-bar', node.type, err && 'is-err')}
          style={{
            left: `${(node.start / ctx.total) * 100}%`,
            width: `${Math.max(((node.end - node.start) / ctx.total) * 100, 0.7)}%`,
            '--d': `${Math.min(order * 24, 700)}ms`,
          }}
          title={`${node.name}\n${fmtMs(dur)} · T+${fmtMs(node.start)} → T+${fmtMs(node.end)}`}
        />
      </div>
    </div>
  )
}

// 子层级容器：负责本层并行检测 + stagger 序号 + 展开动画
function Children({ node, guides, ctx }) {
  if (!node.children?.length) return null
  const open = !ctx.collapsed.has(node.id)
  let prevEnd = -1
  return (
    <div className="span-children" data-open={open}>
      {node.children.map((c, i) => {
        const par = i > 0 && c.start < prevEnd
        prevEnd = Math.max(prevEnd, c.end)
        return <SpanNode key={c.id} node={c} index={i} par={par} guides={[...guides, node.type]} ctx={ctx} />
      })}
    </div>
  )
}

function SpanNode({ node, guides, ctx, par, index }) {
  return (
    <div className="span-node" style={{ '--i': index }}>
      <SpanRow node={node} guides={guides} ctx={ctx} par={par} />
      <Children node={node} guides={guides} ctx={ctx} />
    </div>
  )
}

export default function SpanTree({ root, ctx }) {
  return (
    <div className="span-node" style={{ '--i': 0 }}>
      <SpanRow node={root} guides={[]} ctx={ctx} par={false} />
      <Children node={root} guides={[]} ctx={ctx} />
    </div>
  )
}
