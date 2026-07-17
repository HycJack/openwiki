# TUI Agent Refactor

A plugin-based TUI coding agent with session management, session-store, and slot-based UI architecture (using `@earendil-works/pi-tui`).

## Project Overview

This is an interactive **coding agent** that runs in the terminal. It provides a chat-like interface where users can ask the LLM to perform coding tasks, execute shell commands, and use tools — all within a TUI (Terminal User Interface).

## Architecture

### Core Layers

| Layer | Directory | Description |
|-------|-----------|-------------|
| **Agent** | `src/agent.ts` | Main agent orchestrator. Manages LLM calls, messages, streaming, and event dispatch. |
| **Agent Loop** | `src/agent-loop.ts` | Core loop: LLM streaming, tool call execution, retry, steering messages, compaction. Driven by `runAgentLoop` / `runAgentLoopContinue`. |
| **TUI** | `src/tui/component.ts` | Terminal UI components: TitleBar (border), MessageList (with folding), Footer, InputBar, StatusBar (status+model). Uses pi-tui. |
| **Session** | `src/session-manager.ts` | Session lifecycle: create, save, switch, fork. Integration with session-store. |
| **Session Store** | `src/session-store.ts` | Persistence layer: tree-structured session storage in JSONL files (`~/.tca/sessions/`). |
| **Plugin System** | `src/plugin/` | Plugin loading, runtime, and event dispatch. |
| **LLM Provider** | `src/providers/openai.ts` | OpenAI-compatible streaming provider. |
| **Tools** | `src/tools/index.ts` | Built-in tools (bash, glob, read, write, search, etc.). |
| **Compaction** | `src/compaction.ts` | Context compression data model and prompt builder. |
| **Token Estimate** | `src/token-estimate.ts` | Token counting and context usage estimation. |

### File Map

```
src/
├── agent.ts             # Agent class — LLM orchestration, state, events
├── agent-loop.ts        # runAgentLoop / runAgentLoopContinue — the LLM driving loop
├── cli.ts               # CLI entry point — argument parsing, TUI setup, command handling
├── llm.ts               # LLM stream types, message converters
├── types.ts             # All shared types (AgentMessage, AgentEvent, Plugin, etc.)
├── session-manager.ts   # Session lifecycle manager
├── session-store.ts     # JSONL-based session persistence (tree structure)
├── session-paths.ts     # Path utilities for session files
├── session.ts           # AgentSession wrapper (high-level API)
├── compaction.ts        # Context compaction data model
├── token-estimate.ts    # Token usage estimation
├── config.ts            # User configuration (~/.tca/config.json)
├── env.ts               # Environment variable loading
├── system-prompt.ts     # System prompt builder
├── event-bus.ts         # Cross-component event bus
├── index.ts             # Public exports
├── tui/
│   ├── component.ts     # TUI components (TitleBar, MessageList, Footer, InputBar, StatusBar)
│   └── index.ts         # Public exports
├── plugin/
│   ├── index.ts         # Plugin system exports
│   ├── loader.ts        # Plugin discovery and loading
│   └── runner.ts        # Plugin runtime and event dispatch
├── providers/
│   └── openai.ts        # OpenAI streaming provider
└── tools/
    └── index.ts         # Built-in tool implementations
```

### Data Flow (User Input → LLM → Response)

```
User input (text)
  │
  ▼
cli.ts: inputBar.onSubmit
  │
  ▼
agent.agentLoop(text)
  ├── _agentEndEmitted = false  ← reset, allow agent_end emit
  ├── create userMsg (不直接 push 到 _messages，由 runAgentLoop 内部 push)
  ├── broadcast("message_start")
  │
  ▼
runAgentLoop(prompts, context, config, emit, signal)
  ├── create currentContext (messages = [...context.messages, ...prompts])
  ├── broadcast("agent_start", "turn_start")
  │
  ▼
runLoop()
  ├── streamAssistantResponse()  ← calls streamOpenAI()
  │     ├── yield "text_delta"  → broadcast("message_update")
  │     ├── yield "tool_call"   → broadcast("message_update" with tool_calls)
  │     └── yield "done"        → stopReason determination
  │
  ├── push assistantMessage to currentContext.messages  ← AI 回复加入 context
  │
  ├── executeToolCalls()         ← handles tool_execution events
  │     └── tool result → push to currentContext → loop back
  │
  └── broadcast("turn_end")      ← only turn_end here, NOT agent_end
  │
  ▼
agent.ts: agentLoop() after runAgentLoop returns
  ├── sync currentContext.messages → context.messages (含 loop 内压缩结果)
  ├── this._messages = [...context.messages]  ← update state
  ├── broadcast("agent_end", this._messages)  ← emit agent_end HERE (after state update)
  └── autoCompactIfNeeded()  ← post-turn compaction
  │
  ▼
cli.ts: agent.subscribe() handlers
  ├── message_update → chat.appendStreamingDelta()  → TUI render
  ├── agent_end      → chat.updateMessages() + sessionMgr.scheduleFlush() → JSONL save
  └── notification   → console.log or chat.setStatus()
```

### Session Persistence Flow

```
agent_end event
  │
  ▼
cli.ts: sessionMgr.scheduleFlush(agent.state.messages)
  │
  ▼
scheduleFlush(messages)
  ├── _pendingMessages = messages  ← stash messages
  ├── _pendingFlush = _pendingFlush.catch().then(() => flush())  ← chain, avoid concurrent
  │
  ▼
flush()
  ├── capture snapshot (sessionId, entries, lastEntryId, pendingMessages)
  ├── _pendingMessages = []  ← clear immediately
  │
  ├── compute savedCount (compaction-aware):
  │     ├── find last CompactionEntry in entries
  │     ├── if found: savedCount = 1 (summaryMsg↔compactionEntry)
  │     │              + keptMsgCount (firstKeptEntryId → compactionEntry)
  │     │              + postCompactionMsgs (after compactionEntry)
  │     └── if not found: savedCount = all non-compaction entries
  │
  ├── newMessages = pendingMessages.slice(savedCount)
  ├── if newMessages.length === 0: return
  │
  └── for each newMsg:
        ├── appendSessionEntry(cwd, sessionId, msg, currentParentId)
        ├── currentParentId = newEntryId  ← maintain parentId chain
        └── update _lastEntryId (only if still same session)
```

### Session Switch Flow

```
/session <id> or /session new
  │
  ▼
sessionMgr.switchTo(id) / createNew()
  ├── await waitForFlush()  ← ensure pending flush completes
  ├── load entries + meta from JSONL
  ├── _refreshLastEntryId()  ← fix old-format meta without currentEntryId
  ├── _pendingMessages = []
  └── return extractMessages(entries)  ← for agent.setMessages()
```

### Compaction Flow

```
agentLoop finish
  │
  ▼
autoCompactIfNeeded()
  ├── estimateContextUsage(messages)  →  tokens / limit / percent
  ├── shouldCompact(usage, reserveTokens)  →  tokens > limit - reserve?
  │     └── if NO: return (no compaction needed)
  │
  ├── findCutPoint(messages, keepRecentTokens=20000)
  │     └── traverses from newest backward
  │     └── if cumulative tokens >= 20000 → firstKeptIndex
  │     └── if NO cut point found → return (too small)
  │
  ├── buildCompactionPrompt({ messagesToSummarize, keptMessages, instructions })
  │     └── serializes old messages with role + content + tool calls + results
  │     └── returns structured prompt: Goal / Constraints / Accomplished / Files / Findings / Steps
  │
  ├── summarizeWithLLM(prompt)
  │     └── calls streamOpenAI with current model
  │     └── collects full text response (not streaming to TUI)
  │     └── returns summary string or null on error
  │
  ├── buildCompactedMessages(messages, cutPoint, summary)
  │     └── creates: [summaryMsg (assistant), ...keptMessages]
  │
  ├── _onCompaction callback → sessionMgr.appendCompaction(CompactionEntry)
  │     └── appendCompactionEntry to JSONL (type:"compaction", firstKeptEntryId, summary)
  │     └── update meta.currentEntryId
  │     └── refresh _entries, _lastEntryId, clear _pendingMessages
  │
  ├── this._messages = compacted
  └── notifyUI("Auto-compacted: N messages compressed → M kept")
```

### Compaction Storage & Loading

**Storage**: CompactionEntry is appended to JSONL as a tree node (not replacing old messages):

```jsonl
{"role":"user","content":[...],"id":"aaa","parentId":null}
{"role":"assistant","content":[...],"id":"bbb","parentId":"aaa"}
{"role":"user","content":[...],"id":"ccc","parentId":"bbb"}
{"role":"assistant","content":[...],"id":"ddd","parentId":"ccc"}
{"type":"compaction","summary":"...","firstKeptEntryId":"ccc","id":"eee","parentId":"ddd"}
{"role":"user","content":[...],"id":"fff","parentId":"eee"}
```

**Loading** (`extractMessages`):
1. Find last `CompactionEntry` in entries
2. If found: return `[summaryMsg, ...keptMessages (from firstKeptEntryId to compaction), ...postCompactionMessages]`
3. If not found: return all messages (strip id/parentId)

Old messages before `firstKeptEntryId` are skipped (compressed away).

## Configuration

### Config File (`config.ts`)

| Config key | Type | Default | Environment variable | Description |
|------------|------|---------|---------------------|-------------|
| `defaultModel` | `string` | `"gpt-4o"` | `OPENAI_MODEL` | Default model ID |
| `defaultProvider` | `string` | `"openai"` | — | Default provider name |
| `baseURL` | `string` | — | `OPENAI_BASE_URL` | API base URL for OpenAI-compatible endpoints |
| `autoSaveSession` | `boolean` | `true` | — | Auto-save session on agent_end |
| `models` | `ModelConfig[]` | `[]` | — | Saved model list for `/model` switching |
| `plugins` | `string[]` | `[]` | — | Plugin paths to load |
| `tools` | `string[]` | `[]` | — | Tool name whitelist |
| `systemPrompt` | `string` | — | — | Override default system prompt |

### Model Config (`TCAConfig.models[]`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Model identifier (e.g., `"gpt-4o"`) |
| `provider` | `string` | Provider name (e.g., `"openai"`) |
| `name` | `string` (optional) | Display name |
| `apiKey` | `string` (optional) | API key (falls back to `OPENAI_API_KEY`) |
| `baseURL` | `string` (optional) | Custom base URL (falls back to `OPENAI_BASE_URL`) |
| `contextWindow` | `number` (optional) | Context window size in tokens (default: 128000) |

### Environment Variables (`env.ts`)

Loaded from `.env` (cwd priority) or `~/.tca/.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | API key for OpenAI-compatible endpoints |
| `OPENAI_MODEL` | No | `"gpt-4o"` | Default model ID |
| `OPENAI_BASE_URL` | No | `"https://api.openai.com/v1"` | API base URL |

## Compaction (`compaction.ts`)

### Key Functions

| Function | Description |
|----------|-------------|
| `findCutPoint(messages, keepRecentTokens)` | From newest backward, find index where cumulative tokens >= keepRecentTokens |
| `buildCompactedMessages(messages, cutPoint, summary)` | Create [summaryMsg, ...keptMessages] |
| `buildCompactionPrompt(input)` | Serialize old messages into structured summary prompt |
| `createCompactionEntry(summary, cutPoint, firstKeptEntryId)` | Create compaction record for JSONL storage (with entry id/parentId assigned by `appendCompactionEntry`) |

### Session Manager Methods (Compaction-related)

| Method | Description |
|--------|-------------|
| `scheduleFlush(messages)` | Chain-call `flush()` to persist messages (used by `agent_end` event) |
| `waitForFlush()` | Await pending flush (used by `switchTo`/`createNew`/`forkFrom`) |
| `appendCompaction(entry)` | Append `CompactionEntry` to JSONL, refresh memory state |
| `getEntryIdByMessageIndex(index)` | Map message index → entry ID (for `firstKeptEntryId`) |

### Thresholds

| Constant | File | Default | Description |
|----------|------|---------|-------------|
| `DEFAULT_COMPACTION_CONFIG.keepRecentTokens` | `compaction.ts` | 20,000 | Keep this many recent tokens as raw messages |
| `DEFAULT_RESERVE_TOKENS` | `token-estimate.ts` | 16,384 | Reserved space for LLM replies |
| `DEFAULT_CONTEXT_WINDOW` | `token-estimate.ts` | 128,000 | Default context window |

### Compaction Trigger

- **Auto-compaction** (in `agent-loop.ts:streamAssistantResponse`):
  - Before each LLM call, `shouldCompact()` checks if messages exceed limit - reserve
  - If yes, uses non-LLM fixed-text compaction (`[Auto-compaction triggered]`)
  - This ensures the LLM call can fit in context

- **Post-turn compaction** (in `agent.ts:autoCompactIfNeeded`):
  - After each `agentLoop` completes, checks context usage
  - If exceeded threshold, calls LLM to generate structured summary
  - Replaces early messages with LLM-generated structured summary
  - Calls `_onCompaction` callback → `sessionMgr.appendCompaction()` to persist `CompactionEntry`
  - This is LLM-powered and preserves semantic information

- **Manual compaction** (in `cli.ts:performCompact`):
  - `/compact` or `/compact <instructions>`
  - Uses `buildCompactionPrompt` + `streamOpenAI` to generate LLM summary
  - Streams summary output to terminal for user to see
  - Persists `CompactionEntry` via `sessionMgr.appendCompaction()`

### Compaction Prompt Structure

LLM receives this prompt when compaction is triggered:

```
### Goal
### Constraints
### Accomplished
### Relevant Files
### Key Findings
### Next Steps
```

## Plugin System (`plugin/`)

### Plugin Interface

插件是一个 `.ts` 或 `.js` 文件，默认导出工厂函数 `(api: ExtensionAPI) => void`：

```typescript
import type { ExtensionAPI } from "tui-coding-agent";

export default function (api: ExtensionAPI) {
  // 注册事件监听
  api.on("agent_end", (event, ctx) => {
    console.log(`Agent ended, ${ctx.getMessageCount()} messages`);
  });

  // 注册 LLM 工具
  api.registerTool({
    name: "my_tool",
    description: "Description for LLM",
    parameters: { type: "object", properties: {} },
    execute: async (toolCallId, params) => ({
      content: [{ type: "text", text: "result" }],
    }),
  });

  // 注册 /xxx 命令
  api.registerCommand("hello", async (ctx, args) => {
    ctx.notify(`Hello, ${args || "World"}!`, "info");
  }, "Say hello");
}
```

### ExtensionAPI 方法

| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `(event: string, handler: (...args) => void)` | Subscribe to agent lifecycle events |
| `registerTool` | `(tool: AgentTool) => void` | Register an LLM-callable tool |
| `registerCommand` | `(name, handler, description?) => void` | Register a `/xxx` command |
| `notify` | `(message, type?) => void` | Show notification |
| `exec` | `(cmd, args, cwd?) => Promise<{stdout, stderr, exitCode}>` | Execute shell command (30s timeout) |
| `getActiveTools` | `() => string[]` | Get enabled tool names |
| `setActiveTools` | `(names: string[]) => void` | Enable/disable tools |
| `ui` | `PluginUIContext` | UI operations (setStatus, setHeader, etc.) |

### 事件类型（`api.on` 的第一个参数）

| 事件 | 触发时机 |
|------|---------|
| `agent_start` | Agent 开始处理一轮输入 |
| `agent_end` | Agent 完成处理（含 `messages: AgentMessage[]`） |
| `turn_start` | 新的一轮 LLM 交互开始 |
| `turn_end` | 一轮交互结束（含 `message`, `toolResults`）|
| `message_start` | 新消息开始生成 |
| `message_update` | 流式消息增量（含 `delta: string`）|
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_end` | 工具执行完成 |
| `notification` | 系统通知 |
| `context` | 上下文 token 用量报告 |

### 插件发现顺序

1. CLI `--plugin` args
2. Cwd plugin dir (`<cwd>/plugins/`)
3. Global plugin dir (`~/.tca/plugins/`)

## Key Features

### Session Management

- Sessions are stored as **JSONL files** in `~/.tca/sessions/<cwd-hash>/<session-id>.jsonl`
- Each message has `id` / `parentId` forming a **tree structure**
- Compaction entries stored inline as `CompactionEntry` with `firstKeptEntryId` (pointing to first kept message's entry id)
- **Persistence**: `agent_end` → `scheduleFlush()` → chained `flush()` → `appendSessionEntry()` (only new messages appended)
- **Switch safety**: `switchTo`/`createNew`/`forkFrom` all `await waitForFlush()` before modifying state
- **Compaction-aware flush**: `flush()` computes `savedCount` considering `CompactionEntry` to avoid duplicate saves
- Commands: `/sessions` (list), `/session <id>` (switch), `/session new` (create), `/tree` (tree view), `/fork <entry-id>` (branch)

### TUI Layout

```
╭──────────────────────────────────────────────────────╮
│
┊  ── User ──────────────  12:00:00
┊  你好
│
┊  ── AI ────────────────  12:00:01
┊  我来用 ls 命令
┊  ⚡ bash - ls -la
│
╰─ ❯ /workspace ──────────────────────────────────────
> <input cursor>
● Ready  gpt-4o
```

### Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear screen |
| `/model [provider:id]` | Switch model |
| `/tokens` | Show token usage |
| `/ctx [compact]` | Context overview / compact |
| `/compact <notes>` | Compact with instructions |
| `/sessions` | List all sessions |
| `/session <id> \| new` | Switch / create session |
| `/tree` | Show session tree |
| `/fork <entry-id>` | Fork a new branch |
| `/exit` | Exit |

### Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` | Abort streaming or exit |
| `Ctrl+O` | Toggle message folding (expand/collapse) |
| `↑` | Previous input history |
| `↓` | Next input history |
| `Esc` | Cancel current streaming turn |

## Development

### Setup

```bash
cp .env.example .env
# Edit .env with your OPENAI_API_KEY
npm install
```

### Run

```bash
# Interactive mode
npm run dev

# Non-interactive mode (single prompt)
npm run dev -- --print "list files"
```

### Type Check

```bash
npm run typecheck
```

## Design Principles

1. **pi-mono compatibility** — Architecture and APIs follow pi-mono conventions where applicable
2. **Deterministic TUI** — All animations/transitions are seek-driven, no accidental side effects during render
3. **Session tree** — Messages form a parentId tree, supporting branching and forking
4. **Plugin-first** — Commands and tools can be extended via plugins
5. **Minimal dependencies** — Only pi-tui, chalk, marked, and typebox
6. **LLM-driven compaction** — Context compression uses the same LLM to generate structured summaries, preserving semantic information rather than naive truncation
