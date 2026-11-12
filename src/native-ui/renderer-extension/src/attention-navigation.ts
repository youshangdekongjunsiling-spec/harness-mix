import { hostThreadIdSchema } from '@harnessmix/shared-contracts';
import { openRendererThread } from './renderer-fork-control.js';
import { CODEX_COMPOSER_SELECTOR } from './renderer-composer-dom.js';
import { findComposerModelTarget } from './versioned-renderer-adapter.js';

type NavigationBridge = { sendMessageFromView(message: unknown): unknown };
export interface AttentionNavigationEnvironment {
  bridge?: NavigationBridge;
  isOpen(threadId: string): boolean;
  openSidebar(threadId: string, signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
}

function nativeEnvironment(): AttentionNavigationEnvironment {
  const owner = window as unknown as { electronBridge?: NavigationBridge };
  return {
    ...(owner.electronBridge ? { bridge: owner.electronBridge } : {}),
    isOpen(threadId) {
      if (window.location.pathname === `/local/${encodeURIComponent(threadId)}`) return true;
      return [...document.querySelectorAll<HTMLElement>(CODEX_COMPOSER_SELECTOR)].some(composer => {
        if (!composer.getClientRects().length) return false;
        const target = findComposerModelTarget(composer);
        return target?.[0] === 'conversation' && target[1] === threadId;
      });
    },
    openSidebar: (threadId, signal) => openRendererThread(hostThreadIdSchema.parse(threadId), { hostId: 'local', signal }),
  };
}

/** Use Desktop's own deep-link handler so a chat need not be mounted in the sidebar.
 * Confirm the visible native route before the workbench acknowledges its notification.
 * Contract: Desktop 26.1013 open-in-browser -> queueCodexDeepLinkUrl -> /local/:id.
 */
export async function openAttentionThread(threadId: string, signal: AbortSignal, environment = nativeEnvironment()): Promise<void> {
  const aborted = () => Object.assign(new Error('Thread opening was aborted'), { name: 'AbortError' });
  if (signal.aborted) throw aborted();
  if (environment.isOpen(threadId)) return;
  if (typeof environment.bridge?.sendMessageFromView !== 'function') {
    await environment.openSidebar(threadId, signal);
  } else {
    await environment.bridge.sendMessageFromView({
      type: 'open-in-browser',
      url: `codex://threads/${encodeURIComponent(threadId)}?hostId=local`,
      originHostId: 'local',
      initiator: 'open_in_browser_bridge',
      source: 'manual',
    });
  }
  if (signal.aborted) throw aborted();
  if (environment.isOpen(threadId)) return;
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const cleanup = () => { clearInterval(timer); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(aborted()); };
    const timer = setInterval(() => {
      if (environment.isOpen(threadId)) { cleanup(); resolve(); }
      else if (Date.now() - started >= (environment.timeoutMs ?? 8000)) { cleanup(); reject(new Error('Desktop did not open the requested thread')); }
    }, 100);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
