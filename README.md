# beeja.md

A local web controller for the open source Codex CLI harness. The browser sends prompts to a Node server, which owns a Codex `app-server` process. Codex performs the agent and tool loop.

## Run locally

Requirements: Node.js 22 or newer, npm, and a `codex` CLI on `PATH` (tested with 0.156.1). For local models, run Ollama with a model that supports tool calls and the OpenAI Responses API.

```sh
npm install
npm --prefix web install
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite web server proxies `/api` and `/ws` to the local Node server on port 3000. `npm run build` checks both TypeScript projects and creates the production frontend; `npm start` serves that build on `http://127.0.0.1:3000`.

On first launch, open Settings and enter a provider name, base URL, model ID, and token if the provider needs one. The form defaults to Ollama Cloud's `gemma4:31b` at `https://ollama.com/v1`, so inference runs remotely instead of loading model weights on your Mac. Create an Ollama API key for this endpoint. For local Ollama, use `http://127.0.0.1:11434/v1` instead. The base URL should be the API root, without `/responses`. Codex 0.156.1 requires an OpenAI Responses API compatible endpoint. DeepSeek's is `https://api.deepseek.com` with `deepseek-flash` or `deepseek-v4-pro`. Then select an absolute local project directory, create a chat, and send a prompt.

The server creates a separate Codex home in `~/.beeja-controller/codex-home`. It does not use or copy the desktop app's ChatGPT sign-in. Provider settings, including a token when supplied, are stored server-side in `~/.beeja-controller/provider.json` with owner-only permissions. The browser receives only a token-configured flag. Saved project directories are stored separately in `projects.json`; the selected directory is persisted in `project.json`. Set `BEEJA_DATA_DIR` to move that data, or `CODEX_BIN` to use a specific CLI binary. The app binds to loopback by default.

## Current controls

- Codex thread creation, prompt streaming, history, interruption, and command/file approval requests.
- Live Codex activity and exposed reasoning summaries in chat. Detailed per-turn token usage shows input, cached input, cache writes, output, reasoning output, and model context-window size when the provider reports them. Beeja labels usage derived from cumulative Codex totals and leaves unavailable counts blank rather than guessing.
- Multiple saved project directories, with the selected project persisted across refreshes. `GET /api/projects` lists the saved directories, `POST /api/projects` adds one, and `POST /api/project` selects a directory (and adds it to the list if it was not saved yet). Chat history is requested from Codex for the selected project.
- Clone a GitHub HTTPS repository from **Projects → Clone GitHub repository**. Beeja saves clones under `~/.beeja-controller/repositories/<owner>/<repo>`, adds them to Projects, and selects the clone. Settings shows Git, GitHub CLI authentication, DNS, and current remote/branch status. Private repositories use Git credentials already available on this Mac; the app does not implement a GitHub OAuth flow.
- Recent chat selection is restored after a browser refresh. Assistant messages format headings, lists, links, tables, inline code, and fenced code blocks.
- Discover models in chat, choose a model for each turn, and select the reasoning effort advertised by the model. Providers that omit reasoning metadata offer low, medium, and high choices.
- Browse project files and open read-only text previews. The file list, open preview, and review refresh on project changes while the panel is open, with a periodic refresh to recover missed notifications. Review last-turn, uncommitted, unstaged, staged, committed, and branch diffs in the side panel. Codex review actions are available for uncommitted changes, commits, and branches.
- Use `/skill` to search installed Codex skills in chat. Web search can use Codex native search, Ollama Cloud search when the active endpoint is Ollama Cloud, and an optional Tavily-compatible endpoint. Search credentials stay on the server; dynamic search tools apply to new chats.
- Sidebar project picker, recent-chat actions, mobile menu, and Help dialog.
- On macOS, **Choose folder…** opens the native folder selection dialog from the sidebar project picker or Settings. The local server returns the selected absolute path so Codex can use it as the working directory. On other platforms, enter the absolute path manually.
- Model provider settings.
- Global and project `AGENTS.md` editors. Start a new chat after changing instructions so Codex loads the new content.
- Skills listing and enable/disable; plugin listing, install, and uninstall through Codex app-server.

The browser does not implement a separate GitHub agent. Give a GitHub URL to Codex in the prompt or clone it as a project first. Codex's workspace-write sandbox has network access enabled so its terminal can fetch repositories; workspace write limits and on-request approvals still apply. Git commands use the local GitHub CLI credential helper when authentication is needed, without copying the token into Beeja settings. Pushing and creating PRs still require repository permissions. Beeja checks the local `gh` login in Settings, but automated push and PR creation have not been verified.

The web interface provides the chat, project file preview, and Git review controls. Terminal and worktree screens are not implemented.

## Implementation notes

- The backend speaks Codex app-server JSON-RPC over stdio and forwards events to the browser over a same-origin WebSocket.
- Reasoning shown in the browser is limited to the summaries Codex exposes. Internal reasoning content is filtered by the server. Per-turn usage metadata is saved under the isolated Codex home so it remains available after refresh.
- This CLI build defaults to paginated history but does not yet support full reads of it. beeja.md requests legacy history for new chats so they can reopen after a refresh.
- API tokens never go to browser storage. Protect the local machine account and the app's data directory, since the server can run Codex tools against selected workspaces.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced), [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/).
