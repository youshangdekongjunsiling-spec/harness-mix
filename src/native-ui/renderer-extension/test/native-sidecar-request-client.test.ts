import { describe, expect, it, vi } from "vitest";
import { encodeHarnessPluginRoute } from "@harnessmix/shared-contracts";
import { createNativeSidecarRequestClient } from "../src/native-sidecar-request-client.js";

const route = encodeHarnessPluginRoute({ harnessId: "claude-code" });
function fixture(extra = {}) {
  const sent: any[] = [];
  const client = createNativeSidecarRequestClient(text => sent.push(JSON.parse(text)), extra);
  const reply = (value: any, index = sent.length - 1) => client.receive(JSON.stringify({ id: sent[index].id, result: value }));
  return { client, sent, reply };
}

describe("native manager sidecar transport isolation", () => {
  it("rejects implicit official starts and never forwards unknown methods", async () => {
    const { client, sent } = fixture();
    await expect(client.sendRequest("thread/start", { model: "gpt-6" })).rejects.toThrow("Explicit external");
    await expect(client.sendRequest("process/spawn", {})).rejects.toThrow("Unsupported");
    expect(sent).toEqual([]); client.dispose();
  });
  it("accepts the original Claude picker carrier without a global draft selection", async () => {
    const { client, sent, reply } = fixture();
    const carrier = 'harnessmix/claude-code-native@eyJpZCI6ImZhYmxlIn0@default@high';
    const work = client.sendRequest('thread/start', { model: carrier });
    expect(sent).toHaveLength(1);
    expect(sent[0].params.model).toBe(carrier);
    reply({ thread: { id: 'external-original-picker' } });
    await work;
    expect(client.ownsThread('external-original-picker')).toBe(true);
    client.dispose();
  });
  it("keeps native metadata entirely off the Host sidecar", async () => {
    const nativeMetadataRequest = vi.fn(async () => ({ config: {} }));
    const { client, sent } = fixture({ nativeMetadataRequest });
    await client.sendRequest("config/read", { includeLayers: false });
    expect(nativeMetadataRequest).toHaveBeenCalledWith("config/read", { includeLayers: false }, undefined);
    expect(sent).toEqual([]); client.dispose();
  });
  it("does not send official thread execution even when caller supplies its ID", async () => {
    const { client, sent, reply } = fixture();
    const work = client.sendRequest("turn/start", { threadId: "official", input: [] });
    expect(sent[0].method).toBe("harnessmix/thread/ownership/list");
    reply({ threads: [{ threadId: "official", owner: "codex" }] });
    await expect(work).rejects.toThrow("Official or unknown");
    expect(sent).toHaveLength(1); client.dispose();
  });
  it("uses explicit picker selection, retains attachment input and tracks only opened sessions", async () => {
    const { client, sent, reply } = fixture({ selectedModel: () => route });
    const start = client.sendRequest("thread/start", { model: "gpt-6", cwd: "C:/project" });
    expect(sent[0].params.model).toBe(route);
    reply({ thread: { id: "external" } }); await start;
    const input = [{ type: "text", text: "inspect" }, { type: "localImage", path: "C:/image.png" }];
    const turn = client.sendRequest("turn/start", { threadId: "external", input });
    await Promise.resolve();
    expect(sent[1].params.input).toEqual(input);
    reply({ turn: { id: "turn-1" } }); await turn;
    expect(await client.sendRequest("thread/loaded/list")).toEqual({ data: ["external"] });
    await client.sendRequest("thread/unsubscribe", { threadId: "external" });
    expect(await client.sendRequest("thread/loaded/list")).toEqual({ data: [] }); client.dispose();
  });
  it("maps history list to external catalog without marking unopened history as loaded", async () => {
    const { client, sent, reply } = fixture();
    const list = client.sendRequest("thread/list", { archived: false });
    expect(sent[0].method).toBe("harnessmix/thread/list");
    reply({ data: [{ id: "external" }], nextCursor: null }); await list;
    expect(client.ownsThread("external")).toBe(true);
    expect(await client.sendRequest("thread/loaded/list")).toEqual({ data: [] }); client.dispose();
  });
  it("delivers native questions once and waits for acknowledged multi-select answers", async () => {
    const { client, sent, reply } = fixture(); const onRequest = vi.fn(); client.setHandlers({ onRequest });
    const request = { id: "harness-mix:approval:1", method: "item/tool/requestUserInput", params: { threadId: "external", questions: [] } };
    client.receive(JSON.stringify(request)); client.receive(JSON.stringify(request));
    expect(onRequest).toHaveBeenCalledTimes(1);
    const result = { answers: { question: { answers: ["A", "B"] } } };
    const one = client.respond(request.method, { id: request.id, result });
    const two = client.respond(request.method, { id: request.id, result });
    expect(sent).toHaveLength(1); expect(sent[0].params.result).toEqual(result);
    reply({ accepted: true }); await Promise.all([one, two]);
    client.receive(JSON.stringify(request)); expect(onRequest).toHaveBeenCalledTimes(1); client.dispose();
  });
  it("never retries an uncertain execution after timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client, sent } = fixture({ timeoutMs: 25 });
      const result = expect(client.sendRequest("thread/start", { model: route })).rejects.toThrow("delivery is uncertain");
      await vi.advanceTimersByTimeAsync(26); await result;
      expect(sent).toHaveLength(1); expect(client.getPendingRequestCount()).toBe(0); client.dispose();
    } finally { vi.useRealTimers(); }
  });
});
