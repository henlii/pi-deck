# Pi Deck

[中文文档](./README.zh-CN.md)

Pi Deck is a unified Agent workspace built on top of [Pi](https://github.com/badlogic/pi-mono). It does not replace Pi: it reads your local Pi session files and uses Pi's runtime semantics to provide a browser workspace for session browsing, real-time chat, model configuration, skill management, and project file preview.

![上游 Pi Web 截图：展示 Pi 会话中的 Markdown、工具调用和项目导航；Pi Deck 当前暂使用该图片](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

The image is an upstream Pi Web screenshot, retained temporarily as a representative view; Pi Deck keeps the same Pi session format and runtime semantics.

## Upstream / 上游来源

Pi Deck is derived from [agegr/pi-web](https://github.com/agegr/pi-web), which is distributed under the MIT License. It is built around [badlogic/pi-mono](https://github.com/badlogic/pi-mono). The project preserves Pi session files and runtime semantics so existing Pi data remains the source of truth. Copyright and derivative-work notices for the upstream project are retained in [LICENSE](./LICENSE).

## Quick Start

**Run without installing:**

```bash
npx @henlii/pi-deck@latest
```

**Or install globally:**

```bash
npm install -g @henlii/pi-deck
pi-deck
```

Then open [http://localhost:30141](http://localhost:30141). The CLI will try to open the browser automatically after the server is ready.

**Options:**

```bash
pi-deck --port 8080              # custom port
pi-deck --hostname 127.0.0.1     # local access only
pi-deck -p 8080 -H 127.0.0.1     # combine options
pi-deck --no-open                # do not open the browser automatically

PORT=8080 pi-deck                # environment variable is also supported
PI_WEB_NO_OPEN=1 pi-deck         # compatibility variable for background services
```

## HTTP Proxy

Pi Deck reads the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables for server-side model and API requests.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @henlii/pi-deck@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @henlii/pi-deck@latest
```

## Features

- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, and skill switches from the web UI.

## Notes

- **Data directory**: Pi Web reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Git worktrees**: see [Worktrees in Pi Deck](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://localhost:30141](http://localhost:30141).

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession, exposes SSE, and serves bash output
    auth/           # OAuth and API key management
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, search support, upload, and watching
    file-index/     # project-wide file indexing and @-mention search
    git/            # Git diff and status for the active project
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    plugins/        # package plugin management
    sessions/       # session reads, rename, auto-naming, delete, context, state, deferred thinking, and HTML export
    skills/         # skill listing, search, install, update, check, and enable/disable
    worktrees/      # Git worktree listing, creation, and removal
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  api-types.ts       # shared API request and response types
  ansi.ts             # ANSI escape-sequence handling for terminal output
  bash-output.ts      # bash command output formatting and parsing
  custom-ui-terminal.ts # terminal adapter for custom UI output
  git-changes.ts      # Git diff/change collection
  git-status.ts       # Git status collection and normalization
  git-types.ts        # shared Git data types
  http-dispatcher.ts  # HTTP(S) proxy setup for server-side fetch
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  session-file-references.ts # session-linked file reference checks
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary and allowed roots
  file-fuzzy.ts       # fuzzy file search helpers
  file-upload.ts      # upload validation and conflict handling
  file-paths.ts       # path encoding and relative path helpers
  models-cache.ts     # cached model lists and defaults
  session-title.ts    # session title and auto-name helpers
  skill-updates.ts    # skill update operations
  skill-lock.ts       # skill update locking
  terminal-input.ts   # terminal input handling
  worktree.ts         # project/worktree resolution and Git operations
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useKeyboardShortcuts.ts # keyboard shortcut handling
  useTheme.ts         # theme switching
bin/
  pi-web.js           # npm CLI entrypoint
instrumentation.ts    # initializes the server HTTP dispatcher
```
