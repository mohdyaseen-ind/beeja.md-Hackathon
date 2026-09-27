import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderOpen, GitBranch, LoaderCircle, RotateCw, Search, Sparkles, X } from 'lucide-react'
import './files-review.css'

type FileEntry = { name: string; path: string; isDirectory: boolean; isFile: boolean }
type ReviewFile = { path: string; status?: string; added?: number; deleted?: number; diff?: string }
type Branch = { name: string; sha?: string }
type Commit = { sha: string; subject: string }
type ReviewFilter = 'last-turn' | 'uncommitted' | 'unstaged' | 'staged' | 'committed' | 'branch'

const filters: { id: ReviewFilter; label: string }[] = [
  { id: 'last-turn', label: 'Last Turn' }, { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'unstaged', label: 'Unstaged' }, { id: 'staged', label: 'Staged' },
  { id: 'committed', label: 'Committed' }, { id: 'branch', label: 'Branch' },
]

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`)
  return payload as T
}

function relativeProjectPath(path: string, root: string) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedPath = path.replace(/\\/g, '/')
  if (normalizedPath === root || normalizedPath === normalizedRoot) return ''
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath.replace(/^\/+/, '')
}

function parentPath(path: string) {
  const trimmed = path.replace(/\/$/, '')
  return trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : ''
}

/** Project-root-confined file browser and Git review panel. Files are preview-only. */
export function FilesReviewPanel({ projectPath, threadId }: { projectPath: string; threadId?: string }) {
  const [section, setSection] = useState<'files' | 'review'>('files')
  const [root, setRoot] = useState(projectPath)
  const [currentPath, setCurrentPath] = useState(projectPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [filterText, setFilterText] = useState('')
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('last-turn')
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([])
  const [reviewDiff, setReviewDiff] = useState('')
  const [selectedReviewPath, setSelectedReviewPath] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [branches, setBranches] = useState<Branch[]>([])
  const [branch, setBranch] = useState('')
  const [commits, setCommits] = useState<Commit[]>([])
  const [commit, setCommit] = useState('')
  const [reviewNotice, setReviewNotice] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const fileRequestId = useRef(0)
  const previewRequestId = useRef(0)
  const reviewRequestId = useRef(0)

  const loadDirectory = useCallback(async (path: string, quiet = false) => {
    if (!projectPath) return
    const requestId = ++fileRequestId.current
    if (!quiet) { setFileLoading(true); setFileError('') }
    try {
      const result = await api<{ root: string; path: string; entries: FileEntry[] }>(`/api/files?path=${encodeURIComponent(path || projectPath)}`)
      if (typeof result.root !== 'string' || typeof result.path !== 'string' || !Array.isArray(result.entries)
        || !result.entries.every((entry) => entry && typeof entry.name === 'string' && typeof entry.path === 'string'
          && typeof entry.isDirectory === 'boolean' && typeof entry.isFile === 'boolean')) {
        throw new Error('The file list response is invalid. Restart the Beeja server and try again.')
      }
      if (requestId !== fileRequestId.current) return
      setRoot(result.root)
      setCurrentPath(relativeProjectPath(result.path, result.root))
      setEntries(result.entries.map((entry) => ({ ...entry, path: relativeProjectPath(entry.path, result.root) })))
      if (quiet) setFileError('')
    } catch (error) {
      if (requestId === fileRequestId.current) setFileError((error as Error).message)
    } finally { if (requestId === fileRequestId.current) setFileLoading(false) }
  }, [projectPath])

  useEffect(() => {
    previewRequestId.current++
    reviewRequestId.current++
    setRoot(projectPath); setCurrentPath(''); setEntries([]); setPreview(null); setPreviewLoading(false); setPreviewError(''); setFilterText(''); setFileError('')
    setReviewFiles([]); setReviewDiff(''); setReviewLoading(false); setReviewError('')
    setBranches([]); setBranch(''); setCommits([]); setCommit('')
    void loadDirectory('')
  }, [projectPath, loadDirectory])

  const loadPreview = useCallback(async (path: string, quiet = false) => {
    const requestId = ++previewRequestId.current
    if (!quiet) { setPreviewLoading(true); setPreviewError('') }
    try {
      const result = await api<{ path: string; content: string }>(`/api/files/content?path=${encodeURIComponent(path)}`)
      if (requestId !== previewRequestId.current) return
      const normalizedPath = relativeProjectPath(result.path, root)
      setPreview((current) => current?.path === normalizedPath && current.content === result.content ? current : { path: normalizedPath, content: result.content })
      setPreviewError('')
    } catch (error) { if (requestId === previewRequestId.current) setPreviewError((error as Error).message) }
    finally { if (requestId === previewRequestId.current) setPreviewLoading(false) }
  }, [root])

  const openFile = (entry: FileEntry) => {
    setPreview({ path: entry.path, content: '' })
    void loadPreview(entry.path)
  }

  const loadBranches = useCallback(async () => {
    try {
      const result = await api<{ current?: string; branches: Branch[] }>('/api/review/branches')
      setBranches(result.branches ?? [])
      if (result.current) setBranch((selected) => selected || result.current || '')
    } catch (error) { setReviewError((error as Error).message) }
  }, [])

  const loadReview = useCallback(async (filter: ReviewFilter, selectedBranch = branch, selectedCommit = commit, quiet = false) => {
    if (!projectPath) return
    const requestId = ++reviewRequestId.current
    if (filter === 'last-turn' && !threadId) { setReviewFiles([]); setReviewDiff(''); setReviewError(''); setReviewLoading(false); return }
    if (!quiet) { setReviewLoading(true); setReviewError(''); setReviewNotice('') }
    const params = new URLSearchParams({ filter })
    if (filter === 'last-turn' && threadId) params.set('threadId', threadId)
    if (filter === 'branch' && selectedBranch) params.set('branch', selectedBranch)
    if (filter === 'committed' && selectedCommit) params.set('commit', selectedCommit)
    try {
      const result = await api<{ files: ReviewFile[]; diff?: string }>(`/api/review?${params}`)
      if (!Array.isArray(result.files)) throw new Error('The review response is invalid. Restart the Beeja server and try again.')
      if (requestId !== reviewRequestId.current) return
      setReviewFiles(result.files); setReviewDiff(result.diff ?? '')
      setSelectedReviewPath((selected) => result.files.some((file) => file.path === selected) ? selected : result.files[0]?.path ?? '')
    } catch (error) { if (requestId === reviewRequestId.current) { if (!quiet) { setReviewFiles([]); setReviewDiff('') }; setReviewError((error as Error).message) } }
    finally { if (requestId === reviewRequestId.current) setReviewLoading(false) }
  }, [projectPath, branch, commit, threadId])

  const refreshVisibleData = useCallback(() => {
    if (section === 'files') {
      void loadDirectory(currentPath, true)
      if (preview?.path) void loadPreview(preview.path, true)
    } else {
      void loadReview(reviewFilter, branch, commit, true)
    }
  }, [section, currentPath, preview?.path, loadDirectory, loadPreview, loadReview, reviewFilter, branch, commit])

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let reconnectTimer = 0
    let retryDelay = 500

    const connect = () => {
      if (stopped) return
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${scheme}://${window.location.host}/ws`)
      socket.onopen = () => { retryDelay = 500 }
      socket.onmessage = (event) => {
        let message: any
        try { message = JSON.parse(event.data) } catch { return }
        if (message.type === 'projectFilesChanged') {
          if (message.projectPath && message.projectPath !== projectPath) return
          const paths = Array.isArray(message.paths) ? message.paths.map((path: unknown) => typeof path === 'string' ? relativeProjectPath(path, root) : '').filter(Boolean) : []
          const matchesPreview = !paths.length || !preview?.path || paths.includes(preview.path)
          if (section === 'files') {
            void loadDirectory(currentPath, true)
            if (preview?.path && matchesPreview) void loadPreview(preview.path, true)
          } else if (reviewFilter !== 'last-turn' || !message.threadId || !threadId || message.threadId === threadId) {
            void loadReview(reviewFilter, branch, commit, true)
          }
          return
        }
        const method = String(message.method ?? '')
        const eventThreadId = message.params?.threadId ?? message.params?.thread_id
        if (threadId && eventThreadId === threadId && /fileChange|turn\/(completed|failed)/i.test(method)) refreshVisibleData()
      }
      socket.onclose = () => {
        if (stopped) return
        reconnectTimer = window.setTimeout(connect, retryDelay)
        retryDelay = Math.min(retryDelay * 2, 10_000)
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => {
      stopped = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [projectPath, root, section, currentPath, preview?.path, threadId, reviewFilter, branch, commit, loadDirectory, loadPreview, loadReview, refreshVisibleData])

  // WebSocket notifications keep the panel live; polling recovers missed OS events and reconnect gaps.
  useEffect(() => {
    const interval = window.setInterval(refreshVisibleData, 6000)
    return () => window.clearInterval(interval)
  }, [refreshVisibleData])

  useEffect(() => {
    if (section !== 'review') return
    if (reviewFilter === 'branch' && !branches.length) void loadBranches()
    if (reviewFilter === 'committed' && !commits.length && branch) {
      void api<{ commits: Commit[] }>(`/api/review/commits?branch=${encodeURIComponent(branch)}`).then((result) => {
        setCommits(result.commits ?? [])
        if (result.commits?.[0]) setCommit((selected) => selected || result.commits[0].sha)
      }).catch((error) => setReviewError((error as Error).message))
    }
    void loadReview(reviewFilter)
  }, [section, reviewFilter, loadBranches, loadReview, branches.length, commits.length, branch])

  useEffect(() => {
    if (reviewFilter === 'branch' || reviewFilter === 'committed') void loadReview(reviewFilter)
  }, [branch, commit, reviewFilter, loadReview])

  const filteredEntries = useMemo(() => entries.filter((entry) => entry.name.toLowerCase().includes(filterText.toLowerCase())), [entries, filterText])
  const crumbs = useMemo(() => currentPath ? currentPath.split('/').filter(Boolean) : [], [currentPath])

  const startReview = async () => {
    if (!threadId) { setReviewError('Open a chat before starting a Codex review.'); return }
    setReviewing(true); setReviewError(''); setReviewNotice('')
    try {
      await api('/api/review/start', { method: 'POST', body: JSON.stringify({ threadId, filter: reviewFilter, ...(reviewFilter === 'branch' ? { branch } : {}), ...(reviewFilter === 'committed' ? { commit } : {}) }) })
      setReviewNotice('Codex review started in this chat.')
    } catch (error) { setReviewError((error as Error).message) }
    finally { setReviewing(false) }
  }

  const selectedFileDiff = reviewFiles.find((file) => file.path === selectedReviewPath)?.diff
  const shownDiff = selectedFileDiff || reviewDiff
  const codexReviewSupported = reviewFilter === 'uncommitted' || reviewFilter === 'committed' || reviewFilter === 'branch'
  return <section className="workspace-panel" aria-label="Project files and review">
    <div className="workspace-panel-tabs" role="tablist" aria-label="Project tools">
      <button role="tab" aria-selected={section === 'files'} className={section === 'files' ? 'active' : ''} onClick={() => setSection('files')}><Folder size={14}/> Files</button>
      <button role="tab" aria-selected={section === 'review'} className={section === 'review' ? 'active' : ''} onClick={() => setSection('review')}><GitBranch size={14}/> Review</button>
    </div>
    {section === 'files' ? <div className="workspace-panel-content">
      <div className="file-browser-head">
        <div className="file-browser-title"><strong>Project files</strong><button className="workspace-icon-button" onClick={() => void loadDirectory(currentPath)} aria-label="Refresh files"><RotateCw size={14}/></button></div>
        <div className="file-path" title={currentPath ? `${root}/${currentPath}` : root}><FolderOpen size={13}/><button onClick={() => void loadDirectory('')}>{projectPath.split(/[\\/]/).filter(Boolean).pop() || root}</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><ChevronRight size={12}/><button onClick={() => void loadDirectory(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button></span>)}</div>
        <label className="file-filter"><Search size={14}/><input aria-label="Filter project files" value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder="Filter files…"/>{filterText && <button onClick={() => setFilterText('')} aria-label="Clear file filter"><X size={13}/></button>}</label>
      </div>
      {fileError && <div className="workspace-error" role="alert">{fileError}<button onClick={() => void loadDirectory(currentPath)}>Retry</button></div>}
      <div className="file-browser-list" aria-label="Files in current folder" aria-busy={fileLoading}>
        {fileLoading ? <div className="workspace-loading"><LoaderCircle className="workspace-spin" size={15}/> Loading files…</div> : filteredEntries.length ? filteredEntries.map((entry) => <button key={entry.path} className="file-browser-entry" onClick={() => entry.isDirectory ? void loadDirectory(entry.path) : void openFile(entry)} aria-label={`${entry.isDirectory ? 'Open folder' : 'Preview file'} ${entry.name}`}><span className="file-entry-icon">{entry.isDirectory ? <Folder size={15}/> : <FileCode2 size={15}/>}</span><span>{entry.name}</span>{entry.isDirectory && <ChevronRight className="file-entry-chevron" size={13}/>}</button>) : <div className="workspace-empty">{filterText ? 'No matching files.' : 'This folder is empty.'}</div>}
      </div>
      {currentPath && <button className="file-parent-button" onClick={() => void loadDirectory(parentPath(currentPath))}><ChevronDown size={13}/> Parent folder</button>}
      {preview && <div className="file-preview" aria-label="File preview">
        <header><span><File size={14}/><strong title={preview.path}>{preview.path}</strong></span><button className="workspace-icon-button" onClick={() => { previewRequestId.current++; setPreviewLoading(false); setPreview(null); setPreviewError('') }} aria-label="Close file preview"><X size={15}/></button></header>
        {previewError ? <div className="workspace-error" role="alert">{previewError}</div> : previewLoading ? <div className="workspace-loading"><LoaderCircle className="workspace-spin" size={15}/> Loading preview…</div> : <pre><code>{preview.content}</code></pre>}
      </div>}
    </div> : <div className="workspace-panel-content review-content">
      <div className="review-head"><div><strong>Changes</strong><button className="workspace-icon-button" onClick={() => void loadReview(reviewFilter)} aria-label="Refresh changes"><RotateCw size={14}/></button></div><button className="review-run-button" disabled={reviewing || !threadId || !codexReviewSupported} onClick={() => void startReview()} title={!threadId ? 'Open a chat to start a Codex review' : codexReviewSupported ? 'Ask Codex to review these changes' : 'Codex review supports uncommitted changes, commits, and branches'}><Sparkles size={13}/>{reviewing ? 'Starting…' : 'Review with Codex'}</button></div>
      <div className="review-filter-row"><label htmlFor="review-filter">Compare</label><select id="review-filter" value={reviewFilter} onChange={(event) => { setReviewFilter(event.target.value as ReviewFilter); setReviewFiles([]); setReviewDiff('') }}>{filters.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
      {reviewFilter === 'branch' && <div className="review-filter-row"><label htmlFor="review-branch">Branch</label><select id="review-branch" value={branch} onChange={(event) => setBranch(event.target.value)}><option value="">Select branch</option>{branches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></div>}
      {reviewFilter === 'committed' && <div className="review-filter-row"><label htmlFor="review-commit">Commit</label><select id="review-commit" value={commit} onChange={(event) => setCommit(event.target.value)}><option value="">Select commit</option>{commits.map((item) => <option key={item.sha} value={item.sha}>{item.sha.slice(0, 8)} · {item.subject}</option>)}</select></div>}
      {reviewError && <div className="workspace-error" role="alert">{reviewError}<button onClick={() => void loadReview(reviewFilter)}>Retry</button></div>}
      {reviewNotice && <div className="workspace-notice" role="status">{reviewNotice}</div>}
      <div className="review-files" aria-busy={reviewLoading} role="list" aria-label="Changed files">
        {reviewLoading ? <div className="workspace-loading"><LoaderCircle className="workspace-spin" size={15}/> Loading changes…</div> : reviewFiles.length ? reviewFiles.map((item) => <button key={item.path} role="listitem" className={`review-file${item.path === selectedReviewPath ? ' selected' : ''}`} onClick={() => setSelectedReviewPath(item.path)} aria-pressed={item.path === selectedReviewPath}><span className="file-entry-icon"><FileCode2 size={14}/></span><span className="review-file-name" title={item.path}>{item.path}</span><span className="review-counts"><b>+{item.added ?? 0}</b><i>−{item.deleted ?? 0}</i></span><span className="review-status" title={item.status}>{item.status || 'modified'}</span></button>) : !reviewError && <div className="workspace-empty">No files changed in this view.</div>}
      </div>
      {shownDiff && <div className="review-diff"><div className="review-diff-title">Diff preview</div><pre>{shownDiff}</pre></div>}
    </div>}
  </section>
}

export default FilesReviewPanel
