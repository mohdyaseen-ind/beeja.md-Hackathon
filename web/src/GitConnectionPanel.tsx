import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, Check, ExternalLink, Github, LoaderCircle, RefreshCw } from 'lucide-react'
import './git-connection.css'

type GitStatus = {
  gitInstalled?: boolean
  ghInstalled?: boolean
  ghAuthenticated?: boolean
  githubReachable?: boolean
  githubError?: string
  projectPath?: string
  isRepository?: boolean
  remoteUrl?: string | null
  branch?: string | null
}

type Props = {
  projectPath?: string
  onProjectCloned: (projectPath: string) => void | Promise<void>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`)
  return payload as T
}

function safeGitHubUrl(value: string) {
  const input = value.trim()
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..')) return null
    return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, '')}.git`
  } catch { return null }
}

function Diagnostic({ label, value, detail }: { label: string; value: 'good' | 'bad' | 'neutral'; detail: string }) {
  return <div className={`git-diagnostic ${value}`}>
    <span className="git-diagnostic-icon" aria-hidden="true">{value === 'good' ? <Check size={13}/> : value === 'bad' ? <AlertCircle size={13}/> : <span className="git-diagnostic-dot"/>}</span>
    <span className="git-diagnostic-copy"><strong>{label}</strong><small>{detail}</small></span>
  </div>
}

export function GitConnectionPanel({ projectPath, onProjectCloned }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [cloneError, setCloneError] = useState('')
  const [notice, setNotice] = useState('')
  const [cloning, setCloning] = useState(false)
  const statusRequestId = useRef(0)

  const loadStatus = useCallback(async (quiet = false) => {
    const requestId = ++statusRequestId.current
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setStatusError('')
    try {
      const result = await request<GitStatus>('/api/git/status')
      if (requestId === statusRequestId.current) setStatus(result)
    } catch (error) { if (requestId === statusRequestId.current) setStatusError((error as Error).message) }
    finally { if (requestId === statusRequestId.current) { setLoading(false); setRefreshing(false) } }
  }, [])

  useEffect(() => { void loadStatus() }, [loadStatus, projectPath])

  const handleClone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCloneError(''); setNotice('')
    const url = safeGitHubUrl(repoUrl)
    if (!url) { setCloneError('Enter a GitHub repository URL such as https://github.com/owner/repository.'); return }
    setCloning(true)
    try {
      const result = await request<{ projectPath: string }>('/api/git/clone', { method: 'POST', body: JSON.stringify({ url }) })
      if (typeof result.projectPath !== 'string' || !result.projectPath) throw new Error('The clone response did not include a project folder.')
      setRepoUrl(''); setNotice(`Repository cloned to ${result.projectPath}`)
      await onProjectCloned(result.projectPath)
      await loadStatus(true)
    } catch (error) { setCloneError((error as Error).message) }
    finally { setCloning(false) }
  }

  const gitDetail = loading ? 'Checking Git installation…' : statusError ? 'Could not check Git status' : status?.gitInstalled ? 'Installed and available to Beeja' : 'Not found on this machine'
  const ghDetail = loading ? 'Checking GitHub CLI…' : statusError ? 'Could not check GitHub CLI' : status?.ghInstalled ? 'GitHub CLI is installed' : 'Optional; not installed'
  const authDetail = loading ? 'Checking saved credentials…' : statusError ? 'Could not check authentication' : status?.ghAuthenticated ? 'GitHub CLI reports an authenticated session' : status?.ghInstalled ? 'No GitHub CLI session detected; private repos may need credentials' : 'Not checked because GitHub CLI is unavailable'
  const reachabilityDetail = loading ? 'Checking connection…' : statusError ? 'Could not check GitHub connectivity' : status?.githubError || (status?.githubReachable ? 'GitHub DNS resolved from this machine' : 'GitHub DNS lookup failed')
  const ghAuth = Boolean(status?.ghInstalled && status.ghAuthenticated)

  return <section className="git-connection-panel" aria-labelledby="git-connection-title">
    <header className="git-connection-heading">
      <div className="git-connection-title-wrap"><span className="git-connection-mark"><Github size={17}/></span><div><h2 id="git-connection-title">GitHub repositories</h2><p>Connect a repository to use it as a Beeja project.</p></div></div>
      <button className="git-refresh-button" onClick={() => void loadStatus(true)} disabled={loading || refreshing} aria-label="Refresh GitHub diagnostics" title="Refresh diagnostics"><RefreshCw className={refreshing ? 'git-spin' : ''} size={14}/></button>
    </header>

    <div className="git-diagnostics" aria-label="GitHub access diagnostics" aria-busy={loading}>
      {statusError && <div className="git-status-error" role="alert"><AlertCircle size={14}/><span>{statusError}</span><button onClick={() => void loadStatus()}>Retry</button></div>}
      <Diagnostic label="Git" value={loading ? 'neutral' : status?.gitInstalled ? 'good' : 'bad'} detail={gitDetail}/>
      <Diagnostic label="GitHub CLI" value={loading ? 'neutral' : status?.ghInstalled ? 'good' : 'neutral'} detail={ghDetail}/>
      <Diagnostic label="GitHub authentication" value={loading || !status?.ghInstalled ? 'neutral' : status.ghAuthenticated ? 'good' : 'bad'} detail={authDetail}/>
      <Diagnostic label="GitHub connectivity" value={loading ? 'neutral' : status?.githubReachable ? 'good' : 'bad'} detail={reachabilityDetail}/>
    </div>

    {!loading && status && <div className="git-project-state" role="status">
      {status.isRepository ? <><Check size={14}/><span><strong>Current project is a Git repository</strong><small>{status.remoteUrl || 'No remote URL configured'}{status.branch ? ` · ${status.branch}` : ''}</small></span></> : <><AlertCircle size={14}/><span><strong>Current project is not a Git repository</strong><small>{status.projectPath || 'No project folder selected'}</small></span></>}
    </div>}

    <form className="git-clone-form" onSubmit={(event) => void handleClone(event)}>
      <label htmlFor="git-repository-url">Repository URL</label>
      <div className="git-url-input-wrap"><input id="git-repository-url" value={repoUrl} onChange={(event) => { setRepoUrl(event.target.value); setCloneError(''); setNotice('') }} placeholder="https://github.com/owner/repository" autoComplete="url" spellCheck={false}/><ExternalLink size={14} aria-hidden="true"/></div>
      <p className="git-clone-help">Enter a GitHub HTTPS repository URL. Beeja uses Git credentials available on this machine; it does not add a GitHub OAuth login.</p>
      {cloneError && <div className="git-form-error" role="alert"><AlertCircle size={14}/>{cloneError}</div>}
      {notice && <div className="git-form-notice" role="status"><Check size={14}/>{notice}</div>}
      {!ghAuth && status?.ghInstalled && <div className="git-auth-hint">For private repositories, sign in on this machine with <code>gh auth login</code> or configure Git credentials.</div>}
      <div className="git-form-footer"><span className="git-readonly-note">Clone creates a new local project folder.</span><button type="submit" disabled={cloning || loading || !status?.gitInstalled}><span>{cloning ? <LoaderCircle className="git-spin" size={14}/> : <Github size={14}/>}</span>{cloning ? 'Cloning…' : 'Clone repository'}</button></div>
    </form>
    {status?.githubError && !statusError && <div className="git-connectivity-error" role="note">{status.githubError}</div>}
  </section>
}

export default GitConnectionPanel
