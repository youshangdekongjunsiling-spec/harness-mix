/**
 * Production bundle entrypoint. The controller injects this script on every
 * document load with __harnessmixProductionConfigV1 already set; consume and
 * delete it so the page cannot re-read our configuration.
 */
import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { installRendererBinding } from "./install-renderer-binding.js";
import { installRateLimitComposerUnlock } from "./renderer-rate-limit-unlock.js";
import { installNativeRendererManager } from './install-native-renderer-manager.js';

declare global {
  interface Window {
    __harnessmixProductionConfigV1?: {
      defaultAgent: RendererAgent;
    };
  }
}

const configuration = window.__harnessmixProductionConfigV1;
delete window.__harnessmixProductionConfigV1;

const install = async (): Promise<void> => {
  installRateLimitComposerUnlock();
  const publishBinding = () => {
    installRendererBinding(DEFAULT_RENDERER_AGENTS, configuration?.defaultAgent ?? "codex");
  };
  const nativeBinding = await installNativeRendererManager(publishBinding);
  if (!nativeBinding) publishBinding();
};

// In sidecar mode the renderer must wait for the draft prewarm policy bridge
// (installed separately) before binding — it provides the transport.
const installWhenTransportReady = (): void => {
  void install().catch((error) => {
    console.error('harnessmix native Renderer manager installation failed', error);
    // No substitute UI is installed. Official Codex remains on the untouched
    // stock RPC while the external route stays explicitly unsupported.
  });
};

if (document.documentElement && document.body) {
  installWhenTransportReady();
} else {
  window.addEventListener("DOMContentLoaded", installWhenTransportReady, { once: true });
}
