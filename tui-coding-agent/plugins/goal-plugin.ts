/**
 * Goal Plugin
 *
 * Codex-style persistent session goal.
 * 功能完全参考 pi-mono-extensions/goal。
 *
 * 命令：
 *   /goal <text>         — 创建/设置目标
 *   /goal show           — 查看当前目标
 *   /goal edit <text>    — 编辑目标内容
 *   /goal update <note>  — 记录进度
 *   /goal pause          — 暂停
 *   /goal resume         — 恢复
 *   /goal done <note>    — 标记完成
 *   /goal blocked <reason> — 标记阻塞
 *   /goal clear          — 清除目标
 *   /goal auto on|off    — 开启/关闭自动延续
 *   /goal mode manual|assist|auto — 设置模式
 *   /goal budget <kind> <n> — 设置预算
 *   /goal help           — 显示帮助
 *
 * LLM 工具：
 *   get_goal    — 查看当前目标状态
 *   create_goal — 创建/形式化目标
 *   update_goal — 更新进度、状态、预算
 *
 * 参考：https://github.com/emanuelcasco/pi-mono-extensions/tree/main/extensions/goal
 */

import type { ExtensionAPI, PluginCommandContext, PluginContext } from "../src/types.js";

// ============================================================================
// 类型定义
// ============================================================================

type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";
type GoalMode = "manual" | "assist" | "auto";

interface GoalBudgets {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
}

interface GoalAccounting {
  assistantTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  startedAt: string;
  lastTurnAt?: string;
}

interface GoalState {
  goalId: string;
  text: string;
  status: GoalStatus;
  mode: GoalMode;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  nextAction?: string;
  blockers: string[];
  budgets: GoalBudgets;
  accounting: GoalAccounting;
  noProgressTurns: number;
  lastProgressAt?: string;
  lastContinuationAt?: string;
  lastContinuationReason?: string;
}

/** 存储在 session JSONL 中的事件 */
type GoalEvent =
  | { kind: "created"; goalId: string; text: string; mode: GoalMode; budgets: GoalBudgets; at: string }
  | { kind: "updated"; goalId: string; patch: Partial<Pick<GoalState, "text" | "summary" | "nextAction" | "blockers" | "mode" | "budgets">>; note?: string; at: string }
  | { kind: "status"; goalId: string; status: GoalStatus; reason?: string; at: string }
  | { kind: "accounting"; goalId: string; delta: Partial<GoalAccounting>; at: string }
  | { kind: "continuation"; goalId: string; action: "queued" | "skipped" | "stopped"; reason: string; at: string };

const GOAL_EVENT_TYPE = "goal-event";
const QUESTION_RE = /\?\s*$|\b(please confirm|need your approval|waiting for you|which option|what would you like|provide|please share)\b/i;
let cachedState: GoalState | undefined;

// ============================================================================
// 工具函数
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function newGoalId(): string {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isTerminalStatus(s: GoalStatus): boolean {
  return s === "completed" || s === "cancelled" || s === "blocked";
}

function isSteeringActive(state: GoalState | undefined): state is GoalState {
  return Boolean(state && state.status === "active" && (state.mode === "assist" || state.mode === "auto"));
}

function totalTokens(acc: GoalAccounting): number {
  return acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
}

function budgetExceeded(state: GoalState): string | undefined {
  const { budgets, accounting } = state;
  if (budgets.maxTurns !== undefined && accounting.assistantTurns >= budgets.maxTurns) return "turn budget exceeded";
  if (budgets.maxToolCalls !== undefined && accounting.toolCalls >= budgets.maxToolCalls) return "tool-call budget exceeded";
  if (budgets.maxTokens !== undefined && totalTokens(accounting) >= budgets.maxTokens) return "token budget exceeded";
  if (budgets.maxCostUsd !== undefined && accounting.costUsd >= budgets.maxCostUsd) return "cost budget exceeded";
  if (budgets.maxWallMs !== undefined) {
    const elapsed = Date.now() - Date.parse(accounting.startedAt);
    if (elapsed >= budgets.maxWallMs) return "wall-clock budget exceeded";
  }
  return undefined;
}

function defaultBudgets(mode: GoalMode, budgets: GoalBudgets = {}): GoalBudgets {
  return { ...(mode === "auto" ? { maxTurns: 10, maxWallMs: 30 * 60_000 } : {}), ...budgets };
}

function initialAccounting(at: string): GoalAccounting {
  return { assistantTurns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, startedAt: at };
}

// ============================================================================
// 事件应用
// ============================================================================

function applyGoalEvent(state: GoalState | undefined, event: GoalEvent): GoalState | undefined {
  if (event.kind === "created") {
    return {
      goalId: event.goalId,
      text: event.text,
      status: "active",
      mode: event.mode,
      createdAt: event.at,
      updatedAt: event.at,
      blockers: [],
      budgets: event.budgets,
      accounting: initialAccounting(event.at),
      noProgressTurns: 0,
    };
  }
  if (!state || state.goalId !== event.goalId) return state;

  switch (event.kind) {
    case "updated": {
      const progressChanged = Boolean(event.note || event.patch.summary || event.patch.nextAction);
      return {
        ...state,
        ...event.patch,
        budgets: event.patch.budgets ? { ...state.budgets, ...event.patch.budgets } : state.budgets,
        updatedAt: event.at,
        noProgressTurns: progressChanged ? 0 : state.noProgressTurns,
        lastProgressAt: progressChanged ? event.at : state.lastProgressAt,
      };
    }
    case "status":
      return {
        ...state,
        status: event.status,
        updatedAt: event.at,
        blockers: event.status === "blocked" && event.reason ? [...state.blockers, event.reason] : state.blockers,
        summary: event.status === "completed" && event.reason ? event.reason : state.summary,
      };
    case "accounting":
      return {
        ...state,
        updatedAt: event.at,
        accounting: {
          ...state.accounting,
          assistantTurns: state.accounting.assistantTurns + (event.delta.assistantTurns ?? 0),
          toolCalls: state.accounting.toolCalls + (event.delta.toolCalls ?? 0),
          inputTokens: state.accounting.inputTokens + (event.delta.inputTokens ?? 0),
          outputTokens: state.accounting.outputTokens + (event.delta.outputTokens ?? 0),
          cacheReadTokens: state.accounting.cacheReadTokens + (event.delta.cacheReadTokens ?? 0),
          cacheWriteTokens: state.accounting.cacheWriteTokens + (event.delta.cacheWriteTokens ?? 0),
          costUsd: state.accounting.costUsd + (event.delta.costUsd ?? 0),
          lastTurnAt: event.delta.lastTurnAt ?? state.accounting.lastTurnAt,
        },
      };
    case "continuation":
      return {
        ...state,
        updatedAt: event.at,
        lastContinuationAt: event.action === "queued" ? event.at : state.lastContinuationAt,
        lastContinuationReason: event.reason,
        noProgressTurns: event.action === "queued" ? state.noProgressTurns + 1 : state.noProgressTurns,
      };
  }
  return state;
}

function reconstructGoal(api: ExtensionAPI): GoalState | undefined {
  const entries = api.getCustomEntries(GOAL_EVENT_TYPE);
  let state: GoalState | undefined;
  for (const { data } of entries) {
    state = applyGoalEvent(state, data as GoalEvent);
  }
  cachedState = state;
  return state;
}

// ============================================================================
// 格式化
// ============================================================================

function truncate(text: string | undefined, max = 80): string {
  if (!text) return "—";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatMoney(value: number): string {
  return value === 0 ? "$0" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatBudgetSummary(state: GoalState): string {
  const parts: string[] = [];
  if (state.budgets.maxTurns !== undefined) parts.push(`turns ${state.accounting.assistantTurns}/${state.budgets.maxTurns}`);
  else parts.push(`turns ${state.accounting.assistantTurns}`);
  if (state.budgets.maxToolCalls !== undefined) parts.push(`tools ${state.accounting.toolCalls}/${state.budgets.maxToolCalls}`);
  if (state.budgets.maxTokens !== undefined) parts.push(`tokens ${totalTokens(state.accounting)}/${state.budgets.maxTokens}`);
  else if (totalTokens(state.accounting) > 0) parts.push(`tokens ${totalTokens(state.accounting)}`);
  if (state.budgets.maxCostUsd !== undefined) parts.push(`cost ${formatMoney(state.accounting.costUsd)}/${formatMoney(state.budgets.maxCostUsd)}`);
  else if (state.accounting.costUsd > 0) parts.push(`cost ${formatMoney(state.accounting.costUsd)}`);
  return parts.join(" · ");
}

function formatGoalLines(state: GoalState | undefined): string[] {
  if (!state) return ["No goal set. Use /goal <text> to create one."];
  const lines = [
    `Goal: ${truncate(state.text, 96)}`,
    `Status: ${state.status}  Mode: ${state.mode}  Budget: ${formatBudgetSummary(state)}`,
  ];
  if (state.summary) lines.push(`Progress: ${truncate(state.summary, 96)}`);
  if (state.nextAction) lines.push(`Next: ${truncate(state.nextAction, 80)}`);
  if (state.blockers.length > 0) lines.push(`Blockers: ${truncate(state.blockers.join("; "), 96)}`);
  lines.push(`Updated: ${state.updatedAt}`);
  return lines;
}

function formatGoalMarkdown(state: GoalState | undefined): string {
  if (!state) return "No goal set. Use /goal <text> or create_goal to create one.";
  const lines = ["# Goal", "", `- **Goal:** ${state.text}`, `- **Status:** ${state.status}`, `- **Mode:** ${state.mode}`, `- **Created:** ${state.createdAt}`, `- **Updated:** ${state.updatedAt}`, `- **Budget:** ${formatBudgetSummary(state)}`];
  if (state.summary) lines.push(`- **Progress:** ${state.summary}`);
  if (state.nextAction) lines.push(`- **Next action:** ${state.nextAction}`);
  if (state.blockers.length > 0) lines.push(`- **Blockers:** ${state.blockers.join("; ")}`);
  return lines.join("\n");
}

function parseBudgetPatch(kind: string, value: string): Partial<GoalBudgets> | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  if (kind === "turns") return { maxTurns: Math.floor(amount) };
  if (kind === "tools") return { maxToolCalls: Math.floor(amount) };
  if (kind === "tokens") return { maxTokens: Math.floor(amount) };
  if (kind === "cost") return { maxCostUsd: amount };
  if (kind === "time" || kind === "wall") return { maxWallMs: Math.floor(amount * 60_000) };
  return undefined;
}

function commandUsage(): string {
  return [
    "Usage: /goal [subcommand]",
    "",
    "  /goal <text>           Create a new goal",
    "  /goal show             Show current goal",
    "  /goal edit <text>      Edit goal text",
    "  /goal update <note>    Record progress",
    "  /goal pause            Pause goal",
    "  /goal resume           Resume goal",
    "  /goal done <note>      Mark completed",
    "  /goal blocked <reason> Mark blocked",
    "  /goal clear            Clear goal",
    "  /goal auto on|off      Toggle auto-continuation",
    "  /goal mode manual|assist|auto  Set mode",
    "  /goal budget <kind> <n>  Set budget (turns, tools, tokens, cost, time)",
    "  /goal help             Show this help",
  ].join("\n");
}

// ============================================================================
// 提示词
// ============================================================================

function buildGoalSteeringPrompt(state: GoalState): string {
  const planLines = state.nextAction ? `Next action: ${state.nextAction}` : "Next action: infer the next useful action";
  return [
    "[GOAL ACTIVE]",
    `Goal: ${state.text}`,
    `Mode: ${state.mode}`,
    `Status: ${state.status}`,
    `Progress: ${state.summary ?? "(no progress summary yet)"}`,
    planLines,
    `Budgets: ${formatBudgetSummary(state)}`,
    "",
    "Instructions:",
    "- Keep working toward this goal unless the user explicitly changes direction.",
    "- Call get_goal if you need the current structured state.",
    "- Call update_goal after meaningful progress, on blockers, and on completion.",
    "- If the goal is complete, call update_goal with status=completed and a concise summary.",
    "- If blocked by missing information, approval, budget, or unsafe action, call update_goal with status=blocked and explain the blocker.",
    "- Do not continue autonomously when user input or approval is required.",
  ].join("\n");
}

function buildGoalContinuationPrompt(state: GoalState): string {
  return [
    "[GOAL CONTINUATION]",
    "Continue working toward the active goal.",
    "",
    `Goal: ${state.text}`,
    `Progress: ${state.summary ?? "(no progress summary yet)"}`,
    `Next action: ${state.nextAction ?? "infer the next useful action"}`,
    `Budgets: ${formatBudgetSummary(state)}`,
    "",
    "Inspect get_goal if needed, perform the next useful action, and update_goal when progress, blockers, or completion change. Stop and mark the goal blocked if user input, approval, credentials, or a budget increase is needed.",
  ].join("\n");
}

// ============================================================================
// 命令处理
// ============================================================================

function isKnownSubcommand(value: string): boolean {
  return ["show", "status", "view", "help", "create", "set", "edit", "update", "pause", "resume",
    "done", "complete", "block", "cancel", "clear", "auto", "mode", "budget"].includes(value);
}

async function handleGoalCommand(args: string, pi: ExtensionAPI, ctx: PluginCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const trimmed = args.trim();
  const state = reconstructGoal(pi);

  if (!trimmed || ["show", "status", "view"].includes(trimmed)) {
    ctx.notify(formatGoalLines(state).join("\n"), "info");
    return;
  }

  if (trimmed === "help") {
    ctx.notify(commandUsage(), "info");
    return;
  }

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]!.toLowerCase();
  const restText = parts.slice(1).join(" ").trim();

  // create / set / 直接文本
  if (["create", "set"].includes(subcommand) || !isKnownSubcommand(subcommand)) {
    const text = ["create", "set"].includes(subcommand) ? restText : trimmed;
    if (!text) { ctx.notify("Goal text is required.", "warning"); return; }
    if (state && !isTerminalStatus(state.status)) {
      ctx.notify("A non-terminal goal already exists. Use /goal edit, /goal done, /goal pause, or /goal clear first.", "warning");
      return;
    }
    const at = nowIso();
    const goalId = newGoalId();
    const event: GoalEvent = { kind: "created", goalId, text, mode: "assist", budgets: defaultBudgets("assist"), at };
    pi.appendEntry(GOAL_EVENT_TYPE, event);
    const created = applyGoalEvent(undefined, event);
    cachedState = created;
    ctx.notify(formatGoalLines(created).join("\n"), "info");
    return;
  }

  if (!state) {
    ctx.notify("No goal set. Use /goal <text> to create one.", "warning");
    return;
  }

  const at = nowIso();

  switch (subcommand) {
    case "edit": {
      if (!restText) { ctx.notify("Usage: /goal edit <new goal text>", "warning"); return; }
      const event: GoalEvent = { kind: "updated", goalId: state.goalId, patch: { text: restText }, note: "Goal text edited by user", at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const updated = applyGoalEvent(state, event);
      cachedState = updated;
      ctx.notify(`Goal updated:\n${formatGoalLines(updated).join("\n")}`, "info");
      return;
    }
    case "update": {
      if (!restText) { ctx.notify("Usage: /goal update <progress note>", "warning"); return; }
      const event: GoalEvent = { kind: "updated", goalId: state.goalId, patch: { summary: restText }, note: restText, at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const updated = applyGoalEvent(state, event);
      cachedState = updated;
      ctx.notify(`Progress recorded:\n${formatGoalLines(updated).join("\n")}`, "info");
      return;
    }
    case "pause":
      pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "paused" as GoalStatus, reason: restText || "paused by user", at });
      cachedState = applyGoalEvent(state, { kind: "status", goalId: state.goalId, status: "paused", reason: restText || "paused by user", at });
      ctx.notify(`Goal paused. Resume with /goal resume.`, "info");
      return;
    case "resume":
      pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "active" as GoalStatus, reason: restText || "resumed by user", at });
      cachedState = applyGoalEvent(state, { kind: "status", goalId: state.goalId, status: "active", reason: restText || "resumed by user", at });
      ctx.notify(`Goal resumed in ${state.mode} mode.`, "info");
      return;
    case "done":
    case "complete":
      pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "completed" as GoalStatus, reason: restText || "completed by user", at });
      cachedState = applyGoalEvent(state, { kind: "status", goalId: state.goalId, status: "completed", reason: restText || "completed by user", at });
      ctx.notify("Goal completed.", "info");
      return;
    case "block":
      pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "blocked" as GoalStatus, reason: restText || "blocked by user", at });
      cachedState = applyGoalEvent(state, { kind: "status", goalId: state.goalId, status: "blocked", reason: restText || "blocked by user", at });
      ctx.notify("Goal blocked.", "warning");
      return;
    case "cancel":
    case "clear":
      pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "cancelled" as GoalStatus, reason: subcommand === "clear" ? "cleared by user" : "cancelled by user", at });
      cachedState = applyGoalEvent(state, { kind: "status", goalId: state.goalId, status: "cancelled", reason: subcommand === "clear" ? "cleared by user" : "cancelled by user", at });
      ctx.notify(subcommand === "clear" ? "Goal cleared." : "Goal cancelled.", "info");
      return;
    case "auto": {
      if (restText !== "on" && restText !== "off") { ctx.notify("Usage: /goal auto on|off", "warning"); return; }
      const mode: GoalMode = restText === "on" ? "auto" : "assist";
      const event: GoalEvent = { kind: "updated", goalId: state.goalId, patch: { mode, budgets: defaultBudgets(mode, state.budgets) }, note: `auto ${restText}`, at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const updated = applyGoalEvent(state, event);
      cachedState = updated;
      ctx.notify(`Goal mode set to ${updated?.mode ?? mode}.`, "info");
      return;
    }
    case "mode": {
      if (!["manual", "assist", "auto"].includes(restText)) { ctx.notify("Usage: /goal mode manual|assist|auto", "warning"); return; }
      const mode = restText as GoalMode;
      const event: GoalEvent = { kind: "updated", goalId: state.goalId, patch: { mode, budgets: defaultBudgets(mode, state.budgets) }, note: `mode ${mode}`, at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const updated = applyGoalEvent(state, event);
      cachedState = updated;
      ctx.notify(`Goal mode set to ${mode}.`, "info");
      return;
    }
    case "budget": {
      const [kind = "", val = ""] = restText.split(/\s+/);
      const budgetPatch = parseBudgetPatch(kind, val);
      if (!budgetPatch) { ctx.notify("Usage: /goal budget turns|tools|tokens|cost|time <number>", "warning"); return; }
      const event: GoalEvent = { kind: "updated", goalId: state.goalId, patch: { budgets: budgetPatch }, note: `budget ${kind} ${val}`, at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const updated = applyGoalEvent(state, event);
      cachedState = updated;
      ctx.notify(`Budget updated: ${formatGoalLines(updated).join("\n")}`, "info");
      return;
    }
    default:
      ctx.notify(commandUsage(), "warning");
  }
}

// ============================================================================
// 插件入口
// ============================================================================

export default function goalPlugin(pi: ExtensionAPI): void {
  // session_start 事件读取持久化的 goal
  pi.on("session_start", () => {
    reconstructGoal(pi);
  });

  // /goal 命令
  pi.registerCommand("goal", async (ctx, args) => {
    await handleGoalCommand(args, pi, ctx);
  }, "Codex-style persistent session goal: /goal <text>, /goal show, /goal pause/resume/clear/edit, /goal auto on");

  // get_goal 工具
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Inspect the active session goal, progress, budgets, and accounting.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const state = cachedState ?? reconstructGoal(pi);
      return { content: [{ type: "text" as const, text: formatGoalMarkdown(state) }], details: { ok: true, goal: state } };
    },
  });

  // create_goal 工具
  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a persistent session goal with optional mode and budgets.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Goal text" },
        mode: { type: "string", enum: ["manual", "assist", "auto"], description: "Goal mode (default assist)" },
        replace: { type: "boolean", description: "Replace an existing active goal" },
        maxTurns: { type: "number", description: "Max assistant turns" },
        maxToolCalls: { type: "number", description: "Max tool calls" },
        maxCostUsd: { type: "number", description: "Max cost in USD" },
        maxTokens: { type: "number", description: "Max tokens" },
        maxWallMs: { type: "number", description: "Max wall clock time in ms" },
      },
      required: ["goal"],
    },
    execute: async (_toolCallId, params) => {
      const state = cachedState ?? reconstructGoal(pi);
      if (!params.goal?.trim()) return { content: [{ type: "text" as const, text: "Goal text is required." }], details: { ok: false } };
      if (state && !isTerminalStatus(state.status) && !params.replace) {
        return { content: [{ type: "text" as const, text: "A non-terminal goal already exists. Pass replace=true to replace it." }], details: { ok: false, goal: state } };
      }
      if (state && params.replace && !isTerminalStatus(state.status)) {
        const cancelAt = nowIso();
        pi.appendEntry(GOAL_EVENT_TYPE, { kind: "status", goalId: state.goalId, status: "cancelled" as GoalStatus, reason: "replaced by create_goal", at: cancelAt });
        cachedState = applyGoalEvent(cachedState, { kind: "status", goalId: state.goalId, status: "cancelled", reason: "replaced by create_goal", at: cancelAt });
      }
      const at = nowIso();
      const goalId = newGoalId();
      const mode = (params.mode as GoalMode) ?? "assist";
      const budgets: GoalBudgets = { maxTurns: params.maxTurns, maxToolCalls: params.maxToolCalls, maxCostUsd: params.maxCostUsd, maxTokens: params.maxTokens, maxWallMs: params.maxWallMs };
      const event: GoalEvent = { kind: "created", goalId, text: params.goal, mode, budgets: defaultBudgets(mode, budgets), at };
      pi.appendEntry(GOAL_EVENT_TYPE, event);
      const created = applyGoalEvent(undefined, event);
      cachedState = created;
      return { content: [{ type: "text" as const, text: formatGoalMarkdown(created) }], details: { ok: true, goal: created } };
    },
  });

  // update_goal 工具
  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Update goal progress, next action, blockers, mode, budgets, or terminal status.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "paused", "blocked", "completed", "cancelled"], description: "New status" },
        summary: { type: "string", description: "Progress summary" },
        progressNote: { type: "string", description: "Progress note" },
        nextAction: { type: "string", description: "Next action to take" },
        blockers: { type: "array", items: { type: "string" }, description: "List of blockers" },
        mode: { type: "string", enum: ["manual", "assist", "auto"], description: "Goal mode" },
        maxTurns: { type: "number", description: "Max assistant turns" },
        maxToolCalls: { type: "number", description: "Max tool calls" },
        maxCostUsd: { type: "number", description: "Max cost in USD" },
        maxTokens: { type: "number", description: "Max tokens" },
        maxWallMs: { type: "number", description: "Max wall clock time in ms" },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      const state = cachedState ?? reconstructGoal(pi);
      if (!state) return { content: [{ type: "text" as const, text: "No active goal. Use create_goal first." }], details: { ok: false } };

      const at = nowIso();
      let current = state;

      // 构建 patch
      const patch: Record<string, unknown> = {};
      if (params.summary ?? params.progressNote) patch.summary = params.summary ?? params.progressNote;
      if (params.nextAction) patch.nextAction = params.nextAction;
      if (params.blockers) patch.blockers = params.blockers;
      if (params.mode) patch.mode = params.mode;
      const budgets: GoalBudgets = {};
      if (params.maxTurns !== undefined) budgets.maxTurns = params.maxTurns;
      if (params.maxToolCalls !== undefined) budgets.maxToolCalls = params.maxToolCalls;
      if (params.maxCostUsd !== undefined) budgets.maxCostUsd = params.maxCostUsd;
      if (params.maxTokens !== undefined) budgets.maxTokens = params.maxTokens;
      if (params.maxWallMs !== undefined) budgets.maxWallMs = params.maxWallMs;
      if (Object.keys(budgets).length > 0) patch.budgets = budgets;

      if (Object.keys(patch).length > 0) {
        const updateEvent: GoalEvent = { kind: "updated", goalId: state.goalId, patch, note: params.progressNote, at };
        pi.appendEntry(GOAL_EVENT_TYPE, updateEvent);
        current = applyGoalEvent(current, updateEvent)!;
      }

      if (params.status) {
        const statusEvent: GoalEvent = { kind: "status", goalId: state.goalId, status: params.status as GoalStatus, reason: params.summary ?? params.progressNote, at };
        pi.appendEntry(GOAL_EVENT_TYPE, statusEvent);
        current = applyGoalEvent(current, statusEvent)!;
      }

      cachedState = current;
      return { content: [{ type: "text" as const, text: formatGoalMarkdown(current) }], details: { ok: true, goal: current } };
    },
  });
}
