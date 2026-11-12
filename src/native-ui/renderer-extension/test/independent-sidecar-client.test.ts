import { describe, expect, it, vi } from "vitest";
import { encodeHarnessPluginRoute } from "@harnessmix/shared-contracts";
import { createIndependentSidecarClient } from "../src/independent-sidecar-client.js";

describe("independent Harness transport", () => {
  it("rejects official requests and unqualified starts before sending", async () => {
    const send = vi.fn(); const client = createIndependentSidecarClient(send);
    await expect(client.request("initialize")).rejects.toThrow("官方 Codex");
    await expect(client.request("thread/start", { model: "gpt-6" })).rejects.toThrow("显式选择");
    await expect(client.request("turn/start", {})).rejects.toThrow("会话 ID");
    expect(send).not.toHaveBeenCalled(); client.dispose();
  });
  it("carries an explicit Harness start and correlates only its response", async () => {
    const frames: any[] = []; const client = createIndependentSidecarClient(text => frames.push(JSON.parse(text)));
    const response = client.request("thread/start", { model: encodeHarnessPluginRoute({ harnessId: "claude-code" }), cwd: "C:/workspace" });
    client.receive(JSON.stringify({ id: "unrelated", result: { wrong: true } }));
    client.receive(JSON.stringify({ id: frames[0].id, result: { thread: { id: "external-1" } } }));
    await expect(response).resolves.toEqual({ thread: { id: "external-1" } }); client.dispose();
  });
  it("keeps approvals pending until Host acknowledges, and permits retry on failure", async () => {
    const frames: any[] = []; const client = createIndependentSidecarClient(text => frames.push(JSON.parse(text)));
    const approval = { id: "harness-mix:approval:q1", method: "item/tool/requestUserInput", params: { threadId: "external-1", questions: [] } };
    client.receive(JSON.stringify(approval));
    const failed = client.respond(approval.id, { answers: { q1: { answers: ["choice A", "choice B"] } } });
    expect(client.pendingApprovals()).toEqual([approval]);
    client.receive(JSON.stringify({ id: frames[0].id, error: { message: "native temporarily unavailable" } }));
    await expect(failed).rejects.toThrow("native temporarily");
    expect(client.pendingApprovals()).toHaveLength(1);
    const success = client.respond(approval.id, { answers: { q1: { answers: ["choice A", "choice B"] } } });
    expect(frames[1].params.result.answers.q1.answers).toEqual(["choice A", "choice B"]);
    client.receive(JSON.stringify({ id: frames[1].id, result: { accepted: true } }));
    await success; expect(client.pendingApprovals()).toHaveLength(0);
    client.receive(JSON.stringify(approval)); expect(client.pendingApprovals()).toHaveLength(0);
    await expect(client.respond(approval.id, {})).rejects.toThrow("已处理"); client.dispose();
  });
  it("does not automatically resend an uncertain mutation", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(); const client = createIndependentSidecarClient(send, { timeoutMs: 25 });
      const outcome = expect(client.request("turn/start", { threadId: "external-1", input: [] })).rejects.toThrow("不会自动重发");
      await vi.advanceTimersByTimeAsync(26); await outcome;
      client.reconnect(); expect(send).toHaveBeenCalledTimes(1); client.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("isolates listener errors, expires completed approvals and rejects disconnected requests", async () => {
    const send = vi.fn(); const client = createIndependentSidecarClient(send);
    client.subscribe(() => { throw Error("view"); }); const view = vi.fn(); client.subscribe(view);
    client.receive(JSON.stringify({ id: "harness-mix:approval:a", method: "item/commandExecution/requestApproval", params: { threadId: "e", turnId: "t" } }));
    client.receive(JSON.stringify({ method: "turn/completed", params: { threadId: "e", turn: { id: "t" } } }));
    expect(client.pendingApprovals()).toHaveLength(0); expect(view).toHaveBeenCalledTimes(2);
    const pending = client.request("thread/read", { threadId: "e" });
    client.receive(JSON.stringify({ harnessmixSidecarFailure: "closed" }));
    await expect(pending).rejects.toThrow("后台连接中断"); client.dispose();
  });
});
