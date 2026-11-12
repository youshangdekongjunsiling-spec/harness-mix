import { DEFAULT_RENDERER_AGENTS } from "./agent-selection-state.js";
import { createIndependentSidecarClient } from "./independent-sidecar-client.js";
import { installIndependentHarnessPanel } from "./independent-harness-panel.js";

declare global {
  interface Window {
    __harnessmixSidecarSendV1?: (frame: string) => void;
    __harnessmixSidecarReceiveV1?: (frame: string) => void;
    __harnessmixPendingSidecarFramesV1?: string[];
    __harnessmixIndependentPanelV1?: {
      status(): { version: 2; enabledAgents: string[]; adapter: { state: "ready"; reason: string } };
      recoverPendingApprovals(): void;
      inspectConnection(): Promise<{ threadCount: number; pendingInteractionCount: number }>;
      dispose(): void;
      open(): void;
    };
  }
}

/** Own UI and own Host transport: no private native manager or native composer. */
export function installIndependentHarness(): void {
  window.__harnessmixIndependentPanelV1?.dispose();
  window.__harnessmixRendererBindingProbeV1?.dispose();
  const oldPolicy = window.__harnessmixDraftPrewarmPolicyV1 as unknown as { dispose?(): void } | undefined;
  oldPolicy?.dispose?.();
  const client = createIndependentSidecarClient((frame) => {
    if (typeof window.__harnessmixSidecarSendV1 !== "function") throw new Error("Harness 通道尚未连接");
    window.__harnessmixSidecarSendV1(frame);
  });
  window.__harnessmixSidecarReceiveV1 = client.receive;
  for (const frame of window.__harnessmixPendingSidecarFramesV1?.splice(0) ?? []) client.receive(frame);
  const panel = installIndependentHarnessPanel(client);
  const control = {
    status: () => ({ version: 2 as const, enabledAgents: [...DEFAULT_RENDERER_AGENTS], adapter: { state: "ready" as const, reason: "independent-sidecar-panel" } }),
    recoverPendingApprovals: () => client.reconnect(),
    async inspectConnection() {
      const page = await client.request("harnessmix/thread/list", { archived: false });
      return { threadCount: Array.isArray(page?.data) ? page.data.length : 0, pendingInteractionCount: client.pendingApprovals().length };
    },
    open: () => panel.open(),
    dispose() {
      panel.dispose(); client.dispose();
      if (window.__harnessmixSidecarReceiveV1 === client.receive) delete window.__harnessmixSidecarReceiveV1;
      if (window.__harnessmixIndependentPanelV1 === control) delete window.__harnessmixIndependentPanelV1;
    },
  };
  window.__harnessmixIndependentPanelV1 = control;
}
