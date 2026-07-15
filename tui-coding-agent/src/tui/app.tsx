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

import React, { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { marked, Token, type Tokens } from "marked";
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
  onNotify?: (message: string, type?: "info" | "warning" | "error") => void;
  onSetInitialMessages?: (setter: (messages: AgentMessage[]) => void) => void;
  onReloadPlugins?: () => Promise<void>;
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

function TUIApp({ agent, pluginRunner, cwd, sessionId, sessions = [], onNewSession, onResumeSession, onRenameSession, onNotify, onSetInitialMessages, onReloadPlugins }: TUIProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [notifications, setNotifications] = useState<Array<{ text: string; type: "info" | "warning" | "error"; id: number }>>([]);
  const notifIdRef = useRef(0);
  const setMessagesRef = useRef<(msgs: AgentMessage[]) => void>(() => {});
  setMessagesRef.current = (msgs: AgentMessage[]) => {
    const items = msgs.map((m) => messageToItem(m, m.role === "assistant"));
    setMessages(items);
  };

  useEffect(() => {
    if (onSetInitialMessages) {
      const fn = onSetInitialMessages;
      fn(setMessagesRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedCmdIdx, setSelectedCmdIdx] = useState(0);
  const [showSessionList, setShowSessionList] = useState(false);
  const [selectedSessionIdx, setSelectedSessionIdx] = useState(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [groupsCollapsed, setGroupsCollapsed] = useState(false);
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  // 使用 ref 缓存最新的回调函数，避免 useInput 闭包过期问题
  const inputRef = useRef(input);
  const isStreamingRef = useRef(isStreaming);
  const showSlashMenuRef = useRef(showSlashMenu);
  const showSessionListRef = useRef(showSessionList);
  const isRenamingRef = useRef(isRenaming);
  const slashFilterRef = useRef(slashFilter);
  const selectedCmdIdxRef = useRef(selectedCmdIdx);
  const selectedSessionIdxRef = useRef(selectedSessionIdx);
  const cursorPosRef = useRef(cursorPos);
  const sessionsRef = useRef(sessions);
  const renameInputRef = useRef(renameInput);

  inputRef.current = input;
  isStreamingRef.current = isStreaming;
  showSlashMenuRef.current = showSlashMenu;
  showSessionListRef.current = showSessionList;
  isRenamingRef.current = isRenaming;
  slashFilterRef.current = slashFilter;
  selectedCmdIdxRef.current = selectedCmdIdx;
  selectedSessionIdxRef.current = selectedSessionIdx;
  cursorPosRef.current = cursorPos;
  sessionsRef.current = sessions;
  renameInputRef.current = renameInput;

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
    const filter = slashFilterRef.current;
    if (!filter) return cmds;
    return cmds.filter((c) => c.name.startsWith(filter));
  }, [allCommands]);

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
              const text = extractMessageText(event.message);
              const reasoning = (event.message as { reasoning?: string }).reasoning;
              // 只有内容变化时才创建新对象触发重渲染
              if (last.text === text && last.reasoning === reasoning) return prev;
              const updated = { ...last, text, reasoning: reasoning ?? last.reasoning };
              const next = [...prev];
              next[next.length - 1] = updated;
              return next;
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
        case "notification":
          const id = notifIdRef.current++;
          setNotifications((prev) => [...prev.slice(-9), { text: event.message, type: event.level, id }]);
          return; // 不需要转发给插件
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

    // /plugins 命令
    if (cmd === "plugins") {
      if (args === "reload") {
        onReloadPlugins?.();
      } else {
        const paths = pluginRunner.getPluginPaths();
        const text = paths.length > 0
          ? `Loaded plugins (${paths.length}):\n${paths.map((p) => `  - ${p}`).join("\n")}`
          : "No plugins loaded.";
        onNotify?.(text, "info");
      }
      setInput("");
      setCursorPos(0);
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

  // 键盘输入处理 - 通过 ref 读取最新状态避免闭包过期
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }
    if (key.escape && isStreamingRef.current) {
      agent.abort();
      return;
    }

    // 会话重命名模式
    if (isRenamingRef.current) {
      if (key.return) {
        onRenameSession?.(renameInputRef.current);
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
    if (showSessionListRef.current) {
      if (key.return) {
        const currentSessions = sessionsRef.current;
        const currentIdx = selectedSessionIdxRef.current;
        if (currentSessions.length > 0 && currentIdx < currentSessions.length) {
          onResumeSession?.(currentSessions[currentIdx]!.id);
          setShowSessionList(false);
          setSelectedSessionIdx(0);
          // 清除当前消息显示，切换到新 session
          setMessages([]);
        }
        return;
      }
      if (key.upArrow) {
        setSelectedSessionIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedSessionIdx((prev) => Math.min(sessionsRef.current.length - 1, prev + 1));
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
    if (showSlashMenuRef.current) {
      if (key.return) {
        // 发送用户当前输入的完整文本（如 "/ctx compact"）
        const fullInput = inputRef.current;
        if (fullInput) {
          submitCommand(fullInput);
        }
        setShowSlashMenu(false);
        setSlashFilter("");
        setSelectedCmdIdx(0);
        showSlashMenuRef.current = false;
        return;
      }
      if (key.upArrow) {
        setSelectedCmdIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedCmdIdx((prev) => {
          const cmdsLen = filteredCommands().length;
          return Math.min(cmdsLen - 1, prev + 1);
        });
        return;
      }
      if (key.backspace || key.delete) {
        const currentFilter = slashFilterRef.current;
        if (currentFilter.length > 0) {
          const newFilter = currentFilter.slice(0, -1);
          setSlashFilter(newFilter);
          setInput("/" + newFilter);
          setCursorPos(1 + newFilter.length);
          setSelectedCmdIdx(0);
        } else {
          setShowSlashMenu(false);
          setSlashFilter("");
          setSelectedCmdIdx(0);
          showSlashMenuRef.current = false;
          setInput("");
          setCursorPos(0);
        }
        return;
      }
      if (key.escape) {
        setShowSlashMenu(false);
        setSlashFilter("");
        setSelectedCmdIdx(0);
        showSlashMenuRef.current = false;
        return;
      }
      if (inputChar && !key.ctrl && !key.meta) {
        const newFilter = slashFilterRef.current + inputChar;
        setSlashFilter(newFilter);
        setInput("/" + newFilter);
        setCursorPos(1 + newFilter.length);
        setSelectedCmdIdx(0);

        // 如果输入了空格，关闭菜单，后续回车走正常提交流程
        if (inputChar === " ") {
          setShowSlashMenu(false);
          showSlashMenuRef.current = false;
        }
        return;
      }
      return;
    }

    // Ctrl+O: 全局切换所有折叠组的展开/折叠
    if (key.ctrl && inputChar === "o") {
      setGroupsCollapsed((prev) => !prev);
      return;
    }

    // Enter: 提交输入
    if (key.return) {
      // 直接读取最新的 input 值提交
      setInput((currentInput) => {
        const text = currentInput.trim();
        if (!text || isStreamingRef.current) return currentInput;
        // 在 setState 的 functional update 中异步执行提交
        Promise.resolve().then(() => {
          setShowSlashMenu(false);
          setSlashFilter("");

          // 保存到历史
          inputHistory.current.push(text);
          if (inputHistory.current.length > 100) {
            inputHistory.current = inputHistory.current.slice(-100);
          }
          historyIndex.current = -1;

          if (text.startsWith("/")) {
            submitCommand(text);
          } else {
            setIsStreaming(true);
            agent.prompt(text).catch((err: unknown) => {
              setMessages((prev) => [
                ...prev,
                { role: "error" as const, text: err instanceof Error ? err.message : String(err), isStreaming: false, toolCalls: [], toolResults: [] },
              ]);
            }).finally(() => {
              setIsStreaming(false);
            });
          }
        });
        return ""; // 清空输入框
      });
      setCursorPos(0);
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
      setCursorPos((prev) => Math.min(inputRef.current.length, prev + 1));
      return;
    }
    if (inputChar === "a" && key.ctrl) {
      historyIndex.current = -1;
      setCursorPos(0);
      return;
    }
    if (inputChar === "e" && key.ctrl) {
      historyIndex.current = -1;
      setCursorPos(inputRef.current.length);
      return;
    }

    // Backspace: 在光标位置删除
    if (key.backspace || key.delete) {
      historyIndex.current = -1;
      const curPos = cursorPosRef.current;
      if (curPos > 0) {
        setInput((prev) => {
          const before = prev.slice(0, curPos - 1);
          const after = prev.slice(curPos);
          const newInput = before + after;
          // 检查斜杠菜单
          if (newInput.startsWith("/") && !newInput.includes(" ")) {
            setShowSlashMenu(true);
            setSlashFilter(newInput.slice(1));
            setSelectedCmdIdx(0);
          }
          return newInput;
        });
        setCursorPos((prev) => Math.max(0, prev - 1));
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
      // 先计算新光标位置，再更新 input，React 18 会自动 batch 为一次 render
      const curPos = cursorPosRef.current;
      const newCursorPos = curPos + inputChar.length;
      setInput((prev) => {
        const before = prev.slice(0, curPos);
        const after = prev.slice(curPos);
        const newInput = before + inputChar + after;

        // 如果输入了 / 且没有空格，显示斜杠菜单
        // 空格处理统一在斜杠菜单模式分支中完成
        if (newInput.startsWith("/") && !newInput.includes(" ")) {
          setShowSlashMenu(true);
          setSlashFilter(newInput.slice(1));
          setSelectedCmdIdx(0);
        }

        return newInput;
      });
      setCursorPos(newCursorPos);
      return;
    }
  });

  // 输入完成后校正光标位置，解决 IME 中文输入时光标错位问题
  // 每次 input 长度变化时校正光标，避免 IME 合成后光标超出范围
  const prevInputLenRef = useRef(input.length);
  useEffect(() => {
    if (input.length !== prevInputLenRef.current) {
      prevInputLenRef.current = input.length;
      setCursorPos((prev) => Math.min(prev, input.length));
    }
  }, [input]);

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

      {/* Notifications */}
      {notifications.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {notifications.map((n) => (
            <Text key={n.id} color={n.type === "error" ? "red" : n.type === "warning" ? "yellow" : "cyan"}>
              [{n.type.toUpperCase()}] {n.text}
            </Text>
          ))}
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
        {mergeMessageGroups(messages).map((group) => {
          return group.type === "group" ? (
            <CollapsibleGroup
              key={`group-${group.index}`}
              items={group.items}
              collapsed={groupsCollapsed}
              onToggle={() => setGroupsCollapsed((prev) => !prev)}
            />
          ) : (
            <MessageView key={`msg-${group.index}`} item={group.item} />
          );
        })}
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
  collapsed,
  onToggle,
}: {
  items: MessageItem[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const first = items[0]!;
  const toolCount = items.filter((m) => m.role === "toolResult").length;
  const hasReasoning = items.some((m) => m.reasoning);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 始终显示 assistant 主文本 */}
      <MessageView item={first} />

      {/* 当有 toolResult 或 reasoning 时，显示折叠控制栏 */}
      {(toolCount > 0 || hasReasoning) && (
        <>
          <Box paddingLeft={1}>
            <Text>
              <Text
                color={collapsed ? "gray" : "yellow"}
                bold
              >
                {collapsed ? "▶" : "▼"}
              </Text>{" "}
              <Text color="gray">
                {collapsed
                  ? `${toolCount} tool call${toolCount !== 1 ? "s" : ""}${hasReasoning ? " + reasoning" : ""} (Ctrl+O to expand)`
                  : "Details:"
                }
              </Text>
            </Text>
          </Box>
          {/* 展开时才显示 toolResult 和 reasoning */}
          {!collapsed && items.slice(1).map((item, i) => (
            <MessageView key={i} item={item} />
          ))}
        </>
      )}
    </Box>
  );
});

// ---------------------------------------------------------------------------
// Markdown 渲染（基于 marked）
// ---------------------------------------------------------------------------

const MarkdownText = memo(function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = useMemo(() => marked.lexer(markdown, {
    async: false,
    gfm: true,
  }), [markdown]);

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock key={`${token.type}-${index}`} token={token} />
      ))}
    </Box>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({ token }: { token: Token }) {
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
});

const InlineMarkdown = memo(function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
});

const InlineMarkdownToken = memo(function InlineMarkdownToken({ token }: { token: Token }) {
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
});

function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderPlainTable(token: Tokens.Table): string {
  const rows: string[][] = [];
  // 表头
  rows.push(token.header.map((cell) => cell.text));
  // 分隔行（用 --- 占位）
  rows.push(token.header.map(() => "---"));
  // 数据行
  for (const row of token.rows) {
    rows.push(row.map((cell) => cell.text));
  }

  // 计算每列最大宽度
  const colCount = rows[0]?.length ?? 0;
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let maxW = 0;
    for (const row of rows) {
      const cell = row[c] ?? "";
      // 一个中文字符算 2 个宽度（终端等宽字体下对齐更准确）
      let w = 0;
      for (const ch of cell) {
        w += ch.charCodeAt(0) > 127 ? 2 : 1;
      }
      if (w > maxW) maxW = w;
    }
    colWidths.push(maxW);
  }

  // 格式化输出
  return rows.map((row, ri) => {
    if (ri === 1) {
      // 分隔行
      return colWidths.map((w) => "-".repeat(w)).join("-+-");
    }
    const cells = row.map((cell, ci) => {
      const w = colWidths[ci] ?? 0;
      const text = cell ?? "";
      // 计算实际显示宽度
      let displayW = 0;
      for (const ch of text) {
        displayW += ch.charCodeAt(0) > 127 ? 2 : 1;
      }
      // 填充空格
      return text + " ".repeat(Math.max(0, w - displayW));
    });
    return " " + cells.join(" | ") + " ";
  }).join("\n");
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
    onNotify?: (message: string, type?: "info" | "warning" | "error") => void;
    onSetInitialMessages?: (setter: (messages: AgentMessage[]) => void) => void;
    onReloadPlugins?: () => Promise<void>;
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
      onNotify={options?.onNotify}
      onSetInitialMessages={options?.onSetInitialMessages}
      onReloadPlugins={options?.onReloadPlugins}
    />,
    { exitOnCtrlC: true },
  );
  await waitUntilExit;
}
