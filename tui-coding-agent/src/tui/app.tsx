/**
 * TUI 交互界面 - 基于 Ink
 *
 * 参考 openwiki 的 cli.tsx Ink UI 设计：
 * - 消息列表渲染
 * - 流式输出显示
 * - 用户输入框
 *
 * 参考 pi-mono 的 interactive-mode 设计：
 * - 工具执行显示
 * - 状态栏
 *
 * 注意：Ink 不支持原生 HTML 元素，所有输入通过 useInput hook + useState 处理。
 */

import React, { useEffect, useRef, useState, useCallback, memo } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { marked, type Token, type Tokens } from "marked";
import type { Agent } from "../agent.js";
import type { AgentEvent } from "../types.js";
import type { AgentMessage, ToolCallContent, TextContent } from "../types.js";
import type { PluginRunner } from "../plugin/runner.js";

interface MessageItem {
  role: string;
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; isError: boolean; text: string }>;
  isStreaming?: boolean;
  error?: string;
}

function extractMessageText(message: AgentMessage): string {
  if (message.role === "user") {
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (message.role === "assistant") {
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

function extractToolCalls(message: AgentMessage): Array<{ name: string; args: unknown }> {
  if (message.role !== "assistant") return [];
  return message.content
    .filter((c): c is ToolCallContent => c.type === "toolCall")
    .map((c) => ({ name: c.name, args: c.arguments }));
}

function extractToolResults(message: AgentMessage): Array<{ name: string; isError: boolean; text: string }> {
  if (message.role !== "toolResult") return [];
  return message.content.map((c, idx) => ({
    name: `#${idx + 1}`,
    isError: c.isError ?? false,
    text: c.content
      .filter((cc): cc is TextContent => cc.type === "text")
      .map((cc) => cc.text)
      .join("\n"),
  }));
}

function messageToItem(message: AgentMessage, isStreaming = false): MessageItem {
  return {
    role: message.role,
    text: extractMessageText(message),
    reasoning: message.role === "assistant" ? (message as { reasoning?: string }).reasoning : undefined,
    toolCalls: extractToolCalls(message),
    toolResults: extractToolResults(message),
    isStreaming,
    error: message.role === "assistant" ? message.errorMessage : undefined,
  };
}

const COLORS: Record<string, string> = {
  user: "cyan",
  assistant: "green",
  toolResult: "gray",
};

const LABELS: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
  toolResult: "Tool",
};

const MessageView = memo(function MessageView({ item }: { item: MessageItem }) {
  const color = COLORS[item.role] ?? "white";
  const label = LABELS[item.role] ?? item.role;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}:
      </Text>
      {item.reasoning && (
        <Box paddingLeft={1} flexDirection="column">
          <Text color="gray" italic>
            ...{item.reasoning}
          </Text>
        </Box>
      )}
      {item.text && (
        <Box flexDirection="column">
          {item.role === "toolResult" ? (
            <Text color="gray">{item.text}</Text>
          ) : item.isStreaming ? (
            <Text>{item.text}</Text>
          ) : (
            <MarkdownText markdown={item.text} />
          )}
          {item.isStreaming && (
            <Text>▋</Text>
          )}
        </Box>
      )}
      {item.toolCalls?.map((tc, i) => (
        <Box key={i} flexDirection="column">
          <Text color="yellow">
            [Tool Call] {tc.name}({JSON.stringify(tc.args).slice(0, 200)})
          </Text>
        </Box>
      ))}
      {item.toolResults?.map((tr, i) => (
        <Box key={i} flexDirection="column">
          <Text color={tr.isError ? "red" : "blue"}>
            [Tool Result{tr.isError ? " ERROR" : ""}]
          </Text>
          <Text color={tr.isError ? "red" : "gray"}>
            {tr.text.slice(0, 500)}
          </Text>
        </Box>
      ))}
      {item.error && (
        <Text color="red" bold>
          Error: {item.error}
        </Text>
      )}
    </Box>
  );
});

interface TUIProps {
  agent: Agent;
  pluginRunner: PluginRunner;
  cwd: string;
  sessionId?: string;
  sessions?: Array<{ id: string; name?: string; messageCount: number; updatedAt: string }>;
  onNewSession?: () => Promise<void>;
  onResumeSession?: (sessionId: string) => Promise<void>;
  onRenameSession?: (name: string) => Promise<void>;
}

/** 内置命令列表 */
const BUILTIN_COMMANDS = [
  { name: "clear", description: "Clear conversation" },
  { name: "new", description: "Start a new session" },
  { name: "sessions", description: "List and select sessions" },
  { name: "name", description: "Rename current session" },
  { name: "exit", description: "Exit the agent" },
  { name: "quit", description: "Exit the agent" },
];

function TUIApp({ agent, pluginRunner, cwd, sessionId, sessions = [], onNewSession, onResumeSession, onRenameSession }: TUIProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedCmdIdx, setSelectedCmdIdx] = useState(0);
  const [showSessionList, setShowSessionList] = useState(false);
  const [selectedSessionIdx, setSelectedSessionIdx] = useState(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  // 流式渲染优化：缓存当前流式文本，避免每次 update 重建 MessageItem
  const streamingTextRef = useRef<string>("");
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  // 收集所有斜杠命令
  const allCommands = useCallback(() => {
    const cmds = [...BUILTIN_COMMANDS];
    for (const cmd of pluginRunner.getRegisteredCommands()) {
      if (!cmds.some((c) => c.name === cmd.name)) {
        cmds.push({ name: cmd.name, description: "" });
      }
    }
    return cmds;
  }, [pluginRunner]);

  const filteredCommands = useCallback(() => {
    const cmds = allCommands();
    if (!slashFilter) return cmds;
    return cmds.filter((c) => c.name.startsWith(slashFilter));
  }, [allCommands, slashFilter]);

  // 订阅 agent 事件
  useEffect(() => {
    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          setIsStreaming(true);
          setStatus("Thinking...");
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            setMessages((prev) => [...prev, messageToItem(event.message, true)]);
          } else if (event.message.role === "user") {
            setMessages((prev) => [...prev, messageToItem(event.message)]);
          }
          break;
        case "message_update":
          if (event.message.role === "assistant") {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last) return prev;
              // 原地修改 text 字段，保留引用于 memo 比较
              const text = extractMessageText(event.message);
              if (last.text !== text) (prev[prev.length - 1] as MessageItem).text = text;
              if (event.message.role === "assistant") {
                const reasoning = (event.message as { reasoning?: string }).reasoning;
                if (reasoning && last.reasoning !== reasoning) {
                  (prev[prev.length - 1] as MessageItem).reasoning = reasoning;
                }
              }
              // 返回新数组触发 re-render，但 MessageItem 引用保持不变
              return [...prev];
            });
          }
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            setMessages((prev) => {
              const next = [...prev];
              if (next.length > 0) {
                next[next.length - 1] = messageToItem(event.message, false);
              }
              return next;
            });
          } else if (event.message.role === "toolResult") {
            setMessages((prev) => [...prev, messageToItem(event.message)]);
          }
          break;
        case "tool_execution_start":
          setStatus(`Running: ${event.toolName}`);
          break;
        case "tool_execution_end":
          setStatus("");
          break;
        case "turn_end":
          break;
        case "agent_end":
          setIsStreaming(false);
          setStatus("");
          break;
      }
      // 转发给插件
      await pluginRunner.emit(event);
    });
    return unsubscribe;
  }, [agent, pluginRunner]);

  const submitCommand = useCallback(async (cmdText: string) => {
    const fullText = cmdText;
    const [cmd, ...rest] = fullText.slice(1).split(" ");
    const args = rest.join(" ");

    // 内置命令
    if (cmd === "clear") {
      agent.reset();
      setMessages([]);
      setInput("");
      setCursorPos(0);
      return;
    }
    if (cmd === "new") {
      onNewSession?.();
      return;
    }
    if (cmd === "sessions") {
      setShowSessionList(true);
      setSelectedSessionIdx(0);
      return;
    }
    if (cmd === "name") {
      if (args) {
        onRenameSession?.(args);
      } else {
        setIsRenaming(true);
        setRenameInput("");
      }
      return;
    }
    if (cmd === "exit" || cmd === "quit") {
      exit();
      return;
    }

    // 插件命令
    const handled = await pluginRunner.executeCommand(cmd, args);
    if (handled) {
      setInput("");
      setCursorPos(0);
      return;
    }
  }, [agent, pluginRunner, exit, onNewSession, onRenameSession]);

  // 键盘输入处理
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }
    if (key.escape && isStreaming) {
      agent.abort();
      return;
    }

    // 会话重命名模式
    if (isRenaming) {
      if (key.return) {
        onRenameSession?.(renameInput);
        setIsRenaming(false);
        setRenameInput("");
        return;
      }
      if (key.escape) {
        setIsRenaming(false);
        setRenameInput("");
        return;
      }
      if (key.backspace || key.delete) {
        setRenameInput((prev) => prev.slice(0, -1));
        return;
      }
      if (inputChar && !key.ctrl && !key.meta) {
        setRenameInput((prev) => prev + inputChar);
      }
      return;
    }

    // 会话列表选择模式
    if (showSessionList) {
      if (key.return) {
        if (sessions.length > 0 && selectedSessionIdx < sessions.length) {
          onResumeSession?.(sessions[selectedSessionIdx]!.id);
          setShowSessionList(false);
          setSelectedSessionIdx(0);
        }
        return;
      }
      if (key.upArrow) {
        setSelectedSessionIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedSessionIdx((prev) => Math.min(sessions.length - 1, prev + 1));
        return;
      }
      if (key.escape) {
        setShowSessionList(false);
        setSelectedSessionIdx(0);
        return;
      }
      return;
    }

    // 斜杠菜单模式
    if (showSlashMenu) {
      if (key.return) {
        const cmds = filteredCommands();
        if (cmds.length > 0) {
          const selected = cmds[selectedCmdIdx];
          const cmdText = "/" + selected.name;
          submitCommand(cmdText);
          setShowSlashMenu(false);
          setSlashFilter("");
          setSelectedCmdIdx(0);
        }
        return;
      }
      if (key.upArrow) {
        setSelectedCmdIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        const cmds = filteredCommands();
        setSelectedCmdIdx((prev) => Math.min(cmds.length - 1, prev + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (slashFilter.length > 0) {
          const newFilter = slashFilter.slice(0, -1);
          setSlashFilter(newFilter);
          setInput("/" + newFilter);
          setCursorPos(1 + newFilter.length);
          setSelectedCmdIdx(0);
        } else {
          setShowSlashMenu(false);
          setSlashFilter("");
          setInput("");
          setCursorPos(0);
        }
        return;
      }
      if (key.escape) {
        setShowSlashMenu(false);
        setSlashFilter("");
        setSelectedCmdIdx(0);
        return;
      }
      if (inputChar && !key.ctrl && !key.meta) {
        const newFilter = slashFilter + inputChar;
        setSlashFilter(newFilter);
        setInput("/" + newFilter);
        setCursorPos(1 + newFilter.length);
        setSelectedCmdIdx(0);
        return;
      }
      return;
    }

    // Enter: 提交输入
    if (key.return) {
      handleSubmit();
      return;
    }

    // 左右方向键：移动光标
    if (key.leftArrow) {
      historyIndex.current = -1;
      setCursorPos((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      historyIndex.current = -1;
      setCursorPos((prev) => Math.min(input.length, prev + 1));
      return;
    }
    if (inputChar === "a" && key.ctrl) {
      historyIndex.current = -1;
      setCursorPos(0);
      return;
    }
    if (inputChar === "e" && key.ctrl) {
      historyIndex.current = -1;
      setCursorPos(input.length);
      return;
    }

    // Backspace: 在光标位置删除
    if (key.backspace || key.delete) {
      historyIndex.current = -1;
      if (cursorPos > 0) {
        const before = input.slice(0, cursorPos - 1);
        const after = input.slice(cursorPos);
        const newInput = before + after;
        setInput(newInput);
        setCursorPos(cursorPos - 1);

        // 检查斜杠菜单
        if (newInput.startsWith("/") && !newInput.includes(" ")) {
          setShowSlashMenu(true);
          setSlashFilter(newInput.slice(1));
          setSelectedCmdIdx(0);
        }
      }
      return;
    }

    // 上箭头：历史记录
    if (key.upArrow && inputHistory.current.length > 0) {
      const idx = historyIndex.current === -1
        ? inputHistory.current.length - 1
        : Math.max(0, historyIndex.current - 1);
      historyIndex.current = idx;
      setInput(inputHistory.current[idx]);
      setCursorPos(inputHistory.current[idx].length);
      return;
    }
    // 下箭头：历史记录
    if (key.downArrow && historyIndex.current >= 0) {
      const idx = historyIndex.current + 1;
      if (idx >= inputHistory.current.length) {
        historyIndex.current = -1;
        setInput("");
        setCursorPos(0);
      } else {
        historyIndex.current = idx;
        setInput(inputHistory.current[idx]);
        setCursorPos(inputHistory.current[idx].length);
      }
      return;
    }

    // 可打印字符：在光标位置插入
    if (inputChar && !key.ctrl && !key.meta) {
      historyIndex.current = -1;
      const before = input.slice(0, cursorPos);
      const after = input.slice(cursorPos);
      const newInput = before + inputChar + after;
      const newPos = cursorPos + inputChar.length;
      setInput(newInput);
      setCursorPos(newPos);

      // 如果输入了 / 且没有空格，显示斜杠菜单
      if (newInput.startsWith("/") && !newInput.includes(" ")) {
        setShowSlashMenu(true);
        setSlashFilter(newInput.slice(1));
        setSelectedCmdIdx(0);
      } else if (showSlashMenu) {
        // 输入空格关闭菜单
        if (inputChar === " ") {
          setShowSlashMenu(false);
          setSlashFilter("");
        }
      }

      return;
    }
  });

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // 关闭斜杠菜单
    setShowSlashMenu(false);
    setSlashFilter("");

    // 保存到历史（最多 100 条）
    inputHistory.current.push(text);
    if (inputHistory.current.length > 100) {
      inputHistory.current = inputHistory.current.slice(-100);
    }
    historyIndex.current = -1;

    // 处理斜杠命令
    if (text.startsWith("/")) {
      setInput("");
      setCursorPos(0);
      await submitCommand(text);
      return;
    }

    setInput("");
    setCursorPos(0);
    setIsStreaming(true);
    try {
      await agent.prompt(text);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "error" as const, text: err instanceof Error ? err.message : String(err), isStreaming: false, toolCalls: [], toolResults: [] },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, agent, submitCommand]);

  // 渲染输入框：光标用竖线 | 显示（参考 openwiki 设计）
  const renderInput = () => {
    if (isStreaming) {
      return (
        <Text>
          Agent is working... (Esc to abort)
        </Text>
      );
    }
    if (!input) {
      return (
        <Text>
          <Text color="cyan">|</Text>
          <Text color="gray"> Type a message...</Text>
        </Text>
      );
    }

    const before = input.slice(0, cursorPos);
    const after = input.slice(cursorPos);

    return (
      <Text>
        {before}<Text color="cyan">|</Text>{after}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          TUI Coding Agent
        </Text>
        <Text>
          {" "}| {cwd}{sessionId ? ` | ${sessionId.slice(0, 12)}` : ""}
        </Text>
      </Box>

      {/* Session rename input */}
      {isRenaming && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
          <Text color="yellow" bold>Session name: </Text>
          <Text>{renameInput || "(type name, Enter to confirm, Esc to cancel)"}</Text>
        </Box>
      )}

      {/* Session list (floating overlay above input) */}
      {showSessionList && (
        <Box
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
          paddingY={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="magenta">
            Sessions ({sessions.length}):
          </Text>
          {sessions.length === 0 && (
            <Text color="gray">No previous sessions.</Text>
          )}
          {sessions.map((s, i) => (
            <Text key={s.id} color={i === selectedSessionIdx ? "magenta" : undefined}>
              {i === selectedSessionIdx ? "> " : "  "}
              {s.name || s.id.slice(0, 16)}
              {" "}
              <Text color="gray">
                ({s.messageCount} msgs, {new Date(s.updatedAt).toLocaleDateString()})
              </Text>
            </Text>
          ))}
          <Text color="gray">↑↓ select, Enter resume, Esc cancel</Text>
        </Box>
      )}

      {/* Messages - scrollable area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {messages.map((msg, i) => (
          <MessageView key={`msg-${i}`} item={msg} />
        ))}
        {isStreaming && status && (
          <Text color="yellow" italic>
            {status}
          </Text>
        )}
      </Box>

      {/* Slash command menu (floating above input bar) */}
      {showSlashMenu && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          paddingY={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            Commands:
          </Text>
          {filteredCommands().map((cmd, i) => (
            <Text key={cmd.name} color={i === selectedCmdIdx ? "yellow" : undefined}>
              {i === selectedCmdIdx ? "> " : "  "}
              /{cmd.name}{cmd.description ? ` - ${cmd.description}` : ""}
            </Text>
          ))}
        </Box>
      )}

      {/* Input bar */}
      <Box borderStyle="round" borderColor={isStreaming ? "yellow" : "cyan"} paddingX={1}>
        <Text color={isStreaming ? "yellow" : "cyan"} bold>
          {">"}
        </Text>
        {renderInput()}
      </Box>

      {/* Footer */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text italic color="gray">
          ↑↓:History  ←→:Cursor  /:Commands  Enter:Submit  Esc:Abort  Ctrl+C:Exit
        </Text>
        <Text color="gray">
          {sessionId ? sessionId.slice(0, 12) : ""} | {agent.state.model.id}
        </Text>
      </Box>
    </Box>
  );
}
// ---------------------------------------------------------------------------
// 消息分组折叠
// ---------------------------------------------------------------------------

interface MessageGroupSingle {
  type: "single";
  item: MessageItem;
  index: number;
}

interface MessageGroupCollapsed {
  type: "group";
  items: MessageItem[];
  index: number;
}

type MessageGroup = MessageGroupSingle | MessageGroupCollapsed;

/**
 * 将消息列表分组：
 * - assistant(toolCalls) + toolResult(s) + following assistant 合并为一组
 * - 其余保持单条
 */
function mergeMessageGroups(messages: MessageItem[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const current = messages[i]!;

    // 只有 assistant 有 toolCall 时考虑分组
    if (current.role === "assistant" && current.toolCalls && current.toolCalls.length > 0) {
      const group: MessageItem[] = [current];
      i++;

      // 收集后续的 toolResult
      while (i < messages.length && messages[i]!.role === "toolResult") {
        group.push(messages[i]!);
        i++;
      }

      // 如果 toolResult 之后有 assistant 消息，也加入
      if (i < messages.length && messages[i]!.role === "assistant" && !messages[i]!.isStreaming) {
        group.push(messages[i]!);
        i++;
      }

      groups.push({ type: "group", items: group, index: groups.length });
    } else {
      groups.push({ type: "single", item: current, index: groups.length });
      i++;
    }
  }

  return groups;
}

const CollapsibleGroup = memo(function CollapsibleGroup({
  items,
  defaultCollapsed,
}: {
  items: MessageItem[];
  defaultCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useInput((input, key) => {
    if (key.ctrl && input === "o") setCollapsed((v) => !v);
  });

  const first = items[0]!;
  const toolCount = items.filter((m) => m.role === "toolResult").length;
  const color = first.role === "assistant" ? "green" : "white";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={collapsed ? "gray" : color} bold>
          {collapsed ? "▶" : "▼"}
        </Text>{" "}
        <Text color={color} bold>
          {first.role === "assistant" ? "Assistant" : "Tool"}
        </Text>
        <Text color="gray">
          {" "}({toolCount} tool call{toolCount !== 1 ? "s" : ""})
        </Text>
      </Text>
      {!collapsed && items.map((item, i) => (
        <MessageView key={i} item={item} />
      ))}
    </Box>
  );
});

// ---------------------------------------------------------------------------
// Markdown 渲染（基于 marked）
// ---------------------------------------------------------------------------

function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = marked.lexer(markdown, {
    async: false,
    gfm: true,
  });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock key={`${token.type}-${index}`} token={token} />
      ))}
    </Box>
  );
}

function MarkdownBlock({ token }: { token: Token }) {
  if (token.type === "space" || token.type === "def" || token.type === "hr") {
    return null;
  }

  if (token.type === "paragraph") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "heading") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "list") {
    return (
      <Box flexDirection="column">
        {(token as Tokens.List).items.map((item, itemIndex) => (
          <Text key={`${itemIndex}`} wrap="wrap">
            <Text color="gray">
              {(token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + itemIndex}. `
                : "- "}
            </Text>
            <InlineMarkdown tokens={getTokenChildren(item)} />
          </Text>
        ))}
      </Box>
    );
  }

  if (token.type === "code") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "blockquote") {
    return (
      <Text wrap="wrap">
        <Text color="gray">| </Text>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "table") {
    return <Text color="gray">{renderPlainTable(token as Tokens.Table)}</Text>;
  }

  if (token.type === "html") {
    return <Text wrap="wrap">{token.text}</Text>;
  }

  if (token.type === "text") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={token.tokens ?? [token]} />
      </Text>
    );
  }

  return <Text wrap="wrap">{token.raw}</Text>;
}

function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
}

function InlineMarkdownToken({ token }: { token: Token }) {
  if (token.type === "text" || token.type === "escape") {
    return <>{token.text}</>;
  }

  if (token.type === "strong") {
    return (
      <Text bold>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "em") {
    return (
      <Text italic>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "link") {
    return (
      <Text underline>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "codespan") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "br") {
    return <>{"\n"}</>;
  }

  if (token.type === "del") {
    return (
      <Text strikethrough>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "html") {
    return <>{token.text}</>;
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return <InlineMarkdown tokens={token.tokens} />;
  }

  return <>{token.raw}</>;
}

function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderPlainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => cell.text).join(" | ");
  const rows = token.rows.map((row) => row.map((cell) => cell.text).join(" | "));
  return [header, ...rows].filter(Boolean).join("\n");
}

export async function renderTUI(
  agent: Agent,
  pluginRunner: PluginRunner,
  cwd: string,
  options?: {
    sessionId?: string;
    sessions?: Array<{ id: string; name?: string; messageCount: number; updatedAt: string }>;
    onNewSession?: () => Promise<void>;
    onResumeSession?: (sessionId: string) => Promise<void>;
    onRenameSession?: (name: string) => Promise<void>;
  },
): Promise<void> {
  const { waitUntilExit } = render(
    <TUIApp
      agent={agent}
      pluginRunner={pluginRunner}
      cwd={cwd}
      sessionId={options?.sessionId}
      sessions={options?.sessions}
      onNewSession={options?.onNewSession}
      onResumeSession={options?.onResumeSession}
      onRenameSession={options?.onRenameSession}
    />,
    { exitOnCtrlC: true },
  );
  await waitUntilExit;
}
