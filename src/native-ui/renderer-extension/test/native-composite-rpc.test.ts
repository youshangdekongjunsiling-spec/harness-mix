import { describe, expect, it, vi } from 'vitest';
import { createNativeCompositeRpc } from '../src/native-composite-rpc.js';

describe('native composite RPC', () => {
  it('keeps unknown and official thread calls on the stock RPC', () => {
    const official = { getConversation: vi.fn(() => 'official') };
    const external = { getConversation: vi.fn(() => 'external') };
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-1']), {
      routeTurnCoordinator: true,
    });

    expect(rpc.getConversation('official-1')).toBe('official');
    expect(official.getConversation).toHaveBeenCalledWith('official-1');
    expect(external.getConversation).not.toHaveBeenCalled();
  });

  it('routes every method with a proven positional external thread ID', () => {
    const official = { replyWithUserInputResponse: vi.fn() };
    const external = { replyWithUserInputResponse: vi.fn(() => 'ack') };
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-1']), {
      routeTurnCoordinator: true,
    });

    expect(rpc.replyWithUserInputResponse('external-1', { answers: {} })).toBe('ack');
    expect(official.replyWithUserInputResponse).not.toHaveBeenCalled();
  });

  it('routes selected starts, blocks external prewarm, and preserves stock defaults', async () => {
    let selected = true;
    const official = {
      startConversation: vi.fn(() => 'official-start'),
      prepareThreadStart: vi.fn(() => 'official-prepare'),
      prewarmConversation: vi.fn(() => 'official-prewarm'),
    };
    const external = {
      startConversation: vi.fn(() => 'external-start'),
      prepareThreadStart: vi.fn(() => 'external-prepare'),
      prewarmConversation: vi.fn(() => 'external-prewarm'),
    };
    const rpc = createNativeCompositeRpc(official, external, new Set(), {
      isExternalSelected: () => selected,
    });

    expect(rpc.prepareThreadStart({})).toBe('external-prepare');
    expect(rpc.startConversation({})).toBe('external-start');
    await expect(rpc.prewarmConversation({})).resolves.toBeNull();
    selected = false;
    expect(rpc.startConversation({})).toBe('official-start');
    expect(external.prewarmConversation).not.toHaveBeenCalled();
  });

  it('splits mixed thread arrays without sending external IDs to stock RPC', async () => {
    const official = { hydrateBackgroundThreads: vi.fn() };
    const external = { hydrateBackgroundThreads: vi.fn() };
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-1']));

    await rpc.hydrateBackgroundThreads(['official-1', 'external-1']);
    expect(official.hydrateBackgroundThreads).toHaveBeenCalledWith(['official-1']);
    expect(external.hydrateBackgroundThreads).toHaveBeenCalledWith(['external-1']);
  });

  it('refreshes both catalogs while sidecar failures cannot break the stock result', async () => {
    const official = { refreshRecentConversations: vi.fn(async () => 2) };
    const external = { refreshRecentConversations: vi.fn(async () => 3) };
    const rpc = createNativeCompositeRpc(official, external, new Set());
    await expect(rpc.refreshRecentConversations()).resolves.toBe(5);

    external.refreshRecentConversations.mockRejectedValueOnce(new Error('disconnected'));
    await expect(rpc.refreshRecentConversations()).resolves.toBe(2);
  });

  it('lazily hydrates a proven cold external thread returned by a native thenable', async () => {
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });
    const official = { getNavigationRuntimeState: vi.fn(() => 'hot') };
    const external = {
      getNavigationRuntimeState: vi.fn(() => ({
        then(resolve: (value: string) => void) { resolve('cold'); },
      })),
      hydrateBackgroundThreads: vi.fn(() => hydration),
      ensureConversationHistoryLoaded: vi.fn(),
    };
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-1']));

    await expect(rpc.getNavigationRuntimeState('external-1')).resolves.toBe('unknown');
    await expect(rpc.getNavigationRuntimeState('external-1')).resolves.toBe('unknown');
    expect(external.hydrateBackgroundThreads).toHaveBeenCalledTimes(1);
    expect(external.hydrateBackgroundThreads).toHaveBeenCalledWith(['external-1']);
    expect(external.ensureConversationHistoryLoaded).not.toHaveBeenCalled();
    expect(official.getNavigationRuntimeState).not.toHaveBeenCalled();
    finishHydration();
    await hydration;
    await Promise.resolve();
    expect(external.ensureConversationHistoryLoaded).toHaveBeenCalledWith('external-1');
  });

  it('defers turn coordinator routing until its methods receive a conversation id', async () => {
    const officialCoordinator = {
      sendMessage: vi.fn(async () => 'official'),
      removeQueuedMessage: vi.fn(async () => 'official-removed'),
    };
    const externalCoordinator = {
      sendMessage: vi.fn(async () => 'external'),
      removeQueuedMessage: vi.fn(async () => 'external-removed'),
    };
    const official = { getTurnCoordinator: vi.fn(() => officialCoordinator) };
    const external = { getTurnCoordinator: vi.fn(() => externalCoordinator) };
    const owned = new Set(['external-1']);
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-1']), {
      routeTurnCoordinator: true,
      createTurnCoordinatorTarget: (left, right) => createNativeCompositeRpc(left, right, owned),
    });

    const coordinator = rpc.getTurnCoordinator();
    await expect(coordinator.sendMessage('external-1', { id: 'message-1' })).resolves.toBe('external');
    await expect(coordinator.removeQueuedMessage('official-1', 'message-2')).resolves.toBe('official-removed');
    expect(externalCoordinator.sendMessage).toHaveBeenCalledWith('external-1', { id: 'message-1' });
    expect(officialCoordinator.sendMessage).not.toHaveBeenCalled();
    expect(officialCoordinator.removeQueuedMessage).toHaveBeenCalledWith('official-1', 'message-2');
    expect(externalCoordinator.removeQueuedMessage).not.toHaveBeenCalled();
    expect(official.getTurnCoordinator).toHaveBeenCalledTimes(1);
    expect(external.getTurnCoordinator).toHaveBeenCalledTimes(1);
    expect(rpc.getTurnCoordinator()).not.toBe(coordinator);
  });

  it('dually registers coordinator callbacks and disposes both native registrations', () => {
    const leftCallable = vi.fn() as any;
    const leftDispose = vi.fn();
    leftCallable[Symbol.dispose] = leftDispose;
    let rightDisposeCount = 0;
    const rightDispose = Object.assign(() => { rightDisposeCount += 1; }, {
      [Symbol.dispose]: undefined,
    });
    const official = { registerReplayAdmission: vi.fn(() => leftCallable) };
    const external = { registerReplayAdmission: vi.fn(() => rightDispose) };
    const rpc = createNativeCompositeRpc(official, external, new Set());
    const callback = vi.fn();

    const dispose = rpc.registerReplayAdmission(callback);
    expect(official.registerReplayAdmission).toHaveBeenCalledWith(callback);
    expect(external.registerReplayAdmission).toHaveBeenCalledWith(callback);
    dispose();
    expect(leftDispose).toHaveBeenCalledTimes(1);
    expect(leftCallable).not.toHaveBeenCalled();
    expect(rightDisposeCount).toBe(1);
  });
  it('binds the selected carrier before native asynchronous creation clears the draft', async () => {
    let selected: string | null = 'harnessmix/claude-code-native@eyJpZCI6ImZhYmxlIn0';
    const official = { startConversation: vi.fn() };
    const external = { startConversation: vi.fn(async (params) => {
      selected = null;
      await Promise.resolve();
      return params;
    }) };
    const rpc = createNativeCompositeRpc(official, external, new Set(), {
      isExternalSelected: () => selected !== null, externalStartModel: () => selected,
    });
    const result = await rpc.startConversation({ collaborationMode: { settings: { model: 'gpt', reasoning_effort: 'high' } } });
    expect(result.model).toContain('harnessmix/claude-code-native');
    expect(result.collaborationMode.settings.model).toBe(result.model);
    expect(result.collaborationMode.settings.reasoning_effort).toBe('high');
    expect(official.startConversation).not.toHaveBeenCalled();
  });

});
