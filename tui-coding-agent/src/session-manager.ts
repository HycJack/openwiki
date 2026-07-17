/**
 * SessionManager — 会话生命周期管理（参考 pi-mono 的 session manager）
 *
 * 职责：
 * 1. 应用启动时自动加载/创建最新 session
 * 2. 每轮结束时自动保存消息
 * 3. /session <id> 切换时重建 agent._messages
 * 4. 为 /tree、/fork、/sessions 提供数据
 */

import {
  getOrCreateLatestSession,
  listSessions,
  loadSessionMeta,
  loadSessionEntries,
  appendSessionEntry,
  appendCompactionEntry,
  createSession,
  extractMessages,
  buildTree,
  renderTreeAsText,
  forkFromEntry,
  updateSessionMeta,
  type SessionEntry,
  type SessionMeta,
} from "./session-store.js";
import { sessionDir, sessionFilePath } from "./session-paths.js";
import type { AgentMessage } from "./types.js";
import type { CompactionEntry } from "./compaction.js";

export interface SessionManagerOptions {
  cwd: string;
  modelId: string;
}

export class SessionManager {
  readonly cwd: string;
  readonly modelId: string;

  /** 当前 session ID */
  private _sessionId: string = "";
  /** 当前 session 的所有 entry（含 compaction entry） */
  private _entries: SessionEntry[] = [];
  /** 当前 session 的 meta */
  private _meta: SessionMeta | null = null;
  /** 是否为新 session */
  private _isNew: boolean = false;
  /** 最近一次追加的 entry ID（用于 parentId 链） */
  private _lastEntryId: string | null = null;
  /** agent_end 后更新的消息列表（用于保存） */
  private _pendingMessages: AgentMessage[] = [];
  /** 正在进行的 flush Promise（用于 switchTo/createNew 等待） */
  private _pendingFlush: Promise<void> = Promise.resolve();
  /** 自动保存开关 */
  autoSave = true;

  constructor(options: SessionManagerOptions) {
    this.cwd = options.cwd;
    this.modelId = options.modelId;
  }

  /** 当前 session ID */
  get sessionId(): string {
    return this._sessionId;
  }

  /** 当前是否为新创建会话 */
  get isNew(): boolean {
    return this._isNew;
  }

  /** 当前 session 的所有 entry */
  get entries(): SessionEntry[] {
    return this._entries;
  }

  /** 当前 session meta */
  get meta(): SessionMeta | null {
    return this._meta;
  }

  /** 当前分支的消息列表（非 compaction entry） */
  get branchMessages(): AgentMessage[] {
    return extractMessages(this._entries);
  }

  /** 按 id 查找 entry */
  getEntryById(id: string): SessionEntry | undefined {
    return this._entries.find((e) => {
      const entry = e as SessionEntry;
      return "id" in entry && (entry as { id: string }).id === id;
    });
  }

  // ============================================================================
  // 初始化
  // ============================================================================

  /**
   * 初始化 session：加载现有最新 session 或创建新的。
   * 返回 session 中的消息列表（用于设置 agent._messages）。
   */
  async init(): Promise<AgentMessage[]> {
    const result = await getOrCreateLatestSession(this.cwd, this.modelId);
    this._sessionId = result.sessionId;
    this._entries = result.entries;
    this._isNew = result.isNew;
    this._meta = await loadSessionMeta(this.cwd, this._sessionId);
    this._lastEntryId = this._meta?.currentEntryId ?? null;

    // 找到消息链中的最后一条 entryId（用于后续追加 parentId）
    this._refreshLastEntryId();

    // 返回纯消息（过滤 compaction）
    return result.isNew ? [] : this.branchMessages;
  }

  // ============================================================================
  // 消息保存
  // ============================================================================

  /**
   * 记录一轮对话结束后的消息列表。
   * agent_end 时调用此方法，flush 会在 onIdle 时自动保存。
   */
  setMessages(messages: AgentMessage[]): void {
    this._pendingMessages = messages;
  }

  /**
   * 设置消息并调度 flush（链式调用，避免并发问题）。
   * 用于 agent_end 事件处理。
   */
  scheduleFlush(messages: AgentMessage[]): void {
    this._pendingMessages = messages;
    this._pendingFlush = this._pendingFlush
      .catch(() => {})
      .then(() => this.flush())
      .catch(() => {});
  }

  /**
   * 将 pending messages 保存到 session 文件。
   * 自动对比当前 entries 找出新消息并追加。
   * 捕获快照避免并发 switchTo 导致写错文件。
   */
  async flush(): Promise<void> {
    if (!this.autoSave || this._pendingMessages.length === 0) return;

    // 捕获快照，防止 flush 执行期间 switchTo 修改状态
    const sessionId = this._sessionId;
    const entries = this._entries;
    const lastEntryId = this._lastEntryId;
    const pendingMessages = this._pendingMessages;
    // 立即清空 pending，避免重复保存
    this._pendingMessages = [];

    // 计算已保存的消息数（compaction 感知）
    // 参考 pi-mono：如果有 CompactionEntry，summaryMsg 对应 compaction entry，
    // 所以 savedCount = compaction entry 数 + compaction 之后的纯消息数
    // 如果没有 compaction，savedCount = 全部纯消息数
    let savedCount: number;
    let lastCompactionIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if ((entries[i] as { type?: string }).type === "compaction") {
        lastCompactionIdx = i;
        break;
      }
    }

    if (lastCompactionIdx >= 0) {
      // 有 compaction：agent._messages = [summaryMsg, ...keptMessages, ...newMessages]
      // summaryMsg 对应 compaction entry（算 1 条）
      // keptMessages 对应 compaction entry 之前从 firstKeptEntryId 开始的消息
      // newMessages 对应 compaction entry 之后的消息
      const compactionEntry = entries[lastCompactionIdx] as { type: string; firstKeptEntryId: string };
      const firstKeptIdx = entries.findIndex(
        (e) => "id" in (e as unknown as Record<string, unknown>) && (e as { id?: string }).id === compactionEntry.firstKeptEntryId,
      );

      let keptMsgCount = 0;
      if (firstKeptIdx >= 0) {
        for (let i = firstKeptIdx; i < lastCompactionIdx; i++) {
          if ((entries[i] as { type?: string }).type !== "compaction") {
            keptMsgCount++;
          }
        }
      }

      let postCompactionMsgs = 0;
      for (let i = lastCompactionIdx + 1; i < entries.length; i++) {
        if ((entries[i] as { type?: string }).type !== "compaction") {
          postCompactionMsgs++;
        }
      }
      savedCount = 1 + keptMsgCount + postCompactionMsgs;
    } else {
      // 没有 compaction：全部纯消息
      savedCount = entries.filter(
        (e) => (e as { type?: string }).type !== "compaction",
      ).length;
    }

    // 只追加新增的消息
    const newMessages = pendingMessages.slice(savedCount);
    if (newMessages.length === 0) return;

    let currentParentId = lastEntryId;
    for (const msg of newMessages) {
      const entryId = await appendSessionEntry(
        this.cwd,
        sessionId,
        msg,
        currentParentId,
      );
      currentParentId = entryId;
      // 只有还在同一个 session 时才更新 _lastEntryId
      if (this._sessionId === sessionId) {
        this._lastEntryId = entryId;
      }
    }

    // 只有还在同一个 session 时才刷新 entries 和 meta
    if (this._sessionId === sessionId) {
      this._entries = await loadSessionEntries(
        sessionFilePath(this.cwd, sessionId),
      );
      this._meta = await loadSessionMeta(this.cwd, sessionId);
    }
  }

  /**
   * 等待正在进行的 flush 完成（用于 switchTo/createNew 前）。
   */
  async waitForFlush(): Promise<void> {
    await this._pendingFlush;
  }

  // ============================================================================
  // 切换 session
  // ============================================================================

  /**
   * 切换到指定 session，返回该 session 的消息列表用于重建 agent 上下文。
   */
  async switchTo(sessionId: string): Promise<AgentMessage[]> {
    // 等待之前的 flush 完成，避免消息丢失或写错文件
    await this.waitForFlush();

    const meta = await loadSessionMeta(this.cwd, sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const entries = await loadSessionEntries(
      sessionFilePath(this.cwd, sessionId),
    );

    this._sessionId = sessionId;
    this._entries = entries;
    this._meta = meta;
    this._isNew = false;
    this._lastEntryId = meta.currentEntryId ?? null;
    this._pendingMessages = [];

    // 刷新 lastEntryId（处理旧格式 meta 没有 currentEntryId 的情况）
    this._refreshLastEntryId();

    return this.branchMessages;
  }

  /**
   * 创建新 session 并切换到它。
   */
  async createNew(): Promise<AgentMessage[]> {
    // 等待之前的 flush 完成
    await this.waitForFlush();

    const result = await createSession(this.cwd, this.modelId);
    this._sessionId = result.sessionId;
    this._entries = [];
    this._isNew = true;
    this._meta = await loadSessionMeta(this.cwd, this._sessionId);
    this._lastEntryId = null;
    this._pendingMessages = [];

    return [];
  }

  // ============================================================================
  // 分叉
  // ============================================================================

  /**
   * 从指定 entry 分叉出新消息。
   * 在当前 session 中追加 fork 消息，并返回新 entry id。
   */
  async forkFrom(entryId: string, message: AgentMessage): Promise<string> {
    // 等待之前的 flush 完成
    await this.waitForFlush();

    const { entry, id } = forkFromEntry(this._entries, entryId, message);

    // 追加到文件
    const { appendFile, mkdir } = await import("node:fs/promises");
    const dir = sessionDir(this.cwd);
    await mkdir(dir, { recursive: true });
    await appendFile(sessionFilePath(this.cwd, this._sessionId), JSON.stringify(entry) + "\n", "utf8");

    this._entries.push(entry);
    this._lastEntryId = id;

    // 更新 meta
    await updateSessionMeta(this.cwd, this._sessionId, {
      currentEntryId: id,
    });

    return id;
  }

  // ============================================================================
  // Compaction
  // ============================================================================

  /**
   * 追加 CompactionEntry 到当前 session。
   * 参考 pi-mono 的 appendCompaction：compaction entry 作为树节点追加，
   * 不删除旧消息，加载时通过 firstKeptEntryId 跳过被压缩的消息。
   */
  async appendCompaction(entry: CompactionEntry): Promise<string> {
    // 等待之前的 flush 完成
    await this.waitForFlush();

    const id = await appendCompactionEntry(
      this.cwd,
      this._sessionId,
      entry,
      this._lastEntryId,
    );

    // 更新内存状态
    this._entries = await loadSessionEntries(
      sessionFilePath(this.cwd, this._sessionId),
    );
    this._meta = await loadSessionMeta(this.cwd, this._sessionId);
    this._lastEntryId = id;
    this._pendingMessages = [];

    return id;
  }

  /**
   * 获取 firstKeptEntryId 对应的 entry ID（用于 compaction）。
   * 在当前 entries 中找到第 index 条消息 entry 的 id。
   *
   * @param index 消息索引（基于 agent._messages，可能含 summaryMsg 偏移）
   * @param summaryOffset summaryMsg 在 agent._messages 中的偏移量（0 表示无 summaryMsg，1 表示第一条是 summaryMsg）
   */
  getEntryIdByMessageIndex(index: number, summaryOffset = 0): string | null {
    // agent._messages 中 summaryMsg 无对应 entry，需扣除偏移
    const entryIdx = index - summaryOffset;
    if (entryIdx < 0) return null;

    let msgIdx = 0;
    for (const e of this._entries) {
      if ((e as CompactionEntry).type !== "compaction") {
        if (msgIdx === entryIdx) {
          return (e as SessionEntry & { id: string }).id ?? null;
        }
        msgIdx++;
      }
    }
    return null;
  }

  // ============================================================================
  // 树与列表
  // ============================================================================

  /** 列出所有 session */
  async listSessions(): Promise<{ meta: SessionMeta; isCurrent: boolean }[]> {
    const sessions = await listSessions(this.cwd);
    return sessions.map((s) => ({
      meta: s.meta,
      isCurrent: s.meta.id === this._sessionId,
    }));
  }

  /** 获取当前 session 的树结构 */
  getTree() {
    return buildTree(this._entries);
  }

  /** 渲染树为文本 */
  renderTree(): string {
    const tree = this.getTree();
    return renderTreeAsText(tree, this._meta?.currentEntryId);
  }

  // ============================================================================
  // 私有
  // ============================================================================

  private _refreshLastEntryId(): void {
    if (this._meta?.currentEntryId) {
      this._lastEntryId = this._meta.currentEntryId;
      return;
    }
    // fallback: 找最后一条有 id 的 entry
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const e = this._entries[i] as SessionEntry;
      if ("id" in e && (e as { id: string }).id) {
        this._lastEntryId = (e as { id: string }).id;
        break;
      }
    }
  }
}
