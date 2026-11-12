import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAttentionThread } from '../src/attention-navigation.js';

afterEach(() => vi.useRealTimers());
describe('Attention native chat navigation', () => {
  it('opens hidden chats through the native deep link and waits for arrival', async () => {
    vi.useFakeTimers();
    let open = false;
    const sendMessageFromView = vi.fn(async () => undefined);
    const openSidebar = vi.fn();
    const promise = openAttentionThread('thread/with?characters', new AbortController().signal, {
      bridge: { sendMessageFromView }, isOpen: () => open, openSidebar,
    });
    let arrived = false;
    void promise.then(() => { arrived = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(arrived).toBe(false);
    expect(sendMessageFromView).toHaveBeenCalledWith({ type: 'open-in-browser',
      url: 'codex://threads/thread%2Fwith%3Fcharacters?hostId=local', originHostId: 'local',
      initiator: 'open_in_browser_bridge', source: 'manual' });
    expect(openSidebar).not.toHaveBeenCalled();
    open = true;
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not acknowledge a missing chat just because the bridge accepted a message', async () => {
    vi.useFakeTimers();
    const promise = openAttentionThread('missing', new AbortController().signal, {
      bridge: { sendMessageFromView: vi.fn() }, isOpen: () => false, openSidebar: vi.fn(), timeoutMs: 200,
    });
    const result = expect(promise).rejects.toThrow('did not open');
    await vi.advanceTimersByTimeAsync(200);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels arrival polling when the board is disposed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = openAttentionThread('next', controller.signal, {
      bridge: { sendMessageFromView: vi.fn() }, isOpen: () => false, openSidebar: vi.fn(),
    });
    const result = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the existing sidebar opener on older Desktop versions', async () => {
    let open = false;
    const openSidebar = vi.fn(async () => { open = true; });
    await openAttentionThread('existing', new AbortController().signal, { isOpen: () => open, openSidebar });
    expect(openSidebar).toHaveBeenCalledOnce();
  });
});
