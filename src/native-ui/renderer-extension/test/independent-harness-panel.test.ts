import { decodeHarnessPluginRoute, encodeHarnessPluginRoute } from '@harnessmix/shared-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  applyStreamFrame,
  acknowledgeApproval,
  mergeStreamItems,
  questionResult,
  routeModelForHarness,
  threadInspectionLabel,
  threadItems,
  type StreamOverlayState,
} from '../src/independent-harness-panel.js';

describe('independent Harness panel data paths', () => {
  it('creates only explicitly external canonical routes', () => {
    expect(routeModelForHarness('codex', { id: 'gpt' })).toBeNull();
    expect(routeModelForHarness('', { id: 'gpt' })).toBeNull();
    expect(decodeHarnessPluginRoute(routeModelForHarness('codex-harness', { id: 'gpt-6' })!)).toEqual({
      harnessId: 'codex-harness', model: { id: 'gpt-6' },
    });
  });

  it('projects transcript content as plain text data, including tools and reasoning', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    expect(threadItems({ turns: [{ items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: hostile }] },
      { id: 'a', type: 'agentMessage', text: 'answer' },
      { id: 'r', type: 'reasoning', summary: [{ text: 'summary' }], content: ['detail'] },
      { id: 't', type: 'commandExecution', command: 'pwd', aggregatedOutput: 'C:/work' },
    ] }] })).toEqual([
      { id: 'u', kind: 'user', label: '你', text: hostile },
      { id: 'a', kind: 'assistant', label: 'Harness', text: 'answer' },
      { id: 'r', kind: 'reasoning', label: '思考', text: 'summary\ndetail' },
      { id: 't', kind: 'tool', label: 'pwd', text: 'C:/work' },
    ]);
  });

  it('preserves every answer in multi-question and multi-choice results', () => {
    expect(questionResult({ questions: [{ id: 'editor' }, { id: 'checks' }] }, {
      editor: ['VS Code'], checks: ['unit', 'typecheck'],
    })).toEqual({ answers: {
      editor: { answers: ['VS Code'] }, checks: { answers: ['unit', 'typecheck'] },
    } });
  });

  it('removes an approval only after its response is acknowledged', async () => {
    let resolve!: () => void; const response = new Promise<void>(done => { resolve = done; });
    const client = { respond: vi.fn(() => response) }; const onAck = vi.fn();
    const pending = acknowledgeApproval(client, 'approval-1', { decision: 'accept' }, onAck);
    expect(onAck).not.toHaveBeenCalled(); resolve(); await pending;
    expect(client.respond).toHaveBeenCalledWith('approval-1', { decision: 'accept' }); expect(onAck).toHaveBeenCalledOnce();
  });

  it('reports the effective existing-thread Harness and encoded model without selecting it', () => {
    const route = encodeHarnessPluginRoute({ harnessId: 'pi', model: { id: 'provider~model' } });
    expect(threadInspectionLabel({ owner: 'external', harnessId: 'pi', transportModelId: route, resolvedModelLabel: 'Pi Provider Model', effectiveThinkingOptionId: 'high' })).toBe('pi · Pi Provider Model · high');
    expect(threadInspectionLabel({ owner: 'codex', locked: true })).toBe('');
  });

  it('deduplicates the initial full item echo but preserves a repeated legitimate token', () => {
    const state: StreamOverlayState = new Map();
    expect(applyStreamFrame(state, { method: 'item/started', params: { threadId: 't', item: { id: 'a', type: 'agentMessage', text: '你好' } } }, 't')).toBe('handled');
    applyStreamFrame(state, { method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'a', delta: '你好' } }, 't');
    expect(state.get('a')?.view.text).toBe('你好');
    applyStreamFrame(state, { method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'a', delta: '你好' } }, 't');
    expect(state.get('a')?.view.text).toBe('你好你好');
  });

  it('treats completion as authoritative and isolates threads and missing shapes', () => {
    const state: StreamOverlayState = new Map();
    expect(applyStreamFrame(state, { method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'a', delta: 'x' } }, 't')).toBe('ignored');
    expect(applyStreamFrame(state, { method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'x' } }, 't')).toBe('fallback');
    applyStreamFrame(state, { method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'a', delta: 'partial' } }, 't');
    applyStreamFrame(state, { method: 'item/completed', params: { threadId: 't', item: { id: 'a', type: 'agentMessage', text: 'authoritative' } } }, 't');
    expect(mergeStreamItems([{ id: 'a', kind: 'assistant', label: 'Harness', text: 'old' }], state)).toEqual([
      { id: 'a', kind: 'assistant', label: 'Harness', text: 'authoritative' },
    ]);
  });
});
