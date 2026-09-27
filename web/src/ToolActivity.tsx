import './tool-activity.css'

export type ToolActivityItem = {
  id: string
  label: string
  status: 'running' | 'completed' | 'failed'
  item?: any
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function ActivityDetails({ item }: { item: any }) {
  if (!item) return null
  const type = String(item.type ?? '')
  const isFileChange = /fileChange/i.test(type)
  const args = item.arguments ?? item.args ?? item.input ?? item.parameters
  const output = item.output ?? item.stdout ?? item.result ?? item.content
  const error = item.error ?? item.stderr
  const commandOutput = [
    typeof item.stdout === 'string' ? `stdout\n${item.stdout}` : '',
    typeof item.stderr === 'string' ? `stderr\n${item.stderr}` : '',
    typeof item.exitCode === 'number' ? `exit code: ${item.exitCode}` : typeof item.exit_code === 'number' ? `exit code: ${item.exit_code}` : '',
  ].filter(Boolean).join('\n\n')
  const visibleOutput = commandOutput || printable(output)
  const fileChanges = Array.isArray(item.changes) ? item.changes : []
  return <div className="tool-activity-details">
    {args != null && <section><h4>Arguments</h4><pre>{printable(args)}</pre></section>}
    {visibleOutput && !isFileChange && <section><h4>Output</h4><pre>{visibleOutput}</pre></section>}
    {error != null && <section className="tool-output-error"><h4>Error</h4><pre>{printable(error)}</pre></section>}
    {fileChanges.length > 0 && <section><h4>Changed files</h4><ul>{fileChanges.map((change: any, index: number) => <li key={`${change.path ?? change.filePath ?? index}`}>{String(change.path ?? change.filePath ?? 'File')} · {String(change.kind ?? change.type ?? 'changed')}</li>)}</ul><small>Review diffs in the project files panel.</small></section>}
    {!args && !visibleOutput && !error && !fileChanges.length && <section><h4>Event data</h4><pre>{printable(item)}</pre></section>}
  </div>
}

export function ToolActivity({ items }: { items: ToolActivityItem[] }) {
  if (!items.length) return null
  return <details className="turn-activity">
    <summary>Tool activity <span>{items.length}</span></summary>
    <ul>{items.map((activity) => <li key={activity.id} className={activity.status}>
      <details className="tool-activity-row">
        <summary><span className="activity-mark"/><span className="tool-activity-label">{activity.label}</span><small>{activity.status}</small></summary>
        <ActivityDetails item={activity.item}/>
      </details>
    </li>)}</ul>
  </details>
}
