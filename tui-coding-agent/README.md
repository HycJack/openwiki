# TUI Agent Refactor (tca)

A plugin-based TUI coding agent — an interactive AI assistant that runs in your terminal.

```
╭──────────────────────────────────────────────────────╮
│
┊  ── User ──────────────  12:00:00
┊  帮我看看这个项目结构
│
┊  ── AI ────────────────  12:00:01
┊  好，我用 ls 和 tree 来查看
┊  ⚡ bash - ls -la
│
╰─ ❯ /workspace/project ──────────────────────────────
> <input cursor>
● Ready  gpt-4o
```

## Features

- **Interactive TUI** — Chat-like interface with message folding, role banners, and session tree
- **LLM-powered** — Works with OpenAI-compatible APIs (streaming responses)
- **Built-in tools** — bash, read, write, edit, grep, glob, ls — the agent can do real work
- **Session management** — Conversations auto-save as JSONL files, supports branching and forking
- **Plugin system** — Extend with custom commands and tools
- **Input history** — `↑` / `↓` to browse previous inputs

## Quick Start

```bash
# 1. Setup
cp .env.example .env
# Edit .env with your OPENAI_API_KEY

# 2. Install
npm install

# 3. Run
npm run dev
```

Then start typing — the agent will respond, use tools, and execute commands.

## Usage

### Interactive Mode

```bash
npm run dev
```

### Single Prompt Mode

```bash
npm run dev -- --print "list all files in this project"
```

### Command-Line Options

| Flag | Description |
|------|-------------|
| `--model <provider:id>` | Set model (default: `openai:gpt-4o`) |
| `--base-url <url>` | Custom API base URL |
| `--print <prompt>` | Non-interactive mode: run once and exit |
| `--plugin <path>` | Load additional plugins |
| `--cwd <path>` | Working directory |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear screen |
| `/model [provider:id]` | Switch model |
| `/tokens` | Show token usage |
| `/ctx` | Context overview |
| `/ctx compact` | Trigger context compression |
| `/compact <notes>` | LLM-powered context compaction |
| `/sessions` | List all sessions |
| `/session <id>` | Switch to a session |
| `/session new` | Create new session |
| `/tree` | Show session tree |
| `/fork <entry-id>` | Fork a new branch from an entry |
| `/exit` | Exit |

### Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` | Abort streaming or exit |
| `Ctrl+O` | Toggle message folding |
| `↑` | Previous input history |
| `↓` | Next input history |
| `Esc` | Cancel current streaming turn |

## Sessions

All conversations are automatically saved as **JSONL files** in `~/.tca/sessions/<cwd-hash>/<session-id>.jsonl`.
Each message stores a `parentId` to form a tree — so you can branch, fork, and revisit any point in the conversation.

- `/sessions` — list all sessions
- `/session <id>` — switch to a previous session (full context restored)
- `/session new` — start fresh
- `/tree` — view the session tree as ASCII tree
- `/fork <entry-id>` — branch from a specific message

### Session Storage Format

```jsonl
{"type":"message","id":"abc123","parentId":null,"role":"user","content":[...],"timestamp":...}
{"type":"message","id":"abc124","parentId":"abc123","role":"assistant","content":[...],"timestamp":...}
{"type":"compaction","firstKeptEntryId":"abc125","summary":"...","compressedCount":5,"compressedTokens":4200,"timestamp":...}
```

## Configuration

### Environment Variables (`.env`)

`.env` is loaded from the current working directory or `~/.tca/.env` (in order of priority).

```env
# Required
OPENAI_API_KEY=sk-your-key-here

# Optional
OPENAI_MODEL=gpt-4o
OPENAI_BASE_URL=https://api.openai.com/v1
```

### Config File (`~/.tca/config.json`)

```json
{
  "defaultModel": "gpt-4o",
  "defaultProvider": "openai",
  "baseURL": "https://api.openai.com/v1",
  "autoSaveSession": true,
  "models": [
    {
      "id": "gpt-4o",
      "provider": "openai",
      "name": "GPT-4o",
      "apiKey": "sk-...",
      "baseURL": "https://api.openai.com/v1"
    },
    {
      "id": "deepseek-chat",
      "provider": "openai",
      "name": "DeepSeek V3",
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com/v1"
    }
  ],
  "plugins": [],
  "tools": [],
  "systemPrompt": "You are a helpful coding assistant..."
}
```

## Context Compaction

When the conversation approaches the context window limit, the agent automatically compresses earlier messages into an LLM-generated summary.

### Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `keepRecentTokens` | 20,000 | Keep the most recent N tokens as raw messages |
| `reserveTokens` | 16,384 | Reserved space for LLM replies (triggers compaction when total > window - reserve) |
| Context window | 128,000 | Per-model context window (defined by model) |

### How It Works

1. During `agentLoop`, after each turn, `autoCompactIfNeeded()` checks context usage
2. If usage exceeds `contextWindow - reserveTokens`, it calls `summarizeWithLLM()` with `buildCompactionPrompt()`
3. The LLM generates a structured summary (Goal, Constraints, Accomplished, Relevant Files, Key Findings, Next Steps)
4. Early messages are replaced with the summary, keeping recent ~20k tokens intact

### Manual Compaction

```bash
# Default (auto-generated summary)
/compact

# With custom instructions
/compact keep the file structure details

# Via context command
/ctx compact
```

## Compaction Prompt Structure

When compaction triggers, the LLM receives the following structured prompt:

```
### Goal
What was the overall goal of this part of the conversation?

### Constraints
Any constraints or requirements discovered.

### Accomplished
What was accomplished so far.

### Relevant Files
Files that were read, created, or modified.

### Key Findings
Important discoveries, bugs found, decisions made.

### Next Steps
What remains to be done.
```

## Plugin Development

插件可以扩展 Agent 的自定义工具和 `/xxx` 命令。

### 插件文件结构

插件是一个 `.ts` 或 `.js` 文件，默认导出工厂函数：

```typescript
// plugins/my-plugin.ts
import type { ExtensionAPI } from "tui-agent-refactor";

export default function (api: ExtensionAPI) {
  // 注册 /hello 命令
  api.registerCommand("hello", async (ctx, args) => {
    ctx.notify(`Hello, ${args || "World"}!`, "info");
  }, "Say hello");

  // 注册 LLM 工具
  api.registerTool({
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    execute: async (toolCallId, params) => ({
      content: [{ type: "text", text: `Processed: ${params.input}` }],
    }),
  });

  // 订阅 Agent 事件
  api.on("agent_end", (event, ctx) => {
    console.log(`[plugin] Agent finished. Messages: ${ctx.getMessageCount()}`);
  });
}
```

### 加载插件

```bash
# 通过 CLI
npm run dev -- --plugin ./plugins/my-plugin.ts

# 放到项目插件目录（自动发现）
mkdir .tca/plugins
cp my-plugin.ts .tca/plugins/

# 放到全局插件目录（自动发现）
mkdir -p ~/.tca/plugins
cp my-plugin.ts ~/.tca/plugins/
```

### ExtensionAPI 方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `api.on(event, handler)` | `event`: 事件名, `handler`: 处理函数 | 订阅 Agent 生命周期事件 |
| `api.registerTool(tool)` | `AgentTool` | 注册 LLM 可调用的工具 |
| `api.registerCommand(name, handler, description?)` | 命令名, 处理函数, 描述 | 注册 `/xxx` 命令 |
| `api.notify(message, type?)` | `type`: `"info"` / `"warning"` / `"error"` | 发送通知 |
| `api.exec(cmd, args, cwd?)` | Shell 命令 | 执行命令（30s 超时） |
| `api.getActiveTools()` | — | 获取已启用工具 |
| `api.setActiveTools(names)` | `string[]` | 启用/禁用工具 |
| `api.ui` | PluginUIContext | UI 操作（setStatus 等） |

### 可用事件

`api.on()` 可监听以下事件：
- `agent_start` / `agent_end` — Agent 会话开始/结束
- `turn_start` / `turn_end` — 每一轮 LLM 交互开始/结束
- `message_start` / `message_update` / `message_end` — 消息生成过程
- `tool_execution_start` / `tool_execution_end` — 工具执行过程
- `notification` — 系统通知
- `context` — 上下文 token 用量

### 示例：Git 操作插件

项目自带 [plugins/git-operations.ts](./plugins/git-operations.ts) 作为完整示例，提供：
- LLM 工具：`git_status`、`git_log`、`git_diff`、`git_branches`
- 命令：`/git`、`/git-log`、`/git-status`、`/git-diff`

```bash
# 加载 git 插件
npm run dev -- --plugin ./plugins/git-operations.ts
```


## Development

```bash
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm run build      # Compile
```

### Project Structure

```
src/
├── agent.ts             # Agent orchestrator
├── agent-loop.ts        # LLM driving loop
├── cli.ts               # CLI entry point
├── compaction.ts        # Context compaction data model
├── config.ts            # Config file loader
├── env.ts               # .env loader
├── event-bus.ts         # Cross-component event bus
├── llm.ts               # LLM stream types
├── session-manager.ts   # Session lifecycle
├── session-store.ts     # JSONL persistence
├── session.ts           # High-level session API
├── token-estimate.ts    # Token usage estimation
├── types.ts             # Shared types
├── tui/
│   ├── component.ts     # TUI components
│   └── index.ts
├── plugin/
│   ├── index.ts
│   ├── loader.ts        # Plugin loading
│   └── runner.ts        # Plugin runtime
├── providers/
│   └── openai.ts        # OpenAI streaming provider
└── tools/
    └── index.ts         # Built-in tools
```

## License

MIT
