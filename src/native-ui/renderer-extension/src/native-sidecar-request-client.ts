import { decodeHarnessPluginRoute, harnessPluginRouteSchema } from "@harnessmix/shared-contracts";

// The original picker still emits positional native carriers. Accept the
// same allowlisted protocol as Host; plugin-v1 is not its only wire format.
export function decodeNativeHarnessRoute(value: unknown) {
  const plugin = decodeHarnessPluginRoute(value);
  if (plugin) return plugin;
  if (typeof value !== 'string' || value.length > 4096) return null;
  const match = /^harnessmix\/(pi|claude-code|deepseek-harness|antigravity|omp|opencode|grok)-native(?:@(.+))?$/.exec(value);
  if (!match) return null;
  const harnessId = match[1]!;
  const parts = match[2]?.split('@') ?? [];
  const fields = harnessId === 'pi' || (harnessId === 'omp' && parts.length < 3)
    ? ['model', 'thinkingOptionId']
    : harnessId === 'deepseek-harness' ? ['model', 'permissionModeId']
    : ['model', 'permissionModeId', 'thinkingOptionId'];
  if (parts.length > fields.length) throw new Error('Invalid native Harness route');
  const route: Record<string, unknown> = { harnessId };
  parts.forEach((part, index) => {
    if (part) route[fields[index]!] = index === 0 ? { id: part } : part;
  });
  return harnessPluginRouteSchema.parse(route);
}

type Frame = Record<string, any>;
type RequestOptions = { signal?: AbortSignal; [key: string]: unknown };
const METADATA = new Set([
  "config/read", "configRequirements/read", "model/list", "account/read",
  "account/rateLimits/read", "collaborationMode/list", "experimentalFeature/list",
  "permissionProfile/list", "skills/list", "plugin/list", "mcpServerStatus/list",
]);
const THREAD_METHODS = new Set([
  "thread/read", "thread/resume", "thread/fork", "thread/name/set", "thread/archive",
  "thread/unarchive", "thread/rollback", "thread/attachment/list", "thread/settings/update",
  "thread/metadata/update", "thread/section/move", "thread/queue/list", "thread/queue/add",
  "thread/queue/delete", "thread/queue/update", "thread/queue/reorder", "thread/queue/start",
  "turn/start", "turn/steer", "turn/interrupt",
]);
const record = (value: unknown): value is Frame => !!value && typeof value === "object" && !Array.isArray(value);

export interface NativeSidecarRequestClientOptions {
  /** Metadata stays on the original native route; it never enters Harness Host. */
  nativeMetadataRequest?: (method: string, params: Frame, options?: RequestOptions) => Promise<any>;
  selectedModel?: () => string | null;
  selectedAccountId?: () => string | null;
  timeoutMs?: number;
  prefix?: string;
}

/** A separate request client for the shipped native manager. No native execution fallback. */
export function createNativeSidecarRequestClient(
  send: (frame: string) => void,
  options: NativeSidecarRequestClientOptions = {},
) {
  let sequence = 0;
  let closed = false;
  const prefix = options.prefix ?? `harnessmix-native:${Date.now()}:${Math.random().toString(36).slice(2)}:`;
  const owned = new Set<string>();
  const loaded = new Set<string>();
  const pending = new Map<string, {
    method: string; resolve(value: any): void; reject(error: Error): void;
    finish(): void;
  }>();
  const approvals = new Set<string>();
  const answered = new Set<string>();
  const replying = new Map<string, { result: string; work: Promise<void> }>();
  const lifecycle = new Set<(event: Frame) => void>();
  const recentMethods: string[] = [];
  let handlers: {
    onNotification?(method: string, params: Frame): void;
    onRequest?(frame: Frame): void;
    onDisconnect?(): void;
  } = {};
  const notifyLifecycle = (event: Frame) => {
    for (const listener of lifecycle) { try { listener(event); } catch { /* Observer isolation. */ } }
  };
  const remember = (result: any) => {
    if (typeof result?.thread?.id === "string") owned.add(result.thread.id);
  };
  const wire = (method: string, params: Frame, requestOptions?: RequestOptions): Promise<any> => {
    if (closed) return Promise.reject(new Error("Harness transport is disposed"));
    if (requestOptions?.signal?.aborted) return Promise.reject(new DOMException("Request aborted", "AbortError"));
    const id = `${prefix}${++sequence}`;
    recentMethods.push(method);
    if (recentMethods.length > 24) recentMethods.shift();
    const startedAtMs = Date.now();
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); requestOptions?.signal?.removeEventListener("abort", abort); };
      const fail = (error: Error, type = "failed") => {
        if (!pending.delete(id)) return;
        finish();
        notifyLifecycle({ type, method, hostId: "local", error, durationMs: Date.now() - startedAtMs });
        reject(error);
      };
      const abort = () => fail(new DOMException("Request aborted; delivery may already have occurred", "AbortError"));
      const timer = setTimeout(() => fail(new Error("Harness request timed out; delivery is uncertain. Refresh history before retrying."), "timed-out"), options.timeoutMs ?? 60_000);
      pending.set(id, {
        method, finish,
        resolve(value) {
          remember(value);
          if (method === "harnessmix/thread/inspect" && value?.owner === "external" && typeof params.threadId === "string") owned.add(params.threadId);
          if (method === "harnessmix/thread/ownership/list") for (const item of value?.threads ?? []) {
            if (item.owner === "external" && typeof item.threadId === "string") owned.add(item.threadId);
          }
          if ((method === "thread/start" || method === "thread/resume") && value?.thread?.id) loaded.add(value.thread.id);
          notifyLifecycle({ type: "completed", method, hostId: "local", durationMs: Date.now() - startedAtMs }); resolve(value);
        },
        reject,
      });
      requestOptions?.signal?.addEventListener("abort", abort, { once: true });
      try { send(JSON.stringify({ id, method, params })); }
      catch (error) { fail(error instanceof Error ? error : new Error("Harness delivery failed")); }
    });
  };
  const assertOwned = async (threadId: unknown): Promise<string> => {
    if (typeof threadId !== "string" || !threadId) throw new Error("Harness thread ID is required");
    if (!owned.has(threadId)) {
      const result = await wire("harnessmix/thread/ownership/list", { threadIds: [threadId] });
      if (!result?.threads?.some((entry: Frame) => entry.threadId === threadId && entry.owner === "external")) {
        throw new Error("Official or unknown thread cannot enter Harness transport");
      }
      owned.add(threadId);
    }
    return threadId;
  };
  const client = {
    hostId: "local",
    useHostRequestScheduler: false,
    voiceBackendClient: undefined,
    getAppServerVersion: () => null,
    getCompatibleThreadSortKey: (key: string) => key,
    supportsPaginatedThreadHistory: () => false,
    getThreadPrewarmPolicy: () => "disabled",
    getPendingRequestCount(filter?: { method?: string }) {
      return [...pending.values()].filter(entry => !filter?.method || entry.method === filter.method).length;
    },
    addRequestLifecycleListener(listener: (event: Frame) => void) { lifecycle.add(listener); return () => lifecycle.delete(listener); },
    setHandlers(next: typeof handlers) { handlers = next; },
    ownsThread: (id: string) => owned.has(id),
    diagnostics() { return { pendingRequests: pending.size, pendingApprovals: approvals.size, ownedThreads: owned.size, loadedThreads: loaded.size, recentMethods: [...recentMethods] }; },
    rememberThread(id: string) { if (id) owned.add(id); },
    async sendRequest(method: string, params: Frame = {}, requestOptions?: RequestOptions): Promise<any> {
      if (closed) throw new Error("Harness transport is disposed");
      if (METADATA.has(method)) {
        if (!options.nativeMetadataRequest) throw new Error(`Native metadata unavailable: ${method}`);
        return options.nativeMetadataRequest(method, params, requestOptions);
      }
      if (method === "thread/list" || method === "harnessmix/thread/list") {
        const result = await wire("harnessmix/thread/list", params, requestOptions);
        for (const thread of result?.data ?? []) if (typeof thread.id === "string") owned.add(thread.id);
        return result;
      }
      if (method === "thread/start") {
        let model = params.model;
        let route = decodeNativeHarnessRoute(model);
        if (!route && options.selectedModel) { model = options.selectedModel(); route = decodeNativeHarnessRoute(model); }
        const accountId = options.selectedAccountId?.();
        if ((!route || route.harnessId === "codex") && !accountId) throw new Error("Explicit external Harness selection required");
        return wire(method, { ...params, model: route ? model : params.model, ...(accountId ? { __harnessmixAccountId: accountId } : {}) }, requestOptions);
      }
      if (method === "thread/loaded/list") return { data: [...loaded] };
      if (method === "thread/unsubscribe") { loaded.delete(await assertOwned(params.threadId)); return {}; }
      if (THREAD_METHODS.has(method)) {
        await assertOwned(params.threadId);
        return wire(method, params, requestOptions);
      }
      if (method.startsWith("harnessmix/")) return wire(method, params, requestOptions);
      throw new Error(`Unsupported Harness native method: ${method}`);
    },
    sendAppServerExtensionRequest(method: string, params: Frame = {}, requestOptions?: RequestOptions) {
      return client.sendRequest(method, params, requestOptions);
    },
    prewarmThreadStart(): Promise<never> { return Promise.reject(new Error("Harness native prewarming is disabled")); },
    // Legacy picker discovers request clients by this shape; requests still pass
    // the same strict ownership checks rather than entering the stock queue.
    enqueueRequest(method: string, params: Frame, requestOptions?: RequestOptions) { return client.sendRequest(method, params, requestOptions); },
    async respond(_method: string, response: Frame): Promise<void> {
      const id = response.id;
      if (typeof id !== "string" || !approvals.has(id)) throw new Error("Unknown Harness approval");
      if (response.error) throw new Error("Harness approval requires a native result");
      const result = JSON.stringify(response.result);
      const previous = replying.get(id);
      if (previous) {
        if (previous.result !== result) throw new Error("Conflicting Harness approval reply");
        return previous.work;
      }
      const work = wire("harnessmix/interaction/respond", { requestId: id, result: response.result }).then(ack => {
        if (ack?.accepted !== true) throw new Error("Harness approval was not acknowledged");
        approvals.delete(id);
        answered.add(id);
        if (answered.size > 256) answered.delete(answered.values().next().value!);
      });
      replying.set(id, { result, work });
      try { await work; } finally { replying.delete(id); }
    },
    receive(text: string) {
      if (closed) return;
      let frame: any;
      try { frame = JSON.parse(text); } catch { return; }
      if (!record(frame)) return;
      if (typeof frame.harnessmixSidecarFailure === "string") {
        for (const entry of pending.values()) { entry.finish(); entry.reject(new Error("Harness connection interrupted; refresh before retrying")); }
        pending.clear(); handlers.onDisconnect?.(); return;
      }
      if (frame.id !== undefined && typeof frame.method !== "string") {
        const entry = pending.get(String(frame.id));
        if (!entry) return;
        pending.delete(String(frame.id)); entry.finish();
        if (frame.error) entry.reject(Object.assign(new Error(frame.error.message ?? "Harness request failed"), { code: frame.error.code }));
        else entry.resolve(frame.result);
      } else if (typeof frame.method === "string") {
        const threadId = frame.params?.threadId ?? frame.params?.thread?.id;
        if (typeof threadId === "string") owned.add(threadId);
        if (frame.id !== undefined) {
          if (typeof frame.id !== "string" || !frame.id.startsWith("harness-mix:approval:") || approvals.has(frame.id) || answered.has(frame.id)) return;
          approvals.add(frame.id); handlers.onRequest?.(frame);
        } else handlers.onNotification?.(frame.method, frame.params ?? {});
      }
    },
    dispose() {
      closed = true;
      for (const entry of pending.values()) { entry.finish(); entry.reject(new Error("Harness transport disposed")); }
      pending.clear(); lifecycle.clear(); approvals.clear(); answered.clear(); replying.clear(); handlers = {};
    },
  };
  return client;
}

export type NativeSidecarRequestClient = ReturnType<typeof createNativeSidecarRequestClient>;
