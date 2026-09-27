import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, CircleHelp, Code2, Command, FileText, Folder, Globe, KeyRound, LoaderCircle, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Radio, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react'
import { FilesReviewPanel } from './FilesReviewPanel'
import { GitConnectionPanel } from './GitConnectionPanel'
import { ToolActivity, type ToolActivityItem } from './ToolActivity'
import { UsageIndicator, type UsageTurn } from './UsageIndicator'
import './chat-features.css'

type Status = { projectPath?: string; appServer?: { status?: string; error?: string }; config?: { provider?: string; baseUrl?: string; model?: string } }
type Thread = { id: string; title?: string; name?: string; createdAt?: string }
type Message = { role: 'user' | 'assistant' | 'tool'; text: string; id: string; time?: string; turnId?: string }
type TokenUsage = { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number }
type TurnActivity = ToolActivityItem
type TurnDetail = { reasoningParts?: Record<string, string>; usage?: TokenUsage; lastCall?: TokenUsage; usageSource?: string; totalUsage?: TokenUsage; contextWindowTokens?: number; activity?: TurnActivity[]; calls?: Array<{ responseId?: string; usage: TokenUsage }> }
type Approval = { id: string; method: string; params: any }
type InstructionDoc = { scope: 'global' | 'project'; path: string; exists: boolean; content: string }
type Project = { path: string; name: string }
type ModelChoice = { id: string; displayName?: string; supportedReasoningEfforts?: Array<string | { reasoningEffort?: string; effort?: string; description?: string }>; defaultReasoningEffort?: string; toolSupport?: 'supported' | 'unsupported' | 'unknown' }
type SearchStatus = { enabled: boolean; status: 'disabled' | 'configured' | 'unknown'; native: { availability: 'disabled' | 'unverified'; threadReady: boolean | null }; beeja: { configured: boolean; threadReady: boolean | null; sources: string[] }; newThreadRequired: boolean; endpointUrl?: string; tavilyConfigured?: boolean }
const API = ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`)
  return body as T
}
const stringify = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
function collectText(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n')
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  return collectText(value.content ?? value.parts ?? value.items ?? value.output ?? value.message)
}
function normalizeMessages(data: any): Message[] {
  const rows = Array.isArray(data) ? data : data.messages ?? data.thread?.messages ?? data.thread?.turns ?? data.turns ?? []
  return rows.flatMap((row: any, index: number) => {
    const items = row.items ?? row.content ?? row.messages
    if (Array.isArray(items) && !row.role) {
      const turnId = String(row.id ?? row.turnId ?? row.turn_id ?? '') || undefined
      const normalized: Message[] = items.flatMap((item: any, child: number): Message[] => {
        const itemType = String(item.type ?? item.role ?? '')
        const summary = reasoningSummary(item)
        if (/reasoning/i.test(itemType) && summary) return []
        const text = collectText(item)
        if (!text) return []
        return [{ id: String(item.id ?? `${index}-${child}`), role: /user/i.test(itemType) ? 'user' : /tool|command/i.test(itemType) ? 'tool' : 'assistant', text, time: item.createdAt, turnId }]
      })
      if (row.status === 'failed') normalized.push({ id: `${index}-error`, role: 'tool', text: `Turn failed: ${row.error?.message ?? row.error ?? 'The app server reported an error.'}` })
      return normalized
    }
    const role = /user/i.test(row.role ?? row.type ?? '') ? 'user' : /tool|command/i.test(row.type ?? row.role ?? '') ? 'tool' : 'assistant'
    const text = collectText(row.text ?? row.content ?? row.parts ?? row.output)
    const normalized: Message[] = text ? [{ id: String(row.id ?? index), role, text, time: row.createdAt, turnId: String(row.turnId ?? row.turn_id ?? '') || undefined }] : []
    if (row.status === 'failed') normalized.push({ id: `${index}-error`, role: 'tool', text: `Turn failed: ${row.error?.message ?? row.error ?? 'The app server reported an error.'}` })
    return normalized
  })
}
function reasoningSummary(item: any): string {
  const summary = item?.summary ?? item?.summaryText ?? item?.summary_text
  return Array.isArray(summary) ? summary.filter((part) => typeof part === 'string').join('\n\n') : typeof summary === 'string' ? summary : ''
}
function usageFromHistory(turn: any): TokenUsage | undefined {
  const usage = turn?.tokenUsage?.last ?? turn?.tokenUsage ?? turn?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const keys: Array<keyof TokenUsage> = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
  const normalized: TokenUsage = {}
  keys.forEach((key) => { if (typeof usage[key] === 'number') normalized[key] = usage[key] })
  return Object.keys(normalized).length ? normalized : undefined
}
function normalizeThreadDetails(data: any): Record<string, TurnDetail> {
  const turns = data?.thread?.turns ?? data?.turns ?? []
  if (!Array.isArray(turns)) return {}
  const details = Object.fromEntries(turns.flatMap((turn: any, index: number) => {
    const turnId = String(turn.id ?? turn.turnId ?? turn.turn_id ?? '')
    if (!turnId) return []
    const detail: TurnDetail = {}
    const usage = usageFromHistory(turn)
    if (usage) detail.usage = usage
    const contextWindowTokens = turn.tokenUsage?.modelContextWindow ?? turn.modelContextWindow ?? turn.contextWindowTokens
    if (typeof contextWindowTokens === 'number') detail.contextWindowTokens = contextWindowTokens
    const items = turn.items ?? []
    if (Array.isArray(items)) {
      const parts: Record<string, string> = {}
      const activity: TurnActivity[] = []
      items.forEach((item: any, itemIndex: number) => {
        const itemType = String(item.type ?? '')
        const summary = reasoningSummary(item)
        if (/reasoning/i.test(itemType) && summary) parts[String(item.id ?? itemIndex)] = summary
        const label = activityLabel(item)
        if (label) activity.push({ id: String(item.id ?? `${index}-${itemIndex}`), label, status: activityStatus(item), item })
      })
      if (Object.keys(parts).length) detail.reasoningParts = parts
      if (activity.length) detail.activity = activity
    }
    return [[turnId, detail] as const]
  }))
  const storedUsage = data?.beejaUsage?.turns
  if (Array.isArray(storedUsage)) storedUsage.forEach((turn: any) => {
    const turnId = String(turn.turnId ?? '')
    if (!turnId) return
    details[turnId] = {
      ...details[turnId],
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.lastCall ? { lastCall: turn.lastCall } : {}),
      ...(typeof turn.usageSource === 'string' ? { usageSource: turn.usageSource } : {}),
      ...(turn.total ? { totalUsage: turn.total } : {}),
      ...(typeof turn.contextWindowTokens === 'number' ? { contextWindowTokens: turn.contextWindowTokens } : {}),
      ...(Array.isArray(turn.calls) ? { calls: turn.calls } : {}),
    }
  })
  return details
}
function activityLabel(item: any): string | undefined {
  const type = String(item?.type ?? '')
  if (/commandExecution/i.test(type)) {
    const command = item.command ?? item.commandLine ?? item.command_line
    return command ? `Command: ${Array.isArray(command) ? command.join(' ') : String(command)}` : 'Command execution'
  }
  if (/fileChange/i.test(type)) {
    const changes = item.changes ?? []
    const paths = Array.isArray(changes) ? changes.map((change: any) => change.path ?? change.filePath).filter(Boolean) : []
    return paths.length ? `File changes: ${paths.join(', ')}` : 'File changes'
  }
  if (/mcpToolCall/i.test(type)) return `Tool: ${item.toolName ?? item.tool_name ?? item.name ?? 'MCP call'}`
  if (/webSearch/i.test(type)) return 'Web search'
  if (/imageGeneration/i.test(type)) return 'Image generation'
  return undefined
}
function activityStatus(item: any): TurnActivity['status'] {
  const status = String(item?.status ?? '').toLowerCase()
  return status === 'failed' || status === 'error' || Boolean(item?.error) ? 'failed' : status === 'running' || status === 'inprogress' || status === 'in_progress' ? 'running' : 'completed'
}
function TurnInsights({ detail }: { detail?: TurnDetail }) {
  if (!detail) return null
  const reasoning = Object.entries(detail.reasoningParts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).filter(Boolean).join('\n\n')
  if (!reasoning && !detail.activity?.length) return null
  return <section className="turn-insights">
    {detail.activity?.length ? <ToolActivity items={detail.activity}/> : null}
    {reasoning ? <details className="turn-reasoning"><summary>Reasoning summary</summary><div>{reasoning}</div></details> : null}
  </section>
}
function catalogRecords(data: any, keys: string[]): any[] {
  const found: any[] = []
  const seenArrays = new Set<any>()
  const visit = (value: any, depth = 0) => {
    if (!value || depth > 7) return
    if (Array.isArray(value)) {
      if (seenArrays.has(value)) return
      seenArrays.add(value)
      value.forEach((item) => { if (item && typeof item === 'object' && (item.name || item.id || item.skill || item.plugin)) found.push(item); visit(item, depth + 1) })
      return
    }
    if (typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (keys.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())) && Array.isArray(child)) visit(child, depth + 1)
      else if (child && typeof child === 'object') visit(child, depth + 1)
    }
  }
  visit(data)
  const unique = new Map<string, any>()
  for (const entry of found) unique.set(String(entry.id ?? entry.name ?? entry.skill ?? entry.plugin), entry)
  return [...unique.values()]
}
function inlineMarkdown(source: string): React.ReactNode[] {
  const tokens = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|!?\[[^\]]+\]\([^)]+\))/g
  const result: React.ReactNode[] = []
  let cursor = 0
  for (const match of source.matchAll(tokens)) {
    const token = match[0], index = match.index ?? 0
    if (index > cursor) result.push(source.slice(cursor, index))
    if (token.startsWith('`')) result.push(<code key={index}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) result.push(<strong key={index}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('~~')) result.push(<del key={index}>{token.slice(2, -2)}</del>)
    else if (token.startsWith('*') || token.startsWith('_')) result.push(<em key={index}>{token.slice(1, -1)}</em>)
    else {
      const link = token.match(/^(!?)\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        const [, image, label, rawUrl] = link
        let url: URL | undefined
        try { url = new URL(rawUrl, window.location.href) } catch { /* Invalid Markdown URL. */ }
        if (image) result.push(label)
        else if (url && ['http:', 'https:', 'mailto:'].includes(url.protocol)) result.push(<a key={index} href={url.href} target="_blank" rel="noreferrer">{label}</a>)
        else result.push(label)
      } else result.push(token)
    }
    cursor = index + token.length
  }
  if (cursor < source.length) result.push(source.slice(cursor))
  return result
}
function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = line.match(/^\s*```([^`]*)$/)
    if (fence) {
      const code: string[] = []; i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      blocks.push(<pre key={`f${i}`}><code>{code.join('\n')}</code></pre>); continue
    }
    const tableSeparator = lines[i + 1]?.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
    if (line.includes('|') && tableSeparator?.length && tableSeparator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'))
      const headers = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i++])); }
      blocks.push(<div className="markdown-table-wrap" key={`t${i}`}><table><thead><tr>{headers.map((cell, index) => <th key={index}>{inlineMarkdown(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] ?? '')}</td>)}</tr>)}</tbody></table></div>); continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) { const level = heading[1].length; blocks.push(React.createElement(`h${level}`, { key: `h${i++}` }, inlineMarkdown(heading[2]))); continue }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { blocks.push(<hr key={`r${i++}`}/>); continue }
    const list = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/)
    if (list) {
      const ordered = /^\s*\d/.test(line), items: string[] = []
      while (i < lines.length) { const item = lines[i].match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/); if (!item || /^\s*\d/.test(lines[i]) !== ordered) break; items.push(item[2]); i++ }
      const Tag = ordered ? 'ol' : 'ul'
      blocks.push(<Tag key={`l${i}`}>{items.map((item, index) => <li key={index}>{inlineMarkdown(item)}</li>)}</Tag>); continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={`q${i}`}>{quote.map((part, index) => <p key={index}>{inlineMarkdown(part)}</p>)}</blockquote>); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*(?:[-*+]|\d+[.)])\s+)/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push(<p key={`p${i}`}>{paragraph.map((part, index) => <React.Fragment key={index}>{index > 0 && <br/>}{inlineMarkdown(part)}</React.Fragment>)}</p>)
  }
  return <div className="markdown-body">{blocks}</div>
}

export default function App() {
  const [status, setStatus] = useState<Status>({})
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeId, setActiveId] = useState(() => localStorage.getItem('beeja.activeThread') || '')
  const [messages, setMessages] = useState<Message[]>([])
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const [turnDetails, setTurnDetails] = useState<Record<string, TurnDetail>>({})
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'settings' | 'skills' | 'instructions'>('chat')
  const [provider, setProvider] = useState('ollama')
  const [baseUrl, setBaseUrl] = useState('https://ollama.com/v1')
  const [model, setModel] = useState('')
  const [providerModels, setProviderModels] = useState<ModelChoice[]>([])
  const [providerModelsLoading, setProviderModelsLoading] = useState(false)
  const [providerModelsError, setProviderModelsError] = useState('')
  const [providerModelsReload, setProviderModelsReload] = useState(0)
  const [manualModel, setManualModel] = useState(false)
  const [chatModel, setChatModel] = useState('')
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([])
  const [chatEffort, setChatEffort] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [chatSkills, setChatSkills] = useState<any[]>([])
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null)
  const [webSearchSaving, setWebSearchSaving] = useState(false)
  const [tavilyEndpointUrl, setTavilyEndpointUrl] = useState('https://api.tavily.com/search')
  const [tavilyApiKey, setTavilyApiKey] = useState('')
  const [tavilyConfigured, setTavilyConfigured] = useState(false)
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const providerInitialized = useRef(false)
  const [providerLoaded, setProviderLoaded] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectDraft, setProjectDraft] = useState('')
  const projectDraftInitialized = useRef(false)
  const [addingProject, setAddingProject] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [recentMenu, setRecentMenu] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [sidebar, setSidebar] = useState(true)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [catalog, setCatalog] = useState<any>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [catalogAction, setCatalogAction] = useState('')
  const [skillSelection, setSkillSelection] = useState(0)
  const [catalogNotice, setCatalogNotice] = useState('')
  const [instructionScope, setInstructionScope] = useState<'global' | 'project'>('global')
  const [instructionDoc, setInstructionDoc] = useState<InstructionDoc | null>(null)
  const [instructionDraft, setInstructionDraft] = useState('')
  const [instructionsLoading, setInstructionsLoading] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadSequence = useRef(0)
  const busyRef = useRef(false)
  const activeTurnThread = useRef<string | null>(null)
  const activeTurnByThread = useRef<Record<string, string>>({})
  const activeThreadIdRef = useRef(activeId)
  useEffect(() => { activeThreadIdRef.current = activeId }, [activeId])
  const statusText = status.appServer?.status ?? 'starting'
  const isReady = statusText === 'ready'
  const isConfigured = Boolean(status.config?.model && status.config?.baseUrl)

  const refresh = useCallback(async () => {
    try {
      const s = await request<Status>('/api/status')
      setStatus(s); setProjectPath(s.projectPath || '')
      if (!projectDraftInitialized.current) { setProjectDraft(s.projectPath || ''); projectDraftInitialized.current = true }
      try {
        const projectData = await request<any>('/api/projects')
        setProjects(Array.isArray(projectData.projects) ? projectData.projects : [])
      } catch { /* Older backend versions expose only the selected project. */ }
      if (s.appServer?.status === 'ready') {
        try {
          const t = await request<any>('/api/threads')
          const list: Thread[] = Array.isArray(t) ? t : t.data ?? t.threads ?? []
          setThreads(list)
        } catch (e) { setThreads([]); if (!String((e as Error).message).includes('Configure a provider')) setError((e as Error).message) }
      } else setThreads([])
    } catch (e) { setError((e as Error).message) }
    try {
      const p = await request<any>('/api/provider')
      const cfg = p?.config ?? p ?? {}
      if (!providerInitialized.current) {
        if (cfg.provider) setProvider(cfg.provider)
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl)
        if (cfg.model) { setModel(cfg.model); setChatModel((current) => current || cfg.model) }
        providerInitialized.current = true
        setProviderLoaded(true)
      }
    } catch (e) { setError((e as Error).message) }
  }, [])

  const loadThread = useCallback(async (id: string, expectedTurnId?: string, retry = false) => {
    const sequence = ++loadSequence.current
    if (!id) { setMessages([]); setTurnDetails({}); return }
    try {
      const data = await request<any>(`/api/threads/${encodeURIComponent(id)}/messages`)
      if (sequence !== loadSequence.current) return
      // thread/start and the first text deltas can arrive before the persisted history is materialized.
      if (busyRef.current && activeTurnThread.current === id) return
      const nextMessages = normalizeMessages(data)
      const nextDetails = normalizeThreadDetails(data)
      if (expectedTurnId) {
        const streamedAssistant = messagesRef.current.some((message) => message.turnId === expectedTurnId && message.role === 'assistant')
        const persistedAssistant = nextMessages.some((message) => message.turnId === expectedTurnId && message.role === 'assistant')
        const persistedTurn = (data?.thread?.turns ?? data?.turns ?? []).find((turn: any) => String(turn.id ?? turn.turnId ?? turn.turn_id ?? '') === expectedTurnId)
        const terminal = /completed|failed|interrupted|cancelled/i.test(String(persistedTurn?.status ?? ''))
        const persistedTurnContent = nextMessages.some((message) => message.turnId === expectedTurnId)
        if ((!persistedAssistant && streamedAssistant) || (!persistedAssistant && !terminal)) {
          setTurnDetails((current) => ({ ...current, ...nextDetails }))
          if (!retry) window.setTimeout(() => { if (activeThreadIdRef.current === id) void loadThread(id, expectedTurnId, true) }, 450)
          return
        }
        if (terminal && !persistedAssistant && !persistedTurnContent && !retry) {
          window.setTimeout(() => { if (activeThreadIdRef.current === id) void loadThread(id, expectedTurnId, true) }, 450)
          return
        }
      }
      setMessages(nextMessages); setTurnDetails(nextDetails)
    }
    catch (e) { setError((e as Error).message) }
  }, [activeId])
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 8000); return () => clearInterval(timer) }, [refresh])
  useEffect(() => { if (activeId) void loadThread(activeId) }, [activeId, loadThread])
  useEffect(() => {
    if (activeId) localStorage.setItem('beeja.activeThread', activeId)
    else localStorage.removeItem('beeja.activeThread')
  }, [activeId])
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true); setCatalogError(''); setCatalog(null)
    try { setCatalog(await request<any>('/api/skills')) }
    catch (e) { setCatalogError((e as Error).message) } finally { setCatalogLoading(false) }
  }, [])
  const loadInstructions = useCallback(async (scope: 'global' | 'project') => {
    setInstructionsLoading(true); setError(''); setInstructionDoc(null)
    try {
      const doc = await request<InstructionDoc>(`/api/instructions/${scope}`)
      setInstructionDoc(doc); setInstructionDraft(doc.content)
    } catch (e) { setError((e as Error).message) } finally { setInstructionsLoading(false) }
  }, [])
  useEffect(() => { if (view === 'skills') void loadCatalog() }, [view, loadCatalog])
  useEffect(() => {
    if (view !== 'settings' || !providerLoaded) return
    const controller = new AbortController()
    setProviderModels([]); setProviderModelsError(''); setManualModel(false)
    if (!baseUrl.trim()) { setProviderModelsLoading(false); return }
    setProviderModelsLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const result = await request<{ models: ModelChoice[] }>('/api/provider/models', {
          method: 'POST', signal: controller.signal,
          body: JSON.stringify({ provider, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
        })
        if (controller.signal.aborted) return
        setProviderModels(result.models)
        if (!result.models.length) setProviderModelsError('This endpoint returned no models. Try refreshing or enter a model ID manually.')
        else setModel((current) => result.models.some((choice) => choice.id === current) ? current : result.models[0].id)
      } catch (error) {
        if (!controller.signal.aborted) setProviderModelsError((error as Error).message)
      } finally { if (!controller.signal.aborted) setProviderModelsLoading(false) }
    }, 500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [view, providerLoaded, provider, baseUrl, apiKey, providerModelsReload])

  useEffect(() => {
    if (!isReady) return
    let cancelled = false
    setModelsLoading(true)
    request<{ models?: ModelChoice[] }>('/api/models').then((result) => {
      if (cancelled) return
      const next = Array.isArray(result.models) ? result.models.filter((entry) => typeof entry.id === 'string') : []
      setModelChoices(next)
      setChatModel((current) => next.some((choice) => choice.id === current) ? current : next.find((choice) => choice.id === status.config?.model)?.id || next[0]?.id || current || '')
    }).catch(() => { if (!cancelled) setModelChoices([]) }).finally(() => { if (!cancelled) setModelsLoading(false) })
    return () => { cancelled = true }
  }, [isReady, status.config?.provider, status.config?.baseUrl, status.config?.model])
  useEffect(() => {
    const choice = modelChoices.find((entry) => entry.id === chatModel)
    const declared = (choice?.supportedReasoningEfforts ?? []).map((item) => typeof item === 'string' ? item : item.reasoningEffort ?? item.effort ?? '').filter(Boolean)
    const available = choice?.supportedReasoningEfforts ? declared : modelChoices.length ? ['low', 'medium', 'high'] : []
    const preferred = choice?.defaultReasoningEffort ?? ''
    setChatEffort((current) => current && available.includes(current) ? current : available.includes(preferred) ? preferred : '')
  }, [chatModel, modelChoices])
  useEffect(() => {
    if (!isReady) return
    request<any>('/api/skills').then((result) => setChatSkills(catalogRecords(result, ['skills', 'items']))).catch(() => setChatSkills([]))
  }, [isReady, projectPath])
  const refreshSearchStatus = useCallback(async (threadId?: string) => {
    const result = await request<SearchStatus>(`/api/web-search${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`)
    setSearchStatus(result)
    setWebSearchEnabled(Boolean(result.enabled))
    setTavilyConfigured(Boolean(result.tavilyConfigured))
    setTavilyEndpointUrl(result.endpointUrl || 'https://api.tavily.com/search')
  }, [])
  useEffect(() => {
    if (!isReady) return
    void refreshSearchStatus(activeId).catch(() => setSearchStatus(null))
  }, [isReady, activeId, refreshSearchStatus])
  useEffect(() => { if (view === 'instructions') void loadInstructions(instructionScope) }, [view, instructionScope, loadInstructions])
  useEffect(() => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    let stopped = false
    let reconnectTimer: number | undefined
    let reconnectDelay = 500
    let socket: WebSocket | undefined
    const connect = () => {
      if (stopped) return
      socket = new WebSocket(`${scheme}://${location.host}/ws`)
      socket.onopen = () => { if (!stopped) { reconnectDelay = 500; setConnected(true) } }
      socket.onclose = () => {
        setConnected(false)
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, reconnectDelay)
          reconnectDelay = Math.min(reconnectDelay * 2, 8000)
        }
      }
      socket.onerror = () => { setConnected(false); socket?.close() }
      socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'status' && msg.status) {
          setStatus((current) => ({ ...current, appServer: { status: msg.status, ...(msg.error ? { error: msg.error } : {}) } }))
          if (msg.status === 'ready') void refresh()
          if (msg.status === 'unconfigured') setThreads([])
        }
        if (msg.type === 'approval') setApprovals((current) => current.some((a) => a.id === String(msg.id)) ? current : [...current, { id: String(msg.id), method: msg.method, params: msg.params }])
        if (msg.type === 'toolError' && (!msg.threadId || msg.threadId === activeId)) {
          const text = `${msg.tool || 'Tool'} failed: ${msg.error || 'Unknown error'}`
          setError(text)
          setMessages((current) => [...current, { id: `tool-error-${Date.now()}`, role: 'tool', text, turnId: msg.turnId }])
        }
        const threadId = msg.threadId ?? msg.params?.threadId ?? msg.params?.thread_id
        const turnId = String(msg.turnId ?? msg.params?.turnId ?? msg.params?.turn_id ?? msg.params?.turn?.id ?? activeTurnByThread.current[threadId] ?? '') || undefined
        if (msg.type === 'reasoningTrace' && threadId === activeId && turnId) {
          setTurnDetails((current) => {
            const existing = current[turnId] ?? {}
            const parts = { ...(existing.reasoningParts ?? {}) }
            const key = String(msg.itemId ?? msg.summaryIndex ?? 'summary')
            if (msg.phase === 'completed' && typeof msg.text === 'string') parts[key] = msg.text
            else if (typeof msg.delta === 'string') parts[key] = (parts[key] ?? '') + msg.delta
            return { ...current, [turnId]: { ...existing, reasoningParts: parts } }
          })
        }
        if (msg.type === 'tokenUsage' && threadId === activeId && turnId) {
          setTurnDetails((current) => ({ ...current, [turnId]: {
            ...(current[turnId] ?? {}),
            ...(msg.usage ? { usage: msg.usage } : {}),
            ...(msg.lastCall ? { lastCall: msg.lastCall } : {}),
            ...(msg.total ? { totalUsage: msg.total } : {}),
            ...(typeof msg.usageSource === 'string' ? { usageSource: msg.usageSource } : {}),
            ...(typeof msg.contextWindowTokens === 'number' ? { contextWindowTokens: msg.contextWindowTokens } : {}),
            ...(Array.isArray(msg.calls) ? { calls: msg.calls } : {}),
          } }))
        }
        if (threadId && threadId === activeId) {
          const delta = msg.params?.delta ?? msg.params?.textDelta ?? msg.params?.text_delta
          const method = msg.method ?? ''
          if (method === 'turn/started' && turnId) {
            activeTurnByThread.current[threadId] = turnId
            activeTurnThread.current = threadId
            setMessages((prev) => {
              const lastUser = [...prev].reverse().find((message) => message.role === 'user' && !message.turnId)
              return lastUser ? prev.map((message) => message.id === lastUser.id ? { ...message, turnId } : message) : prev
            })
          }
          if (typeof delta === 'string' && /^item\/agentMessage\/(delta|textDelta)$/i.test(method) && turnId) {
            setMessages((prev) => {
              const index = prev.findIndex((message) => message.role === 'assistant' && message.turnId === turnId)
              if (index >= 0) return prev.map((message, itemIndex) => itemIndex === index ? { ...message, text: message.text + delta } : message)
              return [...prev, { id: `live-${turnId}`, role: 'assistant', text: delta, turnId }]
            })
          }
          if ((method === 'item/started' || method === 'item/completed' || method === 'item/failed') && turnId) {
            const item = msg.params?.item
            const label = activityLabel(item)
            if (label) setTurnDetails((current) => {
              const existing = current[turnId] ?? {}
              const activity = [...(existing.activity ?? [])]
              const itemId = String(item?.id ?? `${method}-${activity.length}`)
              const index = activity.findIndex((entry) => entry.id === itemId)
              const status = method === 'item/failed' ? 'failed' as const : method === 'item/completed' ? activityStatus(item) : 'running' as const
              const next = { id: itemId, label, status, item }
              if (index >= 0) activity[index] = next; else activity.push(next)
              return { ...current, [turnId]: { ...existing, activity } }
            })
          }
          if (/^turn\/(completed|failed)$/.test(method)) {
            setBusy(false); busyRef.current = false; activeTurnThread.current = null
            void loadThread(activeId, turnId); void refresh()
          }
        }
        // Hidden raw reasoning deltas are never rendered as assistant text.
      } catch { /* Ignore malformed socket frames. */ }
      }
    }
    connect()
    return () => { stopped = true; if (reconnectTimer !== undefined) clearTimeout(reconnectTimer); socket?.close(); setConnected(false) }
  }, [activeId, loadThread, refresh])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, approvals])

  const newThread = async () => {
    setError('')
    setMessages([]); setTurnDetails({}); setDraft(''); setBusy(false); busyRef.current = false; activeTurnThread.current = null
    const selectedModel = status.config?.model ?? model
    setChatModel(selectedModel); setChatEffort('')
    try {
      const result = await request<any>('/api/threads', { method: 'POST', body: JSON.stringify({ model: selectedModel }) })
      const thread = result.thread ?? result
      const id = String(thread.id ?? thread.threadId ?? thread.thread_id ?? '')
      await refresh()
      if (id) { setActiveId(id); setView('chat') }
    } catch (e) { setError((e as Error).message) }
  }
  const send = async () => {
    let text = draft.trim()
    if (!text || !isReady || busy) return
    const pendingSkill = text.match(/^\/skill(?:\s+([^\s]+))?\s*$/)
    if (pendingSkill) { setError('Choose a skill from the /skill suggestions, then send your prompt.'); return }
    setError(''); setBusy(true); busyRef.current = true
    try {
      let threadId = activeId
      if (!threadId) {
        const result = await request<any>('/api/threads', { method: 'POST', body: JSON.stringify({ model: chatModel || status.config?.model || model }) })
        threadId = String(result.thread?.id ?? result.threadId ?? '')
        if (!threadId) throw new Error('Codex did not return a thread ID.')
        setActiveId(threadId)
        setView('chat')
        await refresh()
      }
      setDraft('')
      activeTurnThread.current = threadId
      const userMessageId = `user-${Date.now()}`
      setMessages((prev) => [...prev, { id: userMessageId, role: 'user', text }])
      const started = await request<any>(`/api/threads/${encodeURIComponent(threadId)}/turns`, { method: 'POST', body: JSON.stringify({ text, ...(chatModel ? { model: chatModel } : {}), ...(chatEffort ? { effort: chatEffort } : {}) }) })
      const turnId = String(started?.turn?.id ?? started?.turnId ?? '')
      if (turnId) {
        activeTurnByThread.current[threadId] = turnId
        setMessages((prev) => prev.map((message) => message.id === userMessageId ? { ...message, turnId } : message))
      }
    } catch (e) { setError((e as Error).message); setBusy(false); busyRef.current = false; activeTurnThread.current = null; setDraft(text) }
  }
  const toggleWebSearch = async () => {
    if (webSearchSaving) return
    setWebSearchSaving(true); setError('')
    try {
      const result = await request<any>('/api/web-search', { method: 'PUT', body: JSON.stringify({ enabled: !webSearchEnabled, endpointUrl: tavilyEndpointUrl }) })
      setWebSearchEnabled(Boolean(result.webSearch?.enabled ?? result.enabled))
      await refreshSearchStatus(activeId)
    } catch (e) { setError((e as Error).message) } finally { setWebSearchSaving(false) }
  }
  const saveWebSearch = async (event: React.FormEvent) => {
    event.preventDefault(); setWebSearchSaving(true); setError('')
    try {
      const result = await request<any>('/api/web-search', { method: 'PUT', body: JSON.stringify({ enabled: webSearchEnabled, endpointUrl: tavilyEndpointUrl, ...(tavilyApiKey ? { tavilyApiKey } : {}) }) })
      const config = result.webSearch ?? result
      setWebSearchEnabled(Boolean(config.enabled)); setTavilyConfigured(Boolean(config.tavilyConfigured)); setTavilyEndpointUrl(config.endpointUrl || tavilyEndpointUrl); setTavilyApiKey('')
      await refreshSearchStatus(activeId)
    } catch (e) { setError((e as Error).message) } finally { setWebSearchSaving(false) }
  }
  const stop = async () => {
    if (!activeId) return
    try { await request(`/api/threads/${encodeURIComponent(activeId)}/interrupt`, { method: 'POST', body: '{}' }) }
    catch (e) { setError((e as Error).message) }
    setBusy(false); busyRef.current = false
  }
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await request('/api/provider', { method: 'POST', body: JSON.stringify({ provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) }) })
      setChatModel(model); setApiKey(''); await refresh()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const saveProject = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const nextPath = projectDraft.trim()
      await request('/api/project', { method: 'POST', body: JSON.stringify({ projectPath: nextPath }) })
      if (nextPath !== projectPath) { setActiveId(''); setMessages([]) }
      setProjectPath(nextPath); setProjectDraft(nextPath); await refresh()
    }
    catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const selectProject = async (path: string) => {
    setSaving(true); setError('')
    try {
      await request('/api/project', { method: 'POST', body: JSON.stringify({ projectPath: path }) })
      setProjectPath(path); setProjectDraft(path); setActiveId(''); setMessages([]); setTurnDetails({})
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const chooseProjectFolder = async () => {
    setSaving(true); setError('')
    try {
      const result = await request<{ projectPath: string | null; cancelled: boolean }>('/api/projects/pick', { method: 'POST', body: '{}' })
      if (result.projectPath) await selectProject(result.projectPath)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const addProject = async (event: React.FormEvent) => {
    event.preventDefault(); if (!projectDraft.trim()) return
    setSaving(true); setError('')
    try {
      await request('/api/projects', { method: 'POST', body: JSON.stringify({ projectPath: projectDraft.trim() }) })
      await request('/api/project', { method: 'POST', body: JSON.stringify({ projectPath: projectDraft.trim() }) })
      setProjectPath(projectDraft.trim()); setAddingProject(false); setActiveId(''); setMessages([]); setTurnDetails({})
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const saveInstructions = async (event: React.FormEvent) => {
    event.preventDefault(); if (!instructionDoc) return
    setInstructionsSaving(true); setError('')
    try {
      const doc = await request<InstructionDoc>(`/api/instructions/${instructionScope}`, { method: 'PUT', body: JSON.stringify({ content: instructionDraft }) })
      setInstructionDoc(doc); setInstructionDraft(doc.content)
    } catch (e) { setError((e as Error).message) } finally { setInstructionsSaving(false) }
  }
  const updateSkill = async (item: any) => {
    const selector = typeof item.path === 'string' ? { path: item.path } : typeof item.name === 'string' ? { name: item.name } : null
    if (!selector || typeof item.enabled !== 'boolean') return
    const key = String(item.path ?? item.name)
    setCatalogAction(key); setCatalogError(''); setCatalogNotice('')
    try {
      await request('/api/skills/config', { method: 'PUT', body: JSON.stringify({ ...selector, enabled: !item.enabled }) })
      setCatalogNotice(`${item.name ?? 'Skill'} ${item.enabled ? 'disabled' : 'enabled'}.`)
      await loadCatalog()
      const skills = await request<any>('/api/skills')
      setChatSkills(catalogRecords(skills, ['skills', 'items']))
    } catch (e) { setCatalogError((e as Error).message) } finally { setCatalogAction('') }
  }
  const decideApproval = async (approval: Approval, decision: 'accept' | 'decline') => {
    try { await request(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: JSON.stringify({ decision }) }); setApprovals((list) => list.filter((a) => a.id !== approval.id)) }
    catch (e) { setError((e as Error).message) }
  }
  const activeThread = useMemo(() => threads.find((thread) => thread.id === activeId), [threads, activeId])
  const catalogEntries = catalogRecords(catalog, ['skills', 'items'])
  const skillCommand = draft.match(/^\/skill(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/)
  const skillPickerOpen = Boolean(skillCommand && skillCommand[2] === undefined)
  const skillQuery = (skillCommand?.[1] ?? '').toLowerCase()
  const chatSkillChoices = chatSkills.filter((item) => item.enabled !== false).filter((item) => {
    const name = String(item.name ?? item.id ?? item.skill ?? '')
    return !skillQuery || name.toLowerCase().includes(skillQuery) || String(item.description ?? '').toLowerCase().includes(skillQuery)
  }).slice(0, 8)
  const activeModelChoice = modelChoices.find((choice) => choice.id === chatModel)
  const toolSupportNote = activeModelChoice?.toolSupport === 'unsupported' ? 'Selected model reports no tool support' : activeModelChoice?.toolSupport !== 'supported' ? 'Selected model tool support is unverified' : ''
  const searchReadiness = !searchStatus?.enabled ? 'Search disabled' : !searchStatus.beeja.configured ? 'Native search unverified; configure Ollama Cloud or Tavily for a confirmed search tool' : activeId && searchStatus.beeja.threadReady !== true ? 'Search configured; start a new chat to attach it' : `Search available: ${searchStatus.beeja.sources.join(' + ')}`
  const declaredReasoningLevels = [...new Set((activeModelChoice?.supportedReasoningEfforts ?? []).map((item) => typeof item === 'string' ? item : item.reasoningEffort ?? item.effort ?? '').filter((item): item is string => Boolean(item)))].filter((item) => ['low', 'medium', 'high'].includes(item))
  const reasoningLevels = activeModelChoice?.supportedReasoningEfforts ? declaredReasoningLevels : modelChoices.length ? ['low', 'medium', 'high'] : []
  const chooseSkill = (item: any) => {
    const name = String(item.name ?? item.id ?? item.skill ?? '').trim()
    if (!name) return
    const remainder = skillCommand?.[2]?.trim() ?? ''
    setDraft(`$${name}${remainder ? ` ${remainder}` : ' '}`)
    setSkillSelection(0)
  }
  const renderCatalogEntry = (item: any, index: number) => {
    const name = String(item.name ?? item.id ?? item.skill ?? `Skill ${index + 1}`)
    const description = item.description ?? item.shortDescription ?? item.summary ?? item.details
    const skillCanToggle = typeof item.enabled === 'boolean' && (typeof item.path === 'string' || typeof item.name === 'string')
    const actionKey = String(item.path ?? item.name ?? name)
    return <article className="catalog-card" key={`${name}-${index}`}><div className="catalog-card-head"><div className="catalog-icon"><Code2 size={16}/></div><div className="catalog-title"><h2>{name}</h2>{typeof item.enabled === 'boolean' && <span className={`catalog-state ${item.enabled ? 'catalog-on' : ''}`}>{item.enabled ? 'Enabled' : 'Disabled'}</span>}</div></div>{description && <p>{stringify(description)}</p>}{item.source && <small>Source: {stringify(item.source)}</small>}<div className="catalog-actions">{skillCanToggle && <button className="button quiet" disabled={catalogAction === actionKey} onClick={() => void updateSkill(item)}>{catalogAction === actionKey ? <LoaderCircle size={13} className="spin"/> : null}{item.enabled ? 'Disable' : 'Enable'}</button>}</div></article>
  }

  const usageTurns = useMemo<UsageTurn[]>(() => {
    const turnIds = [...new Set(messages.map((message) => message.turnId).filter((id): id is string => Boolean(id)))]
    return turnIds.map((id) => turnDetails[id] ?? {})
  }, [messages, turnDetails])
  const latestUsageTurn = [...messages].reverse().find((message) => message.turnId)?.turnId
  const latestUsage = latestUsageTurn ? turnDetails[latestUsageTurn] : undefined

  return <div className="app-shell">
    {sidebar && <aside className={`sidebar ${mobileSidebar ? 'mobile-open' : ''}`}>
      <div className="brand-row"><div className="brand-mark">b</div><span className="brand-name">beeja</span><button className="icon-button sidebar-collapse" title="Collapse sidebar" onClick={() => setSidebar(false)}><PanelLeftClose size={17}/></button></div>
      <button className="new-chat" onClick={() => void newThread()}><Plus size={16}/> New chat <span className="shortcut">⌘ K</span></button>
      <div className="sidebar-scroll">
        <div className="side-label">Workspace</div>
        <button className={`nav-item ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}><MessageSquare size={16}/> Chats</button>
        <button className={`nav-item ${view === 'instructions' ? 'active' : ''}`} onClick={() => { setView('instructions'); setMobileSidebar(false) }}><FileText size={16}/> Instructions</button>
        <button className={`nav-item ${view === 'skills' ? 'active' : ''}`} onClick={() => { setCatalogNotice(''); setView('skills'); setMobileSidebar(false) }}><Code2 size={16}/> Skills</button>
        <div className="side-label thread-label">Recent chats <button title="Recent chat options" className="bare-icon" onClick={() => setRecentMenu(!recentMenu)}><MoreHorizontal size={16}/></button></div>
        {recentMenu && <div className="sidebar-menu"><button onClick={() => { setRecentMenu(false); void refresh() }}>Refresh chats</button><button onClick={() => { setRecentMenu(false); void newThread() }}>New chat</button></div>}
        <div className="thread-list">{threads.map((thread) => <button key={thread.id} className={`thread-item ${thread.id === activeId ? 'selected' : ''}`} title={thread.title ?? thread.name ?? thread.id} onClick={() => { setActiveId(thread.id); setView('chat'); setMobileSidebar(false) }}><MessageSquare size={14}/><span>{thread.title ?? thread.name ?? `Chat ${thread.id.slice(0, 8)}`}</span></button>)}</div>
        <section className="sidebar-projects"><div className="side-label projects-label">Projects</div>
          {projects.map((project) => <button key={project.path} className={`project-row ${project.path === projectPath ? 'selected' : ''}`} title={project.path} onClick={() => void selectProject(project.path)}><Folder size={14}/><span>{project.name || project.path.split('/').filter(Boolean).slice(-1)[0] || project.path}</span></button>)}
          {projectPath && !projects.some((project) => project.path === projectPath) && <button className="project-row selected" title={projectPath} onClick={() => void selectProject(projectPath)}><Folder size={14}/><span>{projectPath.split('/').filter(Boolean).slice(-1)[0] || projectPath}</span></button>}
          {!projects.length && !projectPath && <div className="project-empty">No project selected</div>}
          <button className="project-add" disabled={saving} onClick={() => void chooseProjectFolder()}><Folder size={14}/>{saving ? 'Opening folder…' : 'Choose folder…'}</button>
          <button className="project-add" onClick={() => { setView('settings'); setMobileSidebar(false); window.setTimeout(() => document.getElementById('git-connection-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0) }}><Globe size={14}/> Clone GitHub repository</button>
          {addingProject ? <form className="project-add-form" onSubmit={addProject}><input autoFocus autoComplete="off" value={projectDraft} onChange={(event) => setProjectDraft(event.target.value)} placeholder="/absolute/path/to/project" aria-label="Project directory"/><div><button type="button" onClick={() => setAddingProject(false)}>Cancel</button><button type="submit" disabled={saving || !projectDraft.trim()}>Add project</button></div></form> : <button className="project-add" onClick={() => { setAddingProject(true); setProjectDraft('') }}><Plus size={14}/> Add project by path</button>}
        </section>
      </div>
      <div className="sidebar-bottom"><button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => { setView('settings'); setMobileSidebar(false) }}><Settings2 size={16}/> Settings</button><div className="profile"><div className="avatar">A</div><div className="profile-copy"><strong>Local workspace</strong><small>{isReady ? 'App server ready' : statusText}</small></div><MoreHorizontal size={17}/></div></div>
    </aside>}
    <main className="main-panel">
      <header className="topbar"><div className="top-left">{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} title="Open sidebar"><PanelLeftClose size={17}/></button>}<button className="mobile-menu icon-button" aria-label="Open menu" onClick={() => setMobileSidebar(!mobileSidebar)}><Menu size={18}/></button><div className="breadcrumb">{view === 'chat' ? <><span>Chats</span><span className="crumb-slash">/</span><strong>{activeThread?.title ?? activeThread?.name ?? 'New chat'}</strong></> : <strong>{view[0].toUpperCase() + view.slice(1)}</strong>}</div></div><div className="top-right">{view === 'chat' && <button className={`workspace-toggle ${workspacePanelOpen ? 'active' : ''}`} onClick={() => setWorkspacePanelOpen((open) => !open)} title="Toggle project files and review" aria-label="Toggle project files and review"><FileText size={16}/></button>}<div className={`connection-pill ${connected ? 'online' : ''}`}><span className="connection-dot"/>{connected ? 'Connected' : 'Connecting'}</div><button className="help-button" title="Help" aria-label="Help" onClick={() => setHelpOpen(true)}><CircleHelp size={17}/></button></div></header>
      {helpOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false) }}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="help-close" onClick={() => setHelpOpen(false)} aria-label="Close help"><X size={16}/></button><div className="empty-icon"><CircleHelp size={19}/></div><h2 id="help-title">Using beeja.md</h2><p>Choose a project from the sidebar, then describe a task in the chat. Codex runs locally through the app server using the provider configured in Settings.</p><ul><li><kbd>Enter</kbd> sends a prompt</li><li><kbd>Shift</kbd> + <kbd>Enter</kbd> adds a new line</li><li>Use <strong>Add project</strong> to register another workspace folder</li></ul><button className="button quiet" onClick={() => setHelpOpen(false)}>Got it</button></section></div>}
      {error && <div className="error-toast" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
      {view === 'chat' ? <div className={`chat-workspace ${workspacePanelOpen ? 'panel-open' : ''}`}><div className={`chat-layout ${messages.length === 0 ? 'composer-centered' : ''}`}><div className="chat-scroll">
        {(!activeId || messages.length === 0) ? <div className="welcome"><div className="welcome-glyph"><Command size={25}/></div><h1>What are we building?</h1><p>A local coding agent, connected to your project.</p>{!isConfigured && <button className="setup-callout" onClick={() => setView('settings')}><KeyRound size={16}/><span><strong>Connect a model provider</strong><small>Set up Ollama, DeepSeek, or a compatible endpoint</small></span><ArrowUp size={15}/></button>}</div> : <div className="message-stack">{messages.map((message, messageIndex) => {
          const detail = message.turnId ? turnDetails[message.turnId] : undefined
          const assistantExists = message.turnId && messages.some((candidate) => candidate.turnId === message.turnId && candidate.role === 'assistant')
          const lastAssistantInTurn = message.role === 'assistant' && !messages.slice(messageIndex + 1).some((candidate) => candidate.turnId === message.turnId && candidate.role === 'assistant')
          const showInsights = Boolean(detail && (lastAssistantInTurn || (!assistantExists && message.role === 'user')))
          return <article key={message.id} className={`message ${message.role}`}><div className="message-avatar">{message.role === 'user' ? 'A' : message.role === 'tool' ? <Terminal size={14}/> : <span className="mini-mark">b</span>}</div><div className="message-body"><div className="message-head">{message.role === 'user' ? 'You' : message.role === 'tool' ? 'Activity' : 'Beeja'}{message.time && <time>{message.time}</time>}</div><div className="message-text">{message.role === 'assistant' ? <Markdown source={message.text}/> : message.text}</div>{showInsights && <TurnInsights detail={detail}/>}</div></article>
        })}{busy && !messages[messages.length - 1]?.text.endsWith(' ') && <div className="thinking"><LoaderCircle size={15} className="spin"/> Working on it…</div>}
          {approvals.map((approval) => <div className="approval-card" key={approval.id}><div className="approval-title"><ShieldCheck size={17}/><strong>Approval needed</strong></div><p>{approval.method.replace(/[/.]/g, ' ')}{approval.params?.command ? `: ${stringify(approval.params.command)}` : ''}</p><pre>{stringify(approval.params)}</pre><div className="approval-actions"><button className="button quiet" onClick={() => void decideApproval(approval, 'decline')}>Decline</button><button className="button primary" onClick={() => void decideApproval(approval, 'accept')}><Check size={14}/> Approve</button></div></div>)}<div ref={bottomRef}/></div>}
      </div>
      <div className="composer-wrap"><div className="composer">
        {skillPickerOpen && <div className="skill-picker" role="listbox" aria-label="Available skills">{chatSkillChoices.length ? chatSkillChoices.map((item, index) => <button key={String(item.path ?? item.name ?? item.id ?? index)} role="option" aria-selected={index === skillSelection} className={index === skillSelection ? 'selected' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSkill(item)}><Code2 size={14}/><span><strong>{String(item.name ?? item.id ?? item.skill ?? 'Skill')}</strong><small>{String(item.description ?? 'Installed Codex skill')}</small></span></button>) : <div className="skill-picker-empty">{chatSkills.length ? 'No matching skills' : 'No installed skills found'}</div>}</div>}
        <textarea value={draft} onChange={(e) => { setDraft(e.target.value); setSkillSelection(0) }} onKeyDown={(e) => { if (skillPickerOpen && e.key === 'ArrowDown') { e.preventDefault(); setSkillSelection((index) => (index + 1) % Math.max(1, chatSkillChoices.length)); return } if (skillPickerOpen && e.key === 'ArrowUp') { e.preventDefault(); setSkillSelection((index) => (index - 1 + Math.max(1, chatSkillChoices.length)) % Math.max(1, chatSkillChoices.length)); return } if (skillPickerOpen && e.key === 'Escape') { e.preventDefault(); setDraft(''); return } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (skillPickerOpen && chatSkillChoices.length) chooseSkill(chatSkillChoices[Math.min(skillSelection, chatSkillChoices.length - 1)]); else void send() } }} placeholder={!isConfigured ? 'Configure a provider in Settings to start…' : !isReady ? 'Starting app server…' : 'Ask anything, or describe a task… Type /skill to choose a skill'} disabled={!isReady || !isConfigured} rows={1}/>
        <div className="composer-toolbar"><div className="composer-left"><span className="context-tag"><Folder size={13}/>{projectPath ? projectPath.split('/').filter(Boolean).slice(-1)[0] : 'No project'}</span><label className="control-tag" title="Model"><Radio size={12}/><select aria-label="Model" value={chatModel} onChange={(event) => setChatModel(event.target.value)} disabled={!isReady || modelsLoading || !modelChoices.length}><option value={chatModel}>{modelsLoading ? 'Loading models…' : (modelChoices.find((choice) => choice.id === chatModel)?.displayName ?? chatModel) || 'No model'}</option>{modelChoices.filter((choice) => choice.id !== chatModel).map((choice) => <option key={choice.id} value={choice.id}>{choice.displayName ?? choice.id}</option>)}</select></label>{reasoningLevels.length > 0 && <label className="control-tag effort-control" title="Reasoning effort"><span>Thinking</span><select aria-label="Reasoning effort" value={chatEffort} onChange={(event) => setChatEffort(event.target.value)}><option value="">Default</option>{reasoningLevels.map((level) => <option key={level} value={level}>{level[0].toUpperCase() + level.slice(1)}</option>)}</select></label>}<button className={`control-tag search-control ${searchStatus?.status === 'configured' && (!activeId || searchStatus.beeja.threadReady === true) ? 'enabled' : ''}`} type="button" aria-pressed={webSearchEnabled} title={searchReadiness} disabled={webSearchSaving || busy} onClick={() => void toggleWebSearch()}><Globe size={12}/><span>{searchStatus?.status === 'configured' && (!activeId || searchStatus.beeja.threadReady === true) ? 'Search ready' : webSearchEnabled ? 'Search setup' : 'Search off'}</span></button></div><div className="composer-right"><UsageIndicator latest={latestUsage} turns={usageTurns}/><span className="enter-hint">↵ to send</span>{busy ? <button className="send-button stop" onClick={() => void stop()} title="Stop"><Square size={13} fill="currentColor"/></button> : <button className="send-button" disabled={!draft.trim() || !isReady || !isConfigured} onClick={() => void send()} title="Send"><ArrowUp size={17}/></button>}</div></div>
      </div><div className="composer-footnote" title={searchReadiness}>{searchReadiness}{toolSupportNote ? ` · ${toolSupportNote}` : ''} · Beeja can make mistakes. Review important changes before applying them.</div></div></div>{workspacePanelOpen && <FilesReviewPanel projectPath={projectPath} threadId={activeId || undefined}/>}</div> :
      view === 'settings' ? <section className="settings-page"><div className="page-heading"><span className="eyebrow">PREFERENCES</span><h1>Settings</h1><p>Configure the local agent and workspace it can access.</p></div><form className="settings-card" onSubmit={saveProvider}><div className="card-heading"><div><h2>Model provider</h2><p>Connect a Responses or OpenAI compatible Chat Completions endpoint.</p></div><span className={`status-badge ${isReady ? 'good' : ''}`}><span className="connection-dot"/>{isReady ? 'Agent ready' : statusText}</span></div><div className="form-grid"><label>Provider<select value={provider} onChange={(e) => { const value = e.target.value; setProvider(value); setModel(''); if (value === 'ollama') setBaseUrl('https://ollama.com/v1'); if (value === 'deepseek') setBaseUrl('https://api.deepseek.com'); if (value === 'openai') setBaseUrl('https://api.openai.com/v1'); if (value === 'groq') setBaseUrl('https://api.groq.com/openai/v1') }}><option value="ollama">Ollama Cloud</option><option value="deepseek">DeepSeek</option><option value="groq">Groq</option><option value="openai">OpenAI compatible</option><option value="custom">Custom endpoint</option></select></label><label>Model{manualModel ? <input autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model ID" required/> : <select aria-label="Provider model" value={model} onChange={(e) => setModel(e.target.value)} disabled={providerModelsLoading || !providerModels.length} required>{!providerModels.some((choice) => choice.id === model) && <option value={model}>{providerModelsLoading ? 'Loading models…' : model || 'Select a model'}</option>}{providerModels.map((choice) => <option key={choice.id} value={choice.id}>{choice.displayName && choice.displayName !== choice.id ? `${choice.displayName} (${choice.id})` : choice.id}</option>)}</select>}<small role="status">{providerModelsLoading ? 'Fetching models from your endpoint…' : providerModelsError || (providerModels.length ? `${providerModels.length} models available` : 'Enter an endpoint URL to load models.')}</small><span className="model-discovery-actions"><button className="button quiet" type="button" disabled={providerModelsLoading || !baseUrl.trim()} onClick={() => setProviderModelsReload((value) => value + 1)}>Refresh models</button>{providerModelsError && <button className="button quiet" type="button" onClick={() => setManualModel((value) => !value)}>{manualModel ? 'Use dropdown' : 'Enter model ID manually'}</button>}</span></label><label className="span-two">Base URL<input autoComplete="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" required/><small>Enter a base URL or a full <code>/responses</code> or <code>/chat/completions</code> URL. Beeja detects the API format. Use <code>https://ollama.com/v1</code> for Ollama Cloud.</small></label><label className="span-two">API key <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Leave blank to keep the saved key" autoComplete="new-password"/><small>Stored locally by Beeja. Ollama Cloud requires an API key; local Ollama can run without one.</small></label></div><div className="provider-note"><CircleHelp size={15}/><span>Beeja supports Responses and OpenAI compatible Chat Completions. The compatibility adapter limits some Codex features, including web search. Agent ready means Codex started; it does not verify a model request.</span></div>{status.appServer?.error && <div className="inline-error">{status.appServer.error}</div>}<div className="card-footer"><span className="save-note">Saving restarts the local app server.</span><button className="button primary" disabled={saving || providerModelsLoading || (!manualModel && !providerModels.some((choice) => choice.id === model)) || !model.trim() || !baseUrl.trim()}>{saving && <LoaderCircle size={15} className="spin"/>} Save provider</button></div></form><form className="settings-card" onSubmit={saveWebSearch}><div className="card-heading"><div><h2>Web search</h2><p>Codex native search, Ollama Cloud search for an Ollama Cloud model endpoint, and an optional Tavily-compatible endpoint.</p></div><span className={`status-badge ${webSearchEnabled ? 'good' : ''}`}><span className="connection-dot"/>{webSearchEnabled ? 'Enabled' : 'Disabled'}</span></div><label className="search-toggle-setting"><input type="checkbox" checked={webSearchEnabled} onChange={(event) => setWebSearchEnabled(event.target.checked)} disabled={webSearchSaving || busy}/><span>Enable web search</span></label><div className="form-grid search-settings-grid"><label className="span-two">Search endpoint<input autoComplete="url" value={tavilyEndpointUrl} onChange={(event) => setTavilyEndpointUrl(event.target.value)} placeholder="https://api.tavily.com/search"/><small>Must accept Tavily-compatible JSON search requests. The credential stays on the Beeja server.</small></label><label className="span-two">Tavily API key<input type="password" value={tavilyApiKey} onChange={(event) => setTavilyApiKey(event.target.value)} placeholder={tavilyConfigured ? 'Saved key is configured. Leave blank to keep it.' : 'tvly-…'} autoComplete="new-password"/></label></div><div className="card-footer"><span className="save-note">Changes restart Codex. Search tools apply to new chats.</span><button className="button primary" disabled={webSearchSaving || busy || !tavilyEndpointUrl.trim()}>{webSearchSaving && <LoaderCircle size={15} className="spin"/>} Save search settings</button></div></form><form className="settings-card project-card" onSubmit={saveProject}><div className="card-heading"><div><h2>Project directory</h2><p>Set the working directory for new agent sessions.</p></div><Folder size={18}/></div><label>Absolute path<input autoComplete="off" value={projectDraft} onChange={(e) => setProjectDraft(e.target.value)} placeholder="/path/to/project" required/><small>The backend process must have permission to access this directory.</small></label><div className="card-footer"><span className="save-note">Applies to newly created threads.</span><div className="project-actions"><button className="button quiet" type="button" disabled={saving} onClick={() => void chooseProjectFolder()}><Folder size={14}/>{saving ? 'Opening…' : 'Choose folder…'}</button><button className="button primary" disabled={saving || !projectDraft.trim()}>{saving && <LoaderCircle size={15} className="spin"/>} Save directory</button></div></div></form><GitConnectionPanel projectPath={projectPath} onProjectCloned={selectProject}/></section> :
      view === 'instructions' ? <section className="settings-page"><div className="page-heading"><span className="eyebrow">AGENT CONTEXT</span><h1>Instructions</h1><p>Edit the AGENTS.md instructions Beeja loads for this workspace.</p></div><div className="scope-tabs"><button className={instructionScope === 'global' ? 'selected' : ''} onClick={() => setInstructionScope('global')}>Global</button><button className={instructionScope === 'project' ? 'selected' : ''} onClick={() => setInstructionScope('project')}>Project</button></div>{instructionsLoading ? <div className="loading-card"><LoaderCircle className="spin" size={17}/> Loading instructions…</div> : instructionDoc && <form className="settings-card instructions-card" onSubmit={saveInstructions}><div className="instruction-meta"><div><h2>{instructionScope === 'global' ? 'Global instructions' : 'Project instructions'}</h2><p>{instructionDoc.exists ? 'File exists' : 'File does not exist yet'} · saves to this path</p></div><span className="instruction-file">AGENTS.md</span></div><div className="file-path" title={instructionDoc.path}><Folder size={13}/>{instructionDoc.path}</div><textarea className="instructions-editor" value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} spellCheck={false} placeholder={`Add ${instructionScope} instructions for the coding agent…`} aria-label={`${instructionScope} AGENTS.md contents`}/><div className="card-footer"><span className="save-note">Changes apply to new agent sessions.</span><button className="button primary" disabled={instructionsSaving || instructionDraft === instructionDoc.content}>{instructionsSaving && <LoaderCircle size={15} className="spin"/>} Save instructions</button></div></form>}</section>
      : <section className="settings-page empty-page"><div className="page-heading"><span className="eyebrow">LOCAL TOOLS</span><h1>Skills</h1><p>Manage skills exposed by the local app server.</p></div>{catalogNotice && <div className="catalog-notice"><Check size={14}/>{catalogNotice}</div>}{catalogError && <div className="catalog-error">{catalogError}</div>}<div className="catalog-note">You can enable or disable listed skills. Installing skill packages is not implemented here.</div>{catalogLoading ? <div className="loading-card"><LoaderCircle className="spin" size={17}/> Loading skills…</div> : catalogEntries.length ? <div className="catalog-grid">{catalogEntries.map(renderCatalogEntry)}</div> : !catalogError && <div className="empty-state-card"><div className="empty-icon"><Code2 size={20}/></div><h2>No skills returned</h2><p>The app server returned an empty skill catalog for the selected project.</p></div>}</section>}
    </main>{mobileSidebar && <button className="mobile-backdrop" aria-label="Close menu" onClick={() => setMobileSidebar(false)}/>}
  </div>
}
