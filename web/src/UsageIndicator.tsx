import { useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import './usage-indicator.css'

export type UsageValues = {
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  totalTokens?: number
}
export type UsageTurn = {
  usage?: UsageValues
  totalUsage?: UsageValues
  lastCall?: UsageValues
  usageSource?: string
  contextWindowTokens?: number
}

function display(value?: number) {
  return typeof value === 'number' ? value.toLocaleString() : 'Unavailable'
}
function sourceName(source?: string) {
  if (!source) return 'Unavailable'
  if (source === 'responses') return 'Provider response usage'
  if (source === 'thread-total-delta') return 'Codex thread usage difference'
  return source
}
function sumUsage(turns: UsageTurn[], key: keyof UsageValues): number | undefined {
  if (!turns.length || turns.some((turn) => typeof turn.usage?.[key] !== 'number')) return undefined
  return turns.reduce((sum, turn) => sum + (turn.usage?.[key] ?? 0), 0)
}

export function UsageIndicator({ latest, turns }: { latest?: UsageTurn; turns: UsageTurn[] }) {
  const [open, setOpen] = useState(false)
  const contextInput = latest?.lastCall?.inputTokens
  const contextWindowTokens = latest?.contextWindowTokens || 128000
  const percent = typeof contextInput === 'number' && contextWindowTokens > 0
    ? Math.min(100, Math.round(contextInput / contextWindowTokens * 100)) : undefined
  const cumulative = useMemo(() => ({
    inputTokens: sumUsage(turns, 'inputTokens'),
    cachedInputTokens: sumUsage(turns, 'cachedInputTokens'),
    outputTokens: sumUsage(turns, 'outputTokens'),
    reasoningOutputTokens: sumUsage(turns, 'reasoningOutputTokens'),
    totalTokens: sumUsage(turns, 'totalTokens'),
  }), [turns])
  const latestUsage = latest?.usage
  const threadUsage = latest?.totalUsage ?? cumulative
  return <div className="usage-indicator">
    <button className="usage-indicator-button" type="button" aria-label="Show chat usage" aria-expanded={open} title={percent === undefined ? 'Context usage unavailable' : `${percent}% context used`} onClick={() => setOpen((value) => !value)}>
      <svg className="usage-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="usage-ring-track" cx="18" cy="18" r="15"/><circle className="usage-ring-value" cx="18" cy="18" r="15" pathLength="100" style={{ strokeDasharray: `${percent ?? 0} 100` }}/></svg>
      {percent === undefined ? <Activity size={12}/> : <span>{percent}</span>}
    </button>
    {open && <section className="usage-panel" aria-label="Chat usage details">
      <header><strong>Chat usage</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close usage panel">×</button></header>
      <div className="usage-context"><span>Context used</span><strong>{display(contextInput)} / {latest?.contextWindowTokens ? display(latest.contextWindowTokens) : '128,000 (est.)'}</strong></div>
      <div className="usage-section"><h3>Latest turn</h3><dl>
        <dt>Input</dt><dd>{display(latestUsage?.inputTokens)}</dd>
        <dt>Cached input</dt><dd>{display(latestUsage?.cachedInputTokens)}</dd>
        <dt>Cache write</dt><dd>{display(latestUsage?.cacheWriteInputTokens)}</dd>
        <dt>Output</dt><dd>{display(latestUsage?.outputTokens)}</dd>
        <dt>Reasoning tokens</dt><dd>{display(latestUsage?.reasoningOutputTokens)}</dd>
        <dt>Total</dt><dd>{display(latestUsage?.totalTokens)}</dd>
      </dl><p>Source: {sourceName(latest?.usageSource)}</p></div>
      <div className="usage-section"><h3>Cumulative chat</h3><dl>
        <dt>Input</dt><dd>{display(threadUsage.inputTokens)}</dd>
        <dt>Cached input</dt><dd>{display(threadUsage.cachedInputTokens)}</dd>
        <dt>Output</dt><dd>{display(threadUsage.outputTokens)}</dd>
        <dt>Reasoning tokens</dt><dd>{display(threadUsage.reasoningOutputTokens)}</dd>
        <dt>Total</dt><dd>{display(threadUsage.totalTokens)}</dd>
      </dl><p>Source: {latest?.totalUsage ? 'Codex thread total' : 'sum of reported turn usage'}</p></div>
    </section>}
  </div>
}
