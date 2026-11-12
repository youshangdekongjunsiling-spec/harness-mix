import { expect, it, vi } from 'vitest';
import { installNativeApprovalAcknowledgementGate } from '../src/native-manager-approval-gate.js';

function fixture() {
  const dispatch = vi.fn();
  const manager = {
    sendAppServerResponse: dispatch,
    pending: true,
    applied: undefined as unknown,
    replyWithUserInputResponse(_thread: string, id: string, result: unknown) {
      if (!this.pending) return;
      this.sendAppServerResponse('item/tool/requestUserInput', { id, result });
      this.applied = result; this.pending = false;
    },
  };
  return { manager, dispatch };
}

it('retains the native question until acknowledged and preserves multiple answers', async () => {
  const { manager, dispatch } = fixture();
  let resolve!: () => void;
  const respond = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  const dispose = installNativeApprovalAcknowledgementGate(manager, respond);
  const result = { answers: { q: { answers: ['A', 'B'] } } };
  const work = manager.replyWithUserInputResponse('thread', 'approval', result);
  expect(manager.pending).toBe(true); expect(manager.applied).toBeUndefined();
  expect(manager.sendAppServerResponse).toBe(dispatch);
  expect(respond).toHaveBeenCalledWith('item/tool/requestUserInput', { id: 'approval', result });
  resolve(); await work;
  expect(manager.pending).toBe(false); expect(manager.applied).toEqual(result);
  expect(dispatch).not.toHaveBeenCalled(); dispose();
});

it('leaves the original native request retryable after a failed acknowledgement', async () => {
  const { manager } = fixture();
  const respond = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const dispose = installNativeApprovalAcknowledgementGate(manager, respond);
  await expect(manager.replyWithUserInputResponse('thread', 'approval', { answers: {} })).rejects.toThrow('offline');
  expect(manager.pending).toBe(true);
  await manager.replyWithUserInputResponse('thread', 'approval', { answers: {} });
  expect(manager.pending).toBe(false); dispose();
});

it('deduplicates repeated clicks and rejects a conflicting answer while delivery is pending', async () => {
  const { manager } = fixture(); let resolve!: () => void;
  const respond = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  const dispose = installNativeApprovalAcknowledgementGate(manager, respond);
  const one = manager.replyWithUserInputResponse('t', 'a', { answers: {} });
  const two = manager.replyWithUserInputResponse('t', 'a', { answers: {} });
  expect(one).toBe(two);
  await expect(manager.replyWithUserInputResponse('t', 'a', { answers: { q: ['other'] } })).rejects.toThrow('different answer');
  expect(respond).toHaveBeenCalledTimes(1); resolve(); await one; dispose();
});
