import { describe, expect, it, vi } from 'vitest';
import {
  createNativeQueuedMessageStorage,
  migrateExternalQueuedMessages,
} from '../src/native-queued-message-storage.js';

describe('native Harness queue storage', () => {
  it('persists updates under its own key and notifies subscribers', async () => {
    const values = new Map<string, unknown>();
    const require = ((id: string) => id === 'kpIY' ? {
      TB: (key: string, fallback: unknown) => values.get(key) ?? fallback,
      jx: (key: string, value: unknown) => { values.set(key, value); },
    } : {}) as any;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, work: () => unknown) => work() } });
    const storage = createNativeQueuedMessageStorage(require);
    const changed = vi.fn();
    storage.subscribeQueuedFollowUps(changed);
    await storage.updateQueuedFollowUps(() => ({ external: [{ id: 'message', pausedReason: 'paused' }] }));
    expect((await storage.loadQueuedFollowUps()).external[0].pausedReason).toBe('paused');
    expect(changed).toHaveBeenCalledTimes(1);
    expect([...values.keys()]).toEqual(['harnessmix.native.queued-follow-ups.v1']);
    vi.unstubAllGlobals();
  });

  it('persists before CAS-removing only proven external stock entries', async () => {
    const externalQueue = [{ id: 'external-message', pausedReason: 'no rollout' }];
    let stock = { external: externalQueue, official: [{ id: 'official-message' }] };
    const durable = new Map<string, unknown>();
    const queueAtom = {};
    const require = ((id: string) => id === 'kpIY' ? {
      TB: (key: string, fallback: unknown) => durable.get(key) ?? fallback,
      jx: (key: string, value: unknown) => { durable.set(key, value); },
    } : id === 'wkUO' ? {
      Zj: queueAtom,
      CN: async (_scope: unknown, update: (value: unknown) => any) => { stock = update(stock); },
    } : {}) as any;
    const scope = { get: vi.fn(() => ({ data: { state: stock } })) } as any;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, work: () => unknown) => work() } });
    const storage = createNativeQueuedMessageStorage(require);
    await expect(migrateExternalQueuedMessages({
      webpackRequire: require, scope, storage, ownsThread: (id) => id === 'external',
    })).resolves.toEqual(['external']);
    expect(stock).toEqual({ official: [{ id: 'official-message' }] });
    expect((await storage.loadQueuedFollowUps()).external).toEqual(externalQueue);
    vi.unstubAllGlobals();
  });

  it('refreshes another instance and rolls back only its own key on migration conflict', async () => {
    const durable = new Map<string, unknown>();
    const queueAtom = {};
    let stock: Record<string, any> = { external: [{ id: 'old' }] };
    const require = ((id: string) => id === 'kpIY' ? {
      TB: (key: string, fallback: unknown) => durable.get(key) ?? fallback,
      jx: (key: string, value: unknown) => { durable.set(key, value); },
    } : id === 'wkUO' ? {
      Zj: queueAtom,
      CN: async (_scope: unknown, update: (value: unknown) => any) => {
        stock = { external: [{ id: 'changed-concurrently' }] };
        stock = update(stock);
      },
    } : {}) as any;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, work: () => unknown) => work() } });
    const first = createNativeQueuedMessageStorage(require);
    const second = createNativeQueuedMessageStorage(require);
    await first.updateQueuedFollowUps(() => ({ unrelated: [{ id: 'keep' }] }));
    expect((await second.loadQueuedFollowUps()).unrelated[0].id).toBe('keep');
    const scope = { get: vi.fn(() => ({ data: { state: { external: [{ id: 'old' }] } } })) } as any;
    await expect(migrateExternalQueuedMessages({
      webpackRequire: require, scope, storage: first, ownsThread: (id) => id === 'external',
    })).rejects.toThrow(/changed during/);
    expect(await first.loadQueuedFollowUps()).toEqual({ unrelated: [{ id: 'keep' }] });
    expect(stock.external[0].id).toBe('changed-concurrently');
    vi.unstubAllGlobals();
  });
});
