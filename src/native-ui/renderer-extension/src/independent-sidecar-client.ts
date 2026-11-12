import { decodeHarnessPluginRoute } from "@harnessmix/shared-contracts";

export interface IndependentSidecarClient {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  respond(id: string | number, result: unknown): Promise<void>;
  subscribe(listener: (frame: Record<string, any>) => void): () => void;
  pendingApprovals(): Record<string, any>[];
  dispose(): void;
}

const THREAD_METHODS = new Set([
  "thread/read", "thread/resume", "thread/name/set", "thread/turns/list",
  "turn/start", "turn/steer", "turn/interrupt",
]);
const record = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

export function independentRequestId(): string {
  // randomUUID is secure-context-only; Electron custom schemes may expose
  // getRandomValues without it. These are correlation IDs, never credentials.
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, "0")).join("");
}

/** A separate client for our Host. Never forwards a frame to native Codex. */
export function createIndependentSidecarClient(
  send: (frame: string) => void,
  options: { timeoutMs?: number; prefix?: string } = {},
): IndependentSidecarClient & { receive(frame: string): void; reconnect(): void } {
  let sequence = 0;
  let disposed = false;
  const prefix = options.prefix ?? `harnessmix-panel:${independentRequestId()}:`;
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const approvals = new Map<string | number, Record<string, any>>();
  const answered = new Set<string | number>();
  const listeners = new Set<(frame: Record<string, any>) => void>();
  const emit = (frame: Record<string, any>): void => {
    for (const listener of listeners) { try { listener(frame); } catch { /* Isolate view listeners. */ } }
  };
  const failPending = (message: string): void => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  };
  return {
    request(method, params = {}) {
      if (disposed) return Promise.reject(new Error("Harness 连接已关闭"));
      try {
        if (method === "thread/start") {
          const route = decodeHarnessPluginRoute(params.model);
          if (!route || route.harnessId === "codex") throw new Error("独立面板仅允许显式选择的 Harness 会话");
        } else if (THREAD_METHODS.has(method)) {
          if (typeof params.threadId !== "string" || !params.threadId) throw new Error("缺少 Harness 会话 ID");
        } else if (!method.startsWith("harnessmix/")) {
          throw new Error("独立面板不承载官方 Codex 请求");
        }
      } catch (error) { return Promise.reject(error); }
      const id = `${prefix}${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new Error("Harness 请求超时，执行结果尚不确定。请先刷新历史确认；不会自动重发。"));
        }, options.timeoutMs ?? 60_000);
        pending.set(id, { resolve, reject, timer });
        try { send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    async respond(id, result) {
      if (disposed) throw new Error("Harness 连接已关闭");
      if (!approvals.has(id) || answered.has(id)) throw new Error("此请求已处理或不属于当前 Harness 通道");
      // Wait for the Host/native harness acknowledgement, not just CDP delivery.
      const acknowledgement = await this.request("harnessmix/interaction/respond", { requestId: id, result });
      if (acknowledgement?.accepted !== true) throw new Error("Harness 尚未确认此回复");
      answered.add(id); approvals.delete(id);
      emit({ method: "harnessmix/interaction/responded", params: { requestId: id } });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pendingApprovals() { return [...approvals.values()]; },
    receive(frameText) {
      if (disposed) return;
      let frame: unknown;
      try { frame = JSON.parse(frameText); } catch { return; }
      if (!record(frame)) return;
      if (typeof frame.harnessmixSidecarFailure === "string") {
        failPending("Harness 后台连接中断；请刷新历史确认执行状态");
        emit({ method: "harnessmix/transport/error", params: { message: frame.harnessmixSidecarFailure } });
        return;
      }
      if (frame.id !== undefined && typeof frame.method === "string") {
        if (typeof frame.id !== "string" || !frame.id.startsWith("harness-mix:approval:")) return;
        if (answered.has(frame.id)) return;
        approvals.set(frame.id, frame);
        emit(frame); return;
      }
      if (frame.id !== undefined) {
        const entry = pending.get(String(frame.id));
        if (!entry) return;
        pending.delete(String(frame.id)); clearTimeout(entry.timer);
        if (frame.error) entry.reject(new Error(typeof frame.error.message === "string" ? frame.error.message : "Harness 请求失败"));
        else entry.resolve(frame.result);
        return;
      }
      if (typeof frame.method === "string") {
        if (frame.method === "turn/completed") {
          for (const [id, approval] of approvals) {
            if (approval.params?.threadId === frame.params?.threadId &&
                (!approval.params?.turnId || approval.params.turnId === frame.params?.turn?.id)) approvals.delete(id);
          }
        }
        emit(frame);
      }
    },
    reconnect() {
      if (!disposed) emit({ method: "harnessmix/transport/reconnected", params: {} });
    },
    dispose() { disposed = true; failPending("Harness 面板已重新加载，请刷新历史确认执行状态"); listeners.clear(); approvals.clear(); answered.clear(); },
  };
}
