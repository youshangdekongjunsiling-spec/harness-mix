import { describe, expect, it } from "vitest";
import { ATTENTION_SNAPSHOT_METHOD, NATIVE_THREAD_LIST_METHOD, NATIVE_THREAD_READ_METHOD, createAttentionClient } from "../src/attention-client.js";

describe("attention client", () => {
  it("keeps native thread/list separate and lets managed rows override by id", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = createAttentionClient(async (method, params) => {
      calls.push([method, params]);
      if (method === NATIVE_THREAD_LIST_METHOD) return { data: [
        { id: "native-1", name: "Codex", cwd: "C:/repo", updatedAt: 5, status: "idle" },
        { id: "shared", title: "Native", cwd: "C:/repo", updatedAt: 4, status: "idle" },
      ], nextCursor: null };
      if (method === NATIVE_THREAD_READ_METHOD) return { thread: { turns: [] } };
      if (method === ATTENTION_SNAPSHOT_METHOD) return {
        version: 1, generatedAt: 10,
        projects: [{ id: "p", name: "repo", rootPaths: ["C:/repo"] }],
        threads: [{ id: "shared", title: "Managed", harnessId: "pi", cwd: "C:/repo", projectId: "p", updatedAt: 9, status: "waiting", event: { id: "e1", kind: "waiting", at: 9 } }],
        repositories: [], errors: [],
      };
      throw new Error("unexpected method");
    });
    const data = await client.load({ includeGit: true });
    expect(calls.map(([method]) => method)).toEqual([NATIVE_THREAD_LIST_METHOD, NATIVE_THREAD_READ_METHOD, NATIVE_THREAD_READ_METHOD, ATTENTION_SNAPSHOT_METHOD]);
    expect(calls[0]?.[1]).toEqual({ limit: 100, archived: false });
    expect(calls[3]?.[1]).toEqual({ cwdPaths: ["C:/repo"], includeGit: true });
    expect(data.threads.find(thread => thread.id === "shared")?.title).toBe("Managed");
    expect(data.threads.find(thread => thread.id === "native-1")?.harnessId).toBe("codex");
  });

  it("uses the latest structured command cwd for Host repository requests", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = createAttentionClient(async (method, params) => {
      calls.push([method, params]);
      if (method === NATIVE_THREAD_LIST_METHOD) return { data: [
        { id: "native", title: "Native", cwd: "C:/umbrella", projectId: "selected", updatedAt: 10, status: { type: "active", activeFlags: [] } },
      ] };
      if (method === NATIVE_THREAD_READ_METHOD) return { thread: { turns: [{ items: [
        { type: "commandExecution", id: "cmd-1", cwd: "C:/umbrella/actual", command: "secret", aggregatedOutput: "secret output" },
      ] }] } };
      if (method === ATTENTION_SNAPSHOT_METHOD) return { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] };
      throw new Error("unexpected method");
    });
    const data = await client.load({ includeGit: true, projectId: "selected" });
    const snapshot = calls.find(([method]) => method === ATTENTION_SNAPSHOT_METHOD);
    expect(snapshot?.[1]).toEqual({ cwdPaths: ["C:/umbrella/actual", "C:/umbrella"], includeGit: true });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(data.threads[0]?.activity).toMatchObject({ cwd: "C:/umbrella/actual", source: "command", itemId: "cmd-1" });
  });

  it("does not read native histories during background loads", async () => {
    const methods: string[] = [];
    const client = createAttentionClient(async method => {
      methods.push(method);
      if (method === NATIVE_THREAD_LIST_METHOD) return { data: [{ id: "n", cwd: "C:/repo", status: "idle" }] };
      if (method === ATTENTION_SNAPSHOT_METHOD) return { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] };
      throw new Error("history must not be read");
    });
    await client.load({ includeGit: false });
    expect(methods).toEqual([NATIVE_THREAD_LIST_METHOD, ATTENTION_SNAPSHOT_METHOD]);
  });

  it("reports bounded and unavailable activity discovery in concise Chinese", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: `n-${index}`, cwd: `C:/repo/${index}`, status: "idle", updatedAt: index }));
    const client = createAttentionClient(async method => {
      if (method === NATIVE_THREAD_LIST_METHOD) return { data: rows };
      if (method === NATIVE_THREAD_READ_METHOD) throw new Error("unsupported native method detail");
      return { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] };
    });
    const data = await client.load({ includeGit: true });
    expect(data.partial).toBe(true);
    expect(data.warnings).toContain("部分任务的实际工作目录尚未检查。");
    expect(data.warnings).toContain("部分任务的实际工作目录暂时无法读取。");
    expect(data.warnings.join(" ")).not.toContain("unsupported native method detail");
  });

  it("preserves native cards and reports a host fallback", async () => {
    const client = createAttentionClient(async method => {
      if (method === NATIVE_THREAD_LIST_METHOD) return { data: [{ id: "n", title: "native", status: "idle" }] };
      throw new Error("host unavailable");
    });
    const data = await client.load({ includeGit: false });
    expect(data.threads).toHaveLength(1);
    expect(data.repositories).toEqual([]);
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.errors).toEqual(data.warnings);
  });

  it("subscribes lazily, forwards status events and disposes", () => {
    let callback: ((method: string, value: unknown) => void) | undefined;
    let detached = 0;
    const seen: unknown[] = [];
    const client = createAttentionClient(async () => ({ data: [] }), (methods, listener) => {
      callback = (method, value) => { expect(methods).toContain(method); listener(value); };
      return () => { detached += 1; };
    });
    expect(callback).toBeUndefined();
    const off = client.subscribe(event => seen.push(event));
    expect(callback).toBeDefined();
    callback!("thread/status/changed", { params: { eventId: "e", threadId: "t", kind: "error", at: 4 } });
    expect(seen).toEqual([{ id: "e", threadId: "t", kind: "error", at: 4 }]);
    off();
    client.dispose();
    expect(detached).toBe(1);
    expect(() => client.subscribe(() => {})).toThrow("Attention client is disposed");
  });

  it("normalizes native status objects and seconds timestamps without treating idle as completed", async () => {
    const client = createAttentionClient(async (method) => method === NATIVE_THREAD_LIST_METHOD ? {
      data: [
        { id: "active", name: "Active", cwd: "C:/repo", updatedAt: 2, status: { type: "active", activeFlags: [] }, turns: [{ id: "historical", status: "completed", completedAt: 1 }] },
        { id: "waiting", preview: "Needs input", cwd: "C:/repo", updatedAt: 3, status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
        { id: "approval", cwd: "C:/repo", updatedAt: 3, status: { type: "waitingOnApproval" } },
        { id: "input", cwd: "C:/repo", updatedAt: 3, state: "waitingOnUserInput" },
        { id: "system-error", cwd: "C:/repo", updatedAt: 3, status: { type: "systemError" } },
        { id: "not-loaded", cwd: "C:/repo", updatedAt: 3, status: { type: "notLoaded" }, turns: [{ id: "old", status: "completed", completedAt: 1 }] },
        { id: "idle", name: "Idle", cwd: "C:/repo", updatedAt: 4, status: { type: "idle" } },
        { id: "done", cwd: "C:/repo", updatedAt: 5, status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed", completedAt: 6 }] },
      ], nextCursor: null,
    } : { version: 1, generatedAt: 10, projects: [], threads: [], repositories: [], errors: [] });
    const data = await client.load();
    expect(data.threads.find(t => t.id === "active")).toMatchObject({ status: "running", updatedAt: 2000 });
    expect(data.threads.find(t => t.id === "active")?.event).toBeUndefined();
    expect(data.threads.find(t => t.id === "active")?.turnId).toBeUndefined();
    expect(data.threads.find(t => t.id === "waiting")).toMatchObject({ title: "Needs input", status: "waiting", updatedAt: 3000 });
    expect(data.threads.find(t => t.id === "approval")?.status).toBe("waiting");
    expect(data.threads.find(t => t.id === "input")?.status).toBe("waiting");
    expect(data.threads.find(t => t.id === "system-error")).toMatchObject({ status: "error", event: { kind: "error" } });
    expect(data.threads.find(t => t.id === "not-loaded")).toMatchObject({ status: "unknown" });
    expect(data.threads.find(t => t.id === "not-loaded")?.event).toBeUndefined();
    expect(data.threads.find(t => t.id === "idle")).toMatchObject({ status: "idle", updatedAt: 4000 });
    expect(data.threads.find(t => t.id === "done")).toMatchObject({ status: "completed", turnId: "turn-1", event: { id: "done:turn-1:completed", at: 6000 } });
  });

  it("tracks turn identity and creates a distinct stable event for each waiting occurrence", async () => {
    let callback: ((value: unknown) => void) | undefined;
    const seen: Array<unknown> = [];
    const client = createAttentionClient(async method => method === NATIVE_THREAD_LIST_METHOD
      ? { data: [{ id: "t", name: "Native", cwd: "C:/repo", updatedAt: 7, status: { type: "idle" } }], nextCursor: null }
      : { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] }, (methods, listener) => {
      expect(methods).toContain("turn/completed");
      callback = listener;
      return () => { callback = undefined; };
    });
    const off = client.subscribe(event => seen.push(event));
    callback?.({ method: "turn/started", params: { threadId: "t", turn: { id: "turn-2", status: "inProgress" } } });
    callback?.({ method: "thread/status/changed", params: { threadId: "t", timestamp: 8, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    const firstWaiting = seen.at(-1) as { id: string; at: number };
    expect(firstWaiting).toMatchObject({ id: "t:turn-2:waiting:1:waitingOnApproval", at: 8000 });
    callback?.({ method: "thread/status/changed", params: { threadId: "t", timestamp: 9, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    expect(seen.at(-1)).toMatchObject({ id: firstWaiting.id, at: firstWaiting.at });
    callback?.({ method: "thread/status/changed", params: { threadId: "t", timestamp: 10, status: { type: "active", activeFlags: [] } } });
    expect(seen.at(-1)).toBeUndefined();
    callback?.({ method: "thread/status/changed", params: { threadId: "t", timestamp: 11, status: { type: "active", activeFlags: ["waitingOnUserInput"] } } });
    expect(seen.at(-1)).toMatchObject({ id: "t:turn-2:waiting:2:waitingOnUserInput", at: 11000 });
    callback?.({ method: "turn/started", params: { threadId: "t", turn: { id: "turn-3", status: "inProgress" } } });
    callback?.({ method: "thread/status/changed", params: { threadId: "t", timestamp: 12, status: { type: "waitingOnApproval" } } });
    expect(seen.at(-1)).toMatchObject({ id: "t:turn-3:waiting:1:waiting", at: 12000 });
    callback?.({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn-3", status: "completed", completedAt: 13 } } });
    const data = await client.load();
    expect(data.threads[0]).toMatchObject({ id: "t", status: "idle", event: { id: "t:turn-3:completed", at: 13000 } });
    off();
    client.dispose();
  });

  it("keeps the newest event and merges received failures when native reload fails", async () => {
    let callback: ((value: unknown) => void) | undefined;
    let failNative = false;
    const client = createAttentionClient(async method => {
      if (method === NATIVE_THREAD_LIST_METHOD) {
        if (failNative) throw new Error("stock app-server unavailable");
        return { data: [{ id: "t", name: "Native", updatedAt: 12, status: { type: "idle" },
          event: { id: "stale", kind: "completed", at: 0.01 } }], nextCursor: null };
      }
      return { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] };
    }, (_methods, listener) => { callback = listener; return () => {}; });
    client.subscribe(() => {});
    await client.load();
    callback?.({ method: "thread/updated", params: { threadId: "t", eventId: "new-error", kind: "error", at: 20 } });
    const fresh = await client.load();
    expect(fresh.threads[0]).toMatchObject({ status: "idle", event: { id: "new-error", at: 20 } });
    failNative = true;
    const fallback = await client.load();
    expect(fallback.threads[0]).toMatchObject({ status: "error", event: { id: "new-error", kind: "error", at: 20 } });
    expect(fallback.warnings[0]).toContain("stock app-server unavailable");
  });

  it("does not let an old completed turn erase a newer completion notification", async () => {
    let callback: ((value: unknown) => void) | undefined;
    let nativeRow: Record<string, unknown> = {
      id: "t", name: "Native", updatedAt: 0.1, status: { type: "idle" },
      turns: [{ id: "turn-old", status: "completed", completedAt: 0.1 }],
    };
    const client = createAttentionClient(async method => method === NATIVE_THREAD_LIST_METHOD
      ? { data: [nativeRow], nextCursor: null }
      : { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] }, (_methods, listener) => {
      callback = listener;
      return () => {};
    });
    client.subscribe(() => {});
    callback?.({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn-new", status: "completed", completedAt: 0.2 } } });
    const stale = await client.load();
    expect(stale.threads[0]).toMatchObject({
      status: "completed",
      turnId: "turn-new",
      event: { id: "t:turn-new:completed", at: 200 },
    });

    nativeRow = {
      id: "t", name: "Native", updatedAt: 0.3, status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-active", status: "inProgress", startedAt: 0.3 }],
    };
    const active = await client.load();
    expect(active.threads[0]).toMatchObject({ status: "running", turnId: "turn-active" });
    expect(active.threads[0]?.event).toBeUndefined();
  });

  it("bounds notification event retention to the newest 512 threads", async () => {
    let callback: ((value: unknown) => void) | undefined;
    let failNative = false;
    const rows = Array.from({ length: 513 }, (_, index) => ({ id: `t-${index}`, name: `T${index}`, status: { type: "idle" }, updatedAt: 1 }));
    const client = createAttentionClient(async method => {
      if (method === NATIVE_THREAD_LIST_METHOD) {
        if (failNative) throw new Error("offline");
        return { data: rows, nextCursor: null };
      }
      return { version: 1, generatedAt: 1, projects: [], threads: [], repositories: [], errors: [] };
    }, (_methods, listener) => { callback = listener; return () => {}; });
    client.subscribe(() => {});
    await client.load();
    for (let index = 0; index < rows.length; index += 1) {
      callback?.({ method: "thread/updated", params: { threadId: `t-${index}`, eventId: `e-${index}`, kind: "error", at: index + 1 } });
    }
    failNative = true;
    const fallback = await client.load();
    expect(fallback.threads.find(thread => thread.id === "t-0")?.event).toBeUndefined();
    expect(fallback.threads.find(thread => thread.id === "t-512")?.event?.id).toBe("e-512");
  });
});
