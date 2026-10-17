import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "./rpc-manager";
import type { ContextUsage, ModelLike, ToolInfo } from "./pi-types";
import type { ExtensionWidgetItem } from "./types";
import { PiRpcClient, type PiRpcRecord } from "./pi-rpc-client";
import { isBlockingExtensionUiRequest } from "./extension-ui-queue";
import { cacheSessionPath, invalidateSessionListCache, openSessionManager, readLatestSessionEntryId } from "./session-reader";
import { validateAgentImages } from "./image-attachments";
import { validateSessionToolSelection } from "./session-tool-selection";
import { hasActiveSessionLivenessProvider } from "./session-liveness";

const BRIDGE_COMMAND = "__pi_station";
const BRIDGE_PREFIX = "pi-station:rpc:";
// Session replacement stays in the host's fork/copy flow. Forwarding native
// new_session or switch_session would change an id behind the registry's back.
const FORWARDED_COMMANDS = new Set([
  "set_model", "set_thinking_level", "compact", "set_session_name",
  "get_session_stats", "get_last_assistant_text", "set_auto_compaction",
  "set_auto_retry", "abort_retry", "bash", "get_messages", "get_entries",
  "get_tree", "get_available_models", "get_available_thinking_levels",
]);

interface CliState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: ModelLike;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
  [key: string]: unknown;
}

interface Inspection {
  contextUsage: ContextUsage | null;
  systemPrompt: string;
  tools: Array<ToolInfo & { active: boolean }>;
  settings: { autoRetry?: { enabled?: boolean } };
}

export interface CliSessionOptions {
  sessionFile?: string;
  sessionId?: string;
  cwd: string;
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
  environment?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
  shutdownDeadlineMs?: number;
  ephemeral?: boolean;
  offline?: boolean;
  disableMcp?: boolean;
  onComplete?(sessionId: string, name?: string): void;
}

export class PiCliSession {
  private readonly client: PiRpcClient;
  private state!: CliState;
  private inspection?: Inspection;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingUi = new Map<string, PiRpcRecord>();
  private readonly uiTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, ExtensionWidgetItem>();
  private readonly activeTools = new Map<string, PiRpcRecord>();
  private readonly bridgeRequests = new Map<string, { resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly created = new Date().toISOString();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private forcedStopTimer?: ReturnType<typeof setTimeout>;
  private onDestroyCallback?: () => void;
  private closing = false;
  private disposed = false;
  private shutdownPromise?: Promise<void>;
  private busyCommands = 0;
  private promptAdmissions = 0;
  private acceptedPrompt = false;
  private runActive = false;
  private bashRunning = false;
  private lastRunAborted = false;
  private settledRevision = 0;
  private currentMessage: unknown;
  private leafId: string | null | undefined;
  private entries: Parameters<typeof SessionManager.inMemory>[2] = [];
  private lastRemoteEntryId?: string;
  private leafRefresh?: Promise<void>;
  private readonly queued = { steering: [] as string[], followUp: [] as string[] };

  private constructor(private readonly options: CliSessionOptions) {
    const args = ["--extension", join(process.cwd(), "bin/pi-station-extension.mjs")];
    if (options.ephemeral) args.push("--no-session");
    if (options.offline) args.push("--offline");
    if (options.disableMcp) args.push("--no-mcp");
    if (options.sessionFile) args.push("--session", options.sessionFile);
    else if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.initialModel) args.push("--provider", options.initialModel.provider, "--model", options.initialModel.modelId);
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    if (options.toolNames?.length === 0) args.push("--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp");
    this.client = new PiRpcClient({ cwd: options.cwd, args, environment: options.environment });
    this.client.onEvent((record) => this.handleEvent(record));
    this.client.onClose((error) => {
      if (!this.closing) {
        this.emit({ type: "prompt_error", errorMessage: error.message });
        if (this.acceptedPrompt || this.runActive) this.emit({ type: "prompt_done", aborted: true });
      }
      this.finishClose(error);
    });
  }

  static async create(options: CliSessionOptions): Promise<PiCliSession> {
    const session = new PiCliSession(options);
    try {
      await session.refreshState();
      await session.refreshLeaf();
      const { commands } = await session.client.request<{ commands: Array<{ name: string }> }>({ type: "get_commands" });
      if (!commands.some((command) => command.name === BRIDGE_COMMAND)) {
        throw new Error("The installed pi did not load Pi Station's RPC bridge extension. Check pi's extension errors.");
      }
      if (options.toolNames !== undefined) {
        await session.bridge("set_tools", { tools: options.toolNames });
        await session.refreshLeaf();
      }
      session.inspection = await session.bridge<Inspection>("inspect");
      session.resetIdleTimer();
      return session;
    } catch (error) {
      await session.shutdown();
      throw error;
    }
  }

  get sessionId(): string { return this.state?.sessionId ?? ""; }
  get sessionFile(): string { return this.state?.sessionFile ?? this.options.sessionFile ?? ""; }
  get cwd(): string { return this.options.cwd; }
  get isStreaming(): boolean { return this.runActive || this.state?.isStreaming === true; }
  get streamingMessage(): unknown { return this.currentMessage; }

  /** File-format helpers only. The AgentSession always lives in the CLI process. */
  get inner() {
    let manager: SessionManager;
    if (this.sessionFile && existsSync(this.sessionFile)) {
      manager = openSessionManager(this.sessionFile);
      if (this.leafId && manager.getLeafId() !== this.leafId && manager.getEntry(this.leafId)) {
        manager = SessionManager.inMemory(this.cwd, undefined, [manager.getHeader()!, ...manager.getEntries()]);
        manager.branch(this.leafId);
      }
    } else {
      manager = SessionManager.inMemory(this.cwd, undefined, [{
        type: "session", version: 3, id: this.sessionId, timestamp: this.created, cwd: this.cwd,
      }, ...this.entries ?? []]);
    }
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      sessionManager: manager,
      modelRuntime: undefined,
      model: this.state?.model,
      thinkingLevel: this.state?.thinkingLevel,
      agent: { state: { thinkingLevel: this.state?.thinkingLevel } },
    };
  }

  isAlive(): boolean { return !this.closing && this.client.alive; }
  isRunning(): boolean { return this.client.alive && (this.runActive || this.isStreaming || this.state?.isCompacting || this.bashRunning || this.busyCommands > 0 || this.promptAdmissions > 0); }
  isAwaitingInput(): boolean { return this.isRunning() && this.pendingUi.size > 0; }
  isChatOnly(): boolean { return this.options.toolNames?.length === 0; }
  hasSuppressedCompletionNotifications(): boolean { return false; }
  start(): void { /* The process subscribes before its startup handshake. */ }
  beginExtensionBinding(): void { /* The CLI owns extension binding. */ }
  async waitUntilReady(): Promise<void> { if (!this.isAlive()) throw new Error("pi session is closed"); }
  onDestroy(callback: () => void): void { this.onDestroyCallback = callback; }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.activeTools.values()) listener(event);
    for (const event of this.pendingUi.values()) listener(event);
    for (const [key, text] of this.statuses) listener({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
    for (const widget of this.widgets.values()) listener({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: widget.key, widgetLines: widget.lines, widgetPlacement: widget.placement });
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error("[pi-station] Session listener failed:", error); }
    }
  }

  private handleEvent(event: PiRpcRecord): void {
    if (event.type === "extension_ui_request") {
      if (event.method === "notify" && typeof event.message === "string" && event.message.startsWith(BRIDGE_PREFIX)) {
        try {
          const reply = JSON.parse(event.message.slice(BRIDGE_PREFIX.length));
          const pending = this.bridgeRequests.get(reply.id);
          if (pending) {
            this.bridgeRequests.delete(reply.id);
            clearTimeout(pending.timer);
            if (reply.success) pending.resolve(reply.data);
            else pending.reject(new Error(String(reply.error)));
          }
        } catch { /* Ignore a malformed bridge reply; its request has a deadline. */ }
        return;
      }
      if (isBlockingExtensionUiRequest(event as never) && event.id) {
        this.pendingUi.set(event.id, event);
        if (typeof event.timeout === "number" && event.timeout > 0) {
          event.expiresAt = Date.now() + event.timeout;
          const id = event.id;
          this.uiTimers.set(id, setTimeout(() => this.clearUi(id), event.timeout));
        }
      }
      if (event.method === "setStatus" && typeof event.statusKey === "string") {
        if (typeof event.statusText === "string") this.statuses.set(event.statusKey, event.statusText);
        else this.statuses.delete(event.statusKey);
      }
      if (event.method === "setWidget" && typeof event.widgetKey === "string") {
        if (Array.isArray(event.widgetLines)) this.widgets.set(event.widgetKey, { key: event.widgetKey, lines: event.widgetLines as string[], placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" });
        else this.widgets.delete(event.widgetKey);
      }
    }
    if (event.type === "agent_start") { this.runActive = true; this.lastRunAborted = false; this.leafId = undefined; }
    if (event.type === "message_start" || event.type === "message_update") {
      const message = event.message as { role?: string } | undefined;
      if (message?.role === "assistant") this.currentMessage = message;
    }
    if (event.type === "message_end") this.currentMessage = undefined;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      if (typeof event.toolCallId === "string") this.activeTools.set(event.toolCallId, event);
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") this.activeTools.delete(event.toolCallId);
    if (event.type === "agent_end") { this.activeTools.clear(); invalidateSessionListCache(); }
    if (event.type === "session_info_changed") invalidateSessionListCache();
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") { if (this.state) this.state.isCompacting = true; }
    if (event.type === "compaction_end" || event.type === "auto_compaction_end") { if (this.state) this.state.isCompacting = false; }
    if (event.type === "agent_settled") {
      this.settledRevision++;
      this.runActive = false;
      if (this.state) this.state.isStreaming = false;
      this.lastRunAborted = event.aborted === true;
      this.queued.steering = [];
      this.queued.followUp = [];
      this.currentMessage = undefined;
      this.clearDialogs();
      this.leafId = undefined;
      invalidateSessionListCache();
      this.leafRefresh = this.refreshLeaf().catch(() => undefined).finally(() => { this.leafRefresh = undefined; });
    }
    this.emit(event);
    if (event.type === "agent_settled") this.completePrompt();
    this.resetIdleTimer();
  }

  private completePrompt(): void {
    if (!this.acceptedPrompt) return;
    this.acceptedPrompt = false;
    this.emit({ type: "prompt_done", aborted: this.lastRunAborted });
    if (!this.lastRunAborted) this.options.onComplete?.(this.sessionId, this.state.sessionName);
  }

  private clearUi(id: string): void {
    this.pendingUi.delete(id);
    const timer = this.uiTimers.get(id);
    if (timer) clearTimeout(timer);
    this.uiTimers.delete(id);
  }
  private clearDialogs(): void { for (const id of this.pendingUi.keys()) this.clearUi(id); }

  private bridge<T = unknown>(operation: string, data: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridgeRequests.delete(id);
        reject(new Error(`pi bridge timed out: ${operation}`));
      }, timeoutMs);
      this.bridgeRequests.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void this.client.request({ type: "prompt", message: `/${BRIDGE_COMMAND} ${JSON.stringify({ id, operation, ...data })}` }, timeoutMs).catch((error: Error) => {
        const pending = this.bridgeRequests.get(id);
        if (!pending) return;
        this.bridgeRequests.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async refreshState(): Promise<CliState> {
    this.state = await this.client.request<CliState>({ type: "get_state" });
    if (!this.state.sessionId) throw new Error("pi returned no session ID");
    if (this.state.model?.provider === "unknown" && this.state.model.id === "unknown") this.state.model = undefined;
    if (this.sessionFile) cacheSessionPath(this.sessionId, this.sessionFile);
    return this.state;
  }
  private async refreshLeaf(): Promise<void> {
    const result = await this.client.request<{ leafId: string | null; entries: NonNullable<Parameters<typeof SessionManager.inMemory>[2]> }>({ type: "get_entries", ...(this.lastRemoteEntryId ? { since: this.lastRemoteEntryId } : {}) });
    this.leafId = result.leafId;
    const existingIds = new Set((this.entries ?? []).map((entry) => "id" in entry ? entry.id : undefined));
    this.entries = [...this.entries ?? [], ...result.entries.filter((entry) => !("id" in entry) || !existingIds.has(entry.id))];
    this.lastRemoteEntryId = (this.entries.at(-1) as { id?: string } | undefined)?.id;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.isAlive()) throw new Error("pi session is closed");
    const type = String(command.type);
    if (["prompt", "steer", "follow_up"].includes(type)) {
      const error = validateAgentImages(command.images);
      if (error) throw new Error(error);
    }
    if (type === "extension_ui_response") {
      await this.client.write(command as PiRpcRecord);
      if (typeof command.id === "string") this.clearUi(command.id);
      return null;
    }
    if (type === "get_state") {
      await this.refreshState();
      this.inspection = await this.bridge<Inspection>("inspect");
      return {
        ...this.state,
        isPromptRunning: this.runActive || this.promptAdmissions > 0,
        isBashRunning: this.bashRunning,
        autoRetryEnabled: this.inspection.settings.autoRetry?.enabled !== false,
        contextUsage: this.inspection.contextUsage,
        systemPrompt: this.inspection.systemPrompt,
        queuedMessages: this.queued,
        extensionStatuses: [...this.statuses].map(([key, text]) => ({ key, text })),
        extensionWidgets: [...this.widgets.values()],
      };
    }
    if (type === "get_tools") {
      this.inspection = await this.bridge<Inspection>("inspect");
      return this.inspection.tools;
    }
    if (type === "get_model_catalog") return this.bridge("models");
    if (type === "get_commands") {
      const result = await this.client.request<{ commands: Array<{ name: string }> }>({ type });
      return { commands: result.commands.filter((item) => item.name !== BRIDGE_COMMAND) };
    }
    if (type === "set_tools") {
      const tools = validateSessionToolSelection(command.toolNames);
      await this.bridge("set_tools", { tools });
      await this.refreshLeaf();
      this.options.toolNames = tools;
      invalidateSessionListCache();
      return null;
    }
    if (type === "navigate_tree") {
      if (this.isRunning()) throw new Error("Cannot navigate while the session is running");
      const result = await this.bridge("navigate_tree", { targetId: command.targetId, summarize: command.summarize });
      await this.refreshLeaf();
      invalidateSessionListCache();
      return result;
    }
    if (type === "fork" || type === "fork_branch" || type === "clone") return this.copySession(command);
    if (type === "extension_ui_input") throw new Error("The pi CLI RPC protocol does not support custom terminal UI");
    if (type === "reload") {
      if (this.isRunning()) throw new Error("Wait for the current response to finish before reloading.");
      this.statuses.clear();
      this.widgets.clear();
      await this.bridge("reload");
      await this.refreshLeaf();
      return { success: true };
    }
    if (type === "prompt") {
      if (!existsSync(this.cwd)) throw new Error(`Directory does not exist: ${this.cwd}`);
      if (this.bashRunning) throw new Error("Cannot send a prompt while a shell command is running");
      this.promptAdmissions++;
      const revision = this.settledRevision;
      try {
        const result = await this.client.request<{ disposition: string }>(command as PiRpcRecord, 0);
        this.acceptedPrompt = true;
        if (result.disposition === "handled" || this.settledRevision > revision) this.completePrompt();
        await this.refreshLeaf();
        return null;
      } finally { this.promptAdmissions--; this.resetIdleTimer(); }
    }
    if (type === "steer" || type === "follow_up") {
      const result = await this.client.request<{ disposition: string }>(command as PiRpcRecord, 0);
      if (result.disposition === "queued") this.queued[type === "steer" ? "steering" : "followUp"].push(String(command.message));
      return result;
    }
    if (type === "clear_queue") {
      const result = await this.client.request(command as PiRpcRecord);
      this.queued.steering = []; this.queued.followUp = [];
      return result;
    }
    if (type === "abort" || type === "abort_bash" || type === "abort_compaction") {
      this.lastRunAborted = true;
      this.forcedStopTimer ??= setTimeout(() => { void this.shutdown(); }, this.options.idleTimeoutMs || 600_000);
      this.forcedStopTimer.unref();
      for (const id of this.pendingUi.keys()) await this.client.write({ type: "extension_ui_response", id, cancelled: true });
      this.clearDialogs();
      return this.client.request({ type: type === "abort_compaction" ? "abort" : type }, 0);
    }
    if (!FORWARDED_COMMANDS.has(type)) throw new Error(`Unsupported command: ${type}`);
    const tracksBusy = type === "bash" || type === "compact";
    if (tracksBusy && this.isRunning()) throw new Error("Wait for the current response to finish");
    if (tracksBusy) this.busyCommands++;
    if (type === "bash") this.bashRunning = true;
    try {
      const result = await this.client.request({ ...command, type, ...(type === "bash" ? { excludeFromContext: command.excludeFromContext } : {}) }, tracksBusy ? 0 : 30_000);
      if (["set_model", "set_thinking_level", "set_session_name"].includes(type)) await this.refreshState();
      if (["bash", "compact", "set_session_name"].includes(type)) { this.leafId = undefined; invalidateSessionListCache(); }
      return result ?? null;
    } finally {
      if (tracksBusy) this.busyCommands--;
      if (type === "bash") this.bashRunning = false;
      this.resetIdleTimer();
    }
  }

  private async copySession(command: Record<string, unknown>): Promise<unknown> {
    const type = String(command.type);
    if (this.bashRunning || (type === "clone" && this.isRunning())) throw new Error(`Cannot ${type} while the session is running`);
    if (!this.sessionFile || !existsSync(this.sessionFile)) return { cancelled: true };
    const source = SessionManager.open(this.sessionFile);
    const entryId = typeof command.entryId === "string" ? command.entryId : typeof command.leafId === "string" ? command.leafId : this.leafId ?? source.getLeafId();
    const entry = entryId ? source.getEntry(entryId) : undefined;
    if (!entry) return { cancelled: true };
    if (type === "clone" && !source.getBranch(entry.id).some((item) => item.type === "message" && item.message.role === "assistant")) return { cancelled: true };
    let path: string;
    let copy: SessionManager;
    if (type === "fork" && !entry.parentId) {
      copy = SessionManager.create(this.cwd, source.getSessionDir(), { parentSession: this.sessionFile });
      path = copy.getSessionFile()!;
    } else {
      path = source.createBranchedSession(type === "fork" ? entry.parentId! : entry.id) ?? "";
      if (!path) throw new Error("Could not copy session branch");
      copy = existsSync(path) ? SessionManager.open(path) : source;
    }
    if (!existsSync(path)) writeFileSync(path, [copy.getHeader(), ...copy.getEntries()].map((item) => JSON.stringify(item)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    cacheSessionPath(copy.getSessionId(), path);
    invalidateSessionListCache();
    if (type !== "fork_branch" && !this.isRunning()) await this.shutdown();
    return { cancelled: false, newSessionId: copy.getSessionId() };
  }

  evictIfDiskAhead(): boolean {
    // History reads always use fresh file snapshots. The CLI is only restarted
    // if an external writer moved the leaf past the last state queried here.
    if (!this.isAlive() || this.isRunning() || this.leafRefresh) return false;
    const latest = readLatestSessionEntryId(this.sessionFile);
    if (!latest || latest === this.lastRemoteEntryId) return false;
    this.destroy();
    return true;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.forcedStopTimer && !this.isRunning()) { clearTimeout(this.forcedStopTimer); this.forcedStopTimer = undefined; }
    const timeout = this.options.idleTimeoutMs ?? 600_000;
    if (!timeout || this.closing || this.isRunning()) return;
    this.idleTimer = setTimeout(() => {
      if (hasActiveSessionLivenessProvider({ sessionId: this.sessionId, sessionFile: this.sessionFile })) this.resetIdleTimer();
      else void this.shutdown();
    }, timeout);
    this.idleTimer.unref();
  }

  private finishClose(error = new Error("pi session is closed")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.forcedStopTimer) clearTimeout(this.forcedStopTimer);
    this.clearDialogs();
    for (const pending of this.bridgeRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.bridgeRequests.clear();
    this.emit({ type: "session_shutdown" });
    this.onDestroyCallback?.();
    this.onDestroyCallback = undefined;
  }
  shutdown(): Promise<void> {
    this.closing = true;
    return this.shutdownPromise ??= this.client.shutdown(this.options.shutdownDeadlineMs).finally(() => this.finishClose());
  }
  destroy(): void { this.closing = true; this.client.destroy(); }
  async waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.shutdown().then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
