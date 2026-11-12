import { decodeHarnessPluginRoute, encodeHarnessPluginRoute } from '@harnessmix/shared-contracts';

import css from './independent-harness-panel.css';
import type { IndependentSidecarClient } from './independent-sidecar-client.js';
import { independentRequestId } from './independent-sidecar-client.js';

type AnyRecord = Record<string, any>;
type ViewItem = { id: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool'; label: string; text: string };
type HarnessOption = { id: string; name: string; available: boolean };
export type StreamOverlayState = Map<string, { view: ViewItem; initialText: string; echoSkipped: boolean; completed: boolean }>;

export interface IndependentHarnessPanelControl {
  dispose(): void;
  open(): void;
  status(): { state: 'ready'; reason: 'independent-sidecar-panel' };
}

export function routeModelForHarness(harnessId: string, model?: AnyRecord): string | null {
  if (!harnessId || harnessId === 'codex') return null;
  return encodeHarnessPluginRoute({ harnessId: harnessId as any, ...(model ? { model } : {}) } as any);
}

function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const record = value as AnyRecord;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

export function threadItems(thread: AnyRecord | null): ViewItem[] {
  const result: ViewItem[] = [];
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const projected = projectItem(item, String(item?.id ?? result.length)); if (projected) result.push(projected);
    }
  }
  return result;
}

function projectItem(item: AnyRecord, fallbackId = ''): ViewItem | null {
  const id = String(item?.id ?? fallbackId);
  if (!id) return null;
  if (item?.type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [{ type: 'text', text: item.text }];
    const text = content.map((part: AnyRecord) => part?.type === 'text' ? readable(part.text)
      : part?.type === 'image' || part?.type === 'localImage' ? '[图片]' : '').filter(Boolean).join('\n');
    return { id, kind: 'user', label: '你', text };
  }
  if (item?.type === 'agentMessage') return { id, kind: 'assistant', label: item.phase === 'commentary' ? '进展' : 'Harness', text: readable(item.text ?? item.content) };
  if (item?.type === 'reasoning') return { id, kind: 'reasoning', label: '思考', text: readable([...(item.summary ?? []), ...(item.content ?? [])]) };
  if (['commandExecution', 'dynamicToolCall', 'mcpToolCall', 'fileChange'].includes(item?.type)) {
    const output = item.aggregatedOutput ?? item.output ?? item.result ?? item.changes ?? item.status ?? '';
    return { id, kind: 'tool', label: readable(item.command ?? item.tool ?? item.server ?? item.type), text: readable(output) };
  }
  return null;
}

export function applyStreamFrame(state: StreamOverlayState, frame: AnyRecord, threadId: string): 'handled' | 'fallback' | 'ignored' {
  if (frame?.params?.threadId !== threadId) return 'ignored';
  const method = String(frame?.method ?? '');
  if (method === 'item/started') {
    const view = projectItem(frame.params?.item); if (!view) return 'fallback';
    state.set(view.id, { view, initialText: view.text, echoSkipped: false, completed: false }); return 'handled';
  }
  if (method === 'item/completed') {
    const view = projectItem(frame.params?.item); if (!view) return 'fallback';
    state.set(view.id, { view, initialText: view.text, echoSkipped: true, completed: true }); return 'handled';
  }
  const deltaKinds: Record<string, Pick<ViewItem, 'kind' | 'label'>> = {
    'item/agentMessage/delta': { kind: 'assistant', label: 'Harness' },
    'item/reasoning/summaryTextDelta': { kind: 'reasoning', label: '思考' },
    'item/reasoning/textDelta': { kind: 'reasoning', label: '思考' },
    'item/commandExecution/outputDelta': { kind: 'tool', label: '命令输出' },
  };
  const kind = deltaKinds[method];
  if (kind) {
    const id = String(frame.params?.itemId ?? ''), delta = readable(frame.params?.delta); if (!id) return 'fallback';
    const entry = state.get(id) ?? { view: { id, ...kind, text: '' }, initialText: '', echoSkipped: false, completed: false };
    if (!entry.echoSkipped && entry.initialText && delta === entry.initialText) entry.echoSkipped = true;
    else entry.view = { ...entry.view, text: entry.view.text + delta };
    state.set(id, entry); return 'handled';
  }
  return 'fallback';
}

export function mergeStreamItems(items: ViewItem[], state: StreamOverlayState): ViewItem[] {
  const result = items.map(item => state.get(item.id)?.view ?? item), known = new Set(items.map(item => item.id));
  for (const [id, entry] of state) if (!known.has(id)) result.push(entry.view);
  return result;
}

export function questionResult(params: AnyRecord, values: Record<string, string[]>): AnyRecord {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of Array.isArray(params.questions) ? params.questions : []) {
    const id = String(question.id ?? 'question'); answers[id] = { answers: values[id] ?? [] };
  }
  return { answers };
}

export function threadInspectionLabel(inspection: AnyRecord | null): string {
  if (inspection?.owner !== 'external') return '';
  let route: ReturnType<typeof decodeHarnessPluginRoute> = null;
  try { route = typeof inspection.transportModelId === 'string' ? decodeHarnessPluginRoute(inspection.transportModelId) : null; } catch { /* malformed metadata must not break the panel */ }
  return [
    String(inspection.harnessId ?? route?.harnessId ?? ''),
    inspection.resolvedModelLabel ? String(inspection.resolvedModelLabel) : '',
    inspection.effectiveThinkingOptionId ? String(inspection.effectiveThinkingOptionId) : '',
  ].filter(Boolean).join(' · ');
}

export async function acknowledgeApproval(client: Pick<IndependentSidecarClient, 'respond'>, id: string | number, result: unknown, onAck: () => void): Promise<void> {
  await client.respond(id, result); onAck();
}

export function installIndependentHarnessPanel(client: IndependentSidecarClient): IndependentHarnessPanelControl {
  const lifetime = new AbortController();
  const host = document.createElement('div'); host.setAttribute('data-harnessmix-independent-panel', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = `${css}\n.approvals{max-height:calc(100% - 170px);overflow:auto}`;
  const launcher = el('button', 'launcher', 'Harness 对话'); launcher.type = 'button';
  const dialog = document.createElement('dialog'); dialog.className = 'panel'; dialog.setAttribute('aria-label', 'Harness 独立对话');
  const live = el('div', 'sr'); live.setAttribute('aria-live', 'polite');
  shadow.append(style, launcher, dialog, live); document.body.append(host);

  let disposed = false, loading = false, sending = false, connected = false, running = false;
  let activeTurnId: string | null = null, selectedThreadId: string | null = null, selectedThread: AnyRecord | null = null, selectedInspection: AnyRecord | null = null;
  let generation = 0, threads: AnyRecord[] = [], baseItems: ViewItem[] = [], harnesses: HarnessOption[] = [], catalog: AnyRecord | null = null;
  let selectedHarness = '', selectedModel = '', catalogHarness = '', catalogLoading = false, error = '', draftText = '', cwdText = '', refreshTimer: ReturnType<typeof setTimeout> | null = null, renderTimer: ReturnType<typeof setTimeout> | null = null, refreshInFlight = false, refreshAgain = false, preserveHistoryScroll = false, catalogGeneration = 0, streamVersion = 0, visibleCount = 300;
  const streamOverlay: StreamOverlayState = new Map();
  const approvals = new Map<string | number, AnyRecord>(), resolvedApprovals = new Set<string | number>(), responding = new Set<string | number>();
  const questionDrafts = new Map<string | number, Record<string, string[]>>();
  const persistedDrafts = readDrafts();

  launcher.addEventListener('click', () => open(), { signal: lifetime.signal });
  dialog.addEventListener('close', () => launcher.focus(), { signal: lifetime.signal });
  const unsubscribe = client.subscribe(onFrame); syncApprovals();

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
  }
  function button(text: string, action: () => void, cls = ''): HTMLButtonElement {
    const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value || '未知错误');
  const forSelected = (frame: AnyRecord): boolean => !!selectedThreadId && frame?.params?.threadId === selectedThreadId;
  const approvalKey = (frame: AnyRecord): string | number | null => frame?.id == null ? null : frame.id;
  function draftKey(threadId = selectedThreadId): string { return threadId ? `thread:${threadId}` : `new:${cwdText.trim()}`; }
  function readDrafts(): Record<string, string> {
    try { return JSON.parse(sessionStorage.getItem('harnessmix-independent-drafts-v1') ?? '{}'); } catch { return {}; }
  }
  function saveDraft(): void {
    persistedDrafts[draftKey()] = draftText;
    try { sessionStorage.setItem('harnessmix-independent-drafts-v1', JSON.stringify(persistedDrafts)); } catch { /* session storage may be disabled */ }
  }

  function registerApproval(frame: AnyRecord): void {
    const id = approvalKey(frame);
    if (id == null || typeof frame.method !== 'string' || resolvedApprovals.has(id)) return;
    if (!['item/commandExecution/requestApproval', 'item/tool/requestUserInput'].includes(frame.method)) return;
    if (!approvals.has(id)) approvals.set(id, frame); updateLauncher();
  }
  function updateLauncher(): void { launcher.textContent = approvals.size ? `Harness 对话（${approvals.size} 项待处理）` : 'Harness 对话'; }
  function syncApprovals(): void {
    const pending = client.pendingApprovals(), ids = new Set<string | number>();
    for (const frame of pending) { const id = approvalKey(frame); if (id != null) ids.add(id); registerApproval(frame); }
    for (const id of approvals.keys()) if (!ids.has(id) && !responding.has(id)) approvals.delete(id); updateLauncher();
  }
  function onFrame(frame: AnyRecord): void {
    if (disposed) return;
    if (frame.method === 'harnessmix/transport/error') { connected = false; error = String(frame.params?.message ?? 'Harness 后台连接中断'); render(); return; }
    if (frame.method === 'harnessmix/transport/reconnected') { connected = true; error = ''; syncApprovals(); void loadThreads(false); if (selectedThreadId) scheduleRefresh(); render(); return; }
    if (frame.method === 'harnessmix/interaction/responded') {
      const id = frame.params?.requestId ?? frame.params?.id;
      if (id != null) { approvals.delete(id); responding.delete(id); resolvedApprovals.add(id); updateLauncher(); }
      render(); return;
    }
    registerApproval(frame);
    if (!forSelected(frame)) { if (/^(thread\/(started|archived|unarchived|status\/changed)|turn\/completed)$/.test(frame.method ?? '')) void loadThreads(false); if (dialog.open && frame.id != null && approvals.has(frame.id)) render(); return; }
    if (frame.method === 'turn/started') { running = true; activeTurnId = String(frame.params?.turn?.id ?? frame.params?.turnId ?? '') || null; scheduleRender(); return; }
    if (frame.method === 'turn/completed') { running = false; activeTurnId = null; scheduleRender(); scheduleRefresh(); return; }
    if (frame.method === 'thread/status/changed') { running = frame.params?.status?.type === 'active'; scheduleRender(); if (!running) scheduleRefresh(); return; }
    const streamed = selectedThreadId ? applyStreamFrame(streamOverlay, frame, selectedThreadId) : 'ignored';
    if (streamed === 'handled') { streamVersion += 1; scheduleRender(); if (frame.method === 'item/completed') scheduleRefresh(); return; }
    if (streamed === 'fallback') scheduleRefresh();
  }
  function scheduleRender(): void {
    if (renderTimer || !dialog.open) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150);
  }
  function scheduleRefresh(): void {
    if (refreshInFlight) { refreshAgain = true; return; }
    if (refreshTimer) return;
    const target = selectedThreadId;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null; if (target !== selectedThreadId) return;
      refreshInFlight = true;
      try { await loadSelected(target, false, false); }
      finally { refreshInFlight = false; if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
    }, 1000);
  }
  async function loadHarnesses(): Promise<void> {
    const result = await client.request('harnessmix/collaboration/agents', {});
    harnesses = (Array.isArray(result) ? result : []).filter((entry: AnyRecord) => entry?.id && entry.id !== 'codex')
      .map((entry: AnyRecord) => ({ id: String(entry.id), name: String(entry.name ?? entry.id), available: entry.available !== false }));
    if (!harnesses.some(entry => entry.id === selectedHarness)) selectedHarness = harnesses.find(entry => entry.available)?.id ?? '';
    await loadCatalog();
  }
  async function loadCatalog(): Promise<void> {
    const harnessId = selectedHarness, current = ++catalogGeneration; selectedModel = ''; catalog = null; catalogHarness = ''; catalogLoading = !!harnessId; if (!harnessId) return;
    try {
      const result = await client.request('harnessmix/harness/inspect', { harnessId });
      if (current !== catalogGeneration || harnessId !== selectedHarness) return;
      if (result?.status !== 'ready') throw new Error(result?.error?.message ?? 'Harness 暂不可用');
      catalog = result; catalogHarness = harnessId; selectedModel = String(result.catalog?.defaultModel?.id ?? result.catalog?.models?.[0]?.ref?.id ?? '');
    } finally { if (current === catalogGeneration) catalogLoading = false; }
  }
  async function loadThreads(shouldRender = true): Promise<void> {
    try { const result = await client.request('harnessmix/thread/list', { limit: 200, archived: false, sortKey: 'updated_at' }); threads = Array.isArray(result?.data) ? result.data : []; connected = true; if (shouldRender && dialog.open) render(); }
    catch (cause) { connected = false; error = `读取对话失败：${errorText(cause)}`; if (dialog.open) render(); }
  }
  async function loadSelected(threadId: string | null, resume: boolean, showLoading = true, inspect = false): Promise<void> {
    if (!threadId || disposed) return; const current = ++generation, versionAtRead = streamVersion; if (showLoading) loading = true; if (dialog.open) render();
    try {
      if (resume) await client.request('thread/resume', { threadId });
      const [read, inspection] = await Promise.all([
        client.request('thread/read', { threadId, includeTurns: true }),
        inspect ? client.request('harnessmix/thread/inspect', { threadId }) : Promise.resolve(selectedInspection),
      ]);
      if (disposed || current !== generation || selectedThreadId !== threadId) return;
      selectedThread = read?.thread ?? null; baseItems = threadItems(selectedThread); selectedInspection = inspection ?? null; running = selectedThread?.status?.type === 'active';
      if (versionAtRead === streamVersion) streamOverlay.clear();
      const active = [...(selectedThread?.turns ?? [])].reverse().find((turn: AnyRecord) => turn?.status === 'inProgress'); activeTurnId = active?.id ? String(active.id) : null;
      connected = true; if (showLoading) error = '';
    } catch (cause) { if (current === generation) error = `打开对话失败：${errorText(cause)}`; }
    finally { if (current === generation) { loading = false; if (dialog.open) render(); } }
  }
  async function selectThread(id: string): Promise<void> {
    saveDraft(); generation += 1; selectedThreadId = id; draftText = persistedDrafts[draftKey(id)] ?? ''; selectedThread = null; baseItems = []; selectedInspection = null; streamOverlay.clear(); streamVersion += 1; visibleCount = 300; running = false; activeTurnId = null; error = ''; render(); await loadSelected(id, true, true, true);
  }
  async function createThread(): Promise<string> {
    if (!cwdText.trim()) throw new Error('请输入工作目录');
    if (catalogLoading || !catalog || catalogHarness !== selectedHarness) throw new Error('模型目录尚未加载完成，请稍候');
    const model = catalog?.catalog?.models?.find((entry: AnyRecord) => entry?.ref?.id === selectedModel)?.ref;
    if ((catalog.catalog?.models?.length ?? 0) > 0 && !model) throw new Error('请选择有效模型');
    const route = routeModelForHarness(selectedHarness, model); if (!route) throw new Error('请选择 Harness 和模型');
    const created = await client.request('thread/start', { cwd: cwdText.trim(), model: route }); const id = String(created?.thread?.id ?? '');
    if (!id) throw new Error('Host 未返回新对话标识');
    selectedThreadId = id; selectedThread = created.thread; baseItems = threadItems(selectedThread); streamOverlay.clear(); streamVersion += 1; visibleCount = 300; threads = [created.thread, ...threads.filter(item => item.id !== id)]; running = created.thread?.status?.type === 'active'; return id;
  }
  async function submit(): Promise<void> {
    const text = draftText.trim(); if (!text || sending) return; sending = true; error = ''; render();
    try {
      if (selectedThreadId && selectedThread?.canAcceptDirectInput === false) throw new Error('此历史来自子代理，仅可查看');
      const threadId = selectedThreadId ?? await createThread();
      if (running) {
        if (!activeTurnId) throw new Error('当前回合仍在运行，但尚未收到回合标识；请等待状态刷新后重试');
        await client.request('turn/steer', { threadId, expectedTurnId: activeTurnId, input: [{ type: 'text', text }], clientUserMessageId: independentRequestId() });
      } else {
        const started = await client.request('turn/start', { threadId, input: [{ type: 'text', text }] }); activeTurnId = String(started?.turn?.id ?? '') || null; running = true;
      }
      draftText = ''; saveDraft(); connected = true; live.textContent = '消息已发送'; scheduleRefresh();
    } catch (cause) { error = `发送失败（未自动重试）：${errorText(cause)}`; }
    finally { sending = false; render(); }
  }
  async function cancelTurn(): Promise<void> {
    if (!selectedThreadId || !running || sending) return; sending = true; error = ''; render();
    try { await client.request('turn/interrupt', { threadId: selectedThreadId, ...(activeTurnId ? { turnId: activeTurnId } : {}) }); }
    catch (cause) { error = `停止失败：${errorText(cause)}`; } finally { sending = false; render(); }
  }
  async function settleApproval(frame: AnyRecord, result: unknown): Promise<void> {
    const id = approvalKey(frame); if (id == null || responding.has(id) || !approvals.has(id)) return;
    responding.add(id); error = ''; render();
    try { await acknowledgeApproval(client, id, result, () => { approvals.delete(id); questionDrafts.delete(id); resolvedApprovals.add(id); updateLauncher(); live.textContent = '审批结果已确认'; }); }
    catch (cause) { error = `提交审批失败，可重试：${errorText(cause)}`; }
    finally { responding.delete(id); render(); }
  }

  function renderApproval(frame: AnyRecord): HTMLElement {
    const id = approvalKey(frame)!; const params = frame.params ?? {}; const busy = responding.has(id), card = el('section', 'approval');
    card.dataset.approvalId = String(id); card.append(el('h3', '', frame.method === 'item/tool/requestUserInput' ? 'Harness 需要你的回答' : 'Harness 请求执行权限'));
    if (params.threadId) card.append(el('div', 'notice', `对话：${String(params.threadId)}`));
    if (frame.method === 'item/commandExecution/requestApproval') {
      card.append(el('div', 'approval-detail', readable(params.command ?? params.reason ?? params.item ?? '请确认是否允许此操作')));
      const row = el('div', 'row'), allow = button('允许', () => { void settleApproval(frame, { decision: 'accept' }); }, 'primary'), deny = button('拒绝', () => { void settleApproval(frame, { decision: 'decline' }); }, 'danger');
      allow.disabled = deny.disabled = busy; row.append(allow, deny); card.append(row); return card;
    }
    const questions = Array.isArray(params.questions) ? params.questions : [], saved = questionDrafts.get(id) ?? {};
    for (const [index, question] of questions.entries()) {
      const field = el('fieldset', 'question'); field.dataset.questionId = String(question.id ?? `question-${index}`); field.append(el('legend', '', String(question.header ?? question.question ?? '请选择')));
      if (question.header && question.question) field.append(el('div', 'notice', String(question.question)));
      for (const option of Array.isArray(question.options) ? question.options : []) {
        const label = el('label', 'option'), input = document.createElement('input'), questionId = String(question.id ?? `question-${index}`); input.type = question.harnessmixMultiple === true ? 'checkbox' : 'radio'; input.name = `approval-${String(id)}-${index}`; input.value = String(option.label ?? option.value ?? option); input.checked = (saved[questionId] ?? []).includes(input.value);
        input.addEventListener('change', () => { const values = saved[questionId] ?? []; saved[questionId] = input.type === 'radio' ? (input.checked ? [input.value] : []) : input.checked ? [...new Set([...values, input.value])] : values.filter(value => value !== input.value); questionDrafts.set(id, saved); });
        label.append(input, el('span', '', String(option.label ?? option.value ?? option))); if (option.description) label.append(el('small', 'notice', String(option.description))); field.append(label);
      }
      if (question.isOther) { const questionId = field.dataset.questionId!; const other = document.createElement('input'); other.type = question.isSecret ? 'password' : 'text'; other.placeholder = '其他答案'; other.dataset.other = ''; other.value = saved[questionId]?.find(value => value.startsWith('__other__:'))?.slice(10) ?? ''; other.addEventListener('input', () => { saved[questionId] = [...(saved[questionId] ?? []).filter(value => !value.startsWith('__other__:')), ...(other.value ? [`__other__:${other.value}`] : [])]; questionDrafts.set(id, saved); }); field.append(other); }
      card.append(field);
    }
    const row = el('div', 'row');
    const send = button('提交回答', () => {
      const values: Record<string, string[]> = {};
      for (const field of card.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-id]')) {
        const list = [...field.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value), other = field.querySelector<HTMLInputElement>('input[data-other]')?.value.trim();
        if (other) list.push(other); values[field.dataset.questionId!] = list;
      }
      if ((params.questions ?? []).some((question: AnyRecord, index: number) => (values[String(question.id ?? `question-${index}`)] ?? []).length === 0)) { error = '请回答每个问题，或明确选择“取消回答”'; render(); return; }
      void settleApproval(frame, questionResult(params, values));
    }, 'primary');
    const cancel = button('取消回答', () => { void settleApproval(frame, { answers: {} }); }); send.disabled = cancel.disabled = busy; row.append(send, cancel); card.append(row); return card;
  }

  function render(): void {
    if (disposed) return;
    const focused = shadow.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const focusRole = focused?.dataset?.focusRole;
    const selection: [number | null, number | null] | null = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    const previousMessages = shadow.querySelector<HTMLElement>('.messages'), previousTop = previousMessages?.scrollTop ?? 0, previousHeight = previousMessages?.scrollHeight ?? 0, wasNearBottom = !!previousMessages && previousHeight - previousTop - previousMessages.clientHeight < 48;
    dialog.replaceChildren();
    const shell = el('div', 'shell'), rail = el('aside', 'rail'), main = el('main', 'main'), brand = el('div', 'brand'), brandText = el('div');
    brandText.append(el('strong', '', 'Harness 独立对话'), el('div', 'tag', '不改变官方 Codex 通道'));
    const create = button('新建', () => { saveDraft(); const sourceCwd = selectedThread?.cwd; generation += 1; selectedThreadId = null; if (typeof sourceCwd === 'string' && sourceCwd) cwdText = sourceCwd; selectedThread = null; baseItems = []; selectedInspection = null; streamOverlay.clear(); streamVersion += 1; visibleCount = 300; running = false; activeTurnId = null; error = ''; draftText = persistedDrafts[draftKey(null)] ?? ''; render(); }); create.disabled = sending;
    brand.append(brandText, create); rail.append(brand);
    const threadList = el('div', 'threads');
    for (const thread of threads) {
      const id = String(thread.id ?? ''); if (!id) continue;
      const entry = button(String(thread.name ?? thread.title ?? '未命名对话'), () => { void selectThread(id); }, 'thread'); entry.disabled = sending; entry.setAttribute('aria-current', String(id === selectedThreadId)); entry.append(el('small', '', String(thread.cwd ?? thread.status?.type ?? id))); threadList.append(entry);
    }
    if (!threads.length) threadList.append(el('div', 'empty', '暂无外部 Harness 历史')); rail.append(threadList);
    const top = el('header', 'top'); top.append(el('span', connected ? 'status connected' : 'status disconnected', connected ? '已连接' : '未连接'), el('h2', '', String(selectedThread?.name ?? selectedThread?.title ?? (selectedThreadId ? '正在读取…' : '新 Harness 对话'))));
    const effective = threadInspectionLabel(selectedInspection); if (effective) top.append(el('span', 'tag', effective));
    if (running) top.append(el('span', 'tag', `运行中${activeTurnId ? ` · ${activeTurnId}` : ''}`));
    top.append(button('刷新', () => { void loadThreads(); if (selectedThreadId) void loadSelected(selectedThreadId, false, true, true); }), button('关闭', () => dialog.close())); main.append(top);
    const messages = el('section', 'messages'); messages.setAttribute('aria-live', 'polite'); const allItems = mergeStreamItems(baseItems, streamOverlay), items = allItems.slice(-visibleCount);
    if (loading) messages.append(el('div', 'empty', '正在读取对话…')); else if (!selectedThreadId) messages.append(el('div', 'empty', '选择左侧历史，或配置 Harness 后发送第一条消息。')); else if (!items.length) messages.append(el('div', 'empty', '这个对话还没有可显示的消息。'));
    if (allItems.length > items.length) {
      const older = button(`加载更早内容（还有 ${allItems.length - items.length} 条）`, () => { visibleCount += 300; preserveHistoryScroll = true; render(); }, 'load-older');
      messages.prepend(older);
    }
    for (const item of items) { const message = el('article', `message ${item.kind}`); message.append(el('span', 'meta', item.label), document.createTextNode(item.text)); messages.append(message); } main.append(messages);
    const composer = el('section', 'composer'); if (error) composer.append(el('div', 'error', error));
    if (!selectedThreadId) {
      const config = el('div', 'row'), harnessSelect = document.createElement('select'); harnessSelect.setAttribute('aria-label', 'Harness');
      for (const harness of harnesses) { const option = document.createElement('option'); option.value = harness.id; option.textContent = `${harness.name}${harness.available ? '' : '（不可用）'}`; option.disabled = !harness.available; option.selected = harness.id === selectedHarness; harnessSelect.append(option); }
      harnessSelect.addEventListener('change', () => { selectedHarness = harnessSelect.value; const loadingCatalog = loadCatalog(); render(); void loadingCatalog.then(render).catch(cause => { error = `读取模型失败：${errorText(cause)}`; render(); }); });
      const modelSelect = document.createElement('select'); modelSelect.setAttribute('aria-label', '模型');
      for (const entry of catalog?.catalog?.models ?? []) { const option = document.createElement('option'); option.value = String(entry.ref?.id ?? ''); option.textContent = String(entry.label ?? entry.ref?.id ?? '模型'); option.selected = option.value === selectedModel; modelSelect.append(option); } modelSelect.addEventListener('change', () => { selectedModel = modelSelect.value; });
      if (!catalogLoading && catalogHarness === selectedHarness && (catalog?.catalog?.models?.length ?? 0) === 0) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Harness 默认模型（目录为空）'; modelSelect.append(option); }
      const cwd = document.createElement('input'); cwd.className = 'grow'; cwd.placeholder = '工作目录'; cwd.value = cwdText; cwd.dataset.focusRole = 'cwd'; cwd.addEventListener('input', () => { saveDraft(); cwdText = cwd.value; draftText = persistedDrafts[draftKey(null)] ?? draftText; saveDraft(); }); config.append(harnessSelect, modelSelect, cwd); composer.append(config);
    }
    const readOnlyHistory = !!selectedThreadId && selectedThread?.canAcceptDirectInput === false;
    const textarea = document.createElement('textarea'); textarea.dataset.focusRole = 'composer'; textarea.placeholder = readOnlyHistory ? '此历史来自子代理，仅可查看' : running ? '输入消息以引导当前回合（Steer）' : '发送给选定 Harness'; textarea.value = draftText; textarea.disabled = readOnlyHistory; textarea.addEventListener('input', () => { draftText = textarea.value; saveDraft(); send.disabled = sending || readOnlyHistory || !draftText.trim(); }); textarea.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); } }); composer.append(textarea);
    const actions = el('div', 'row'); actions.append(el('span', 'notice grow', '当前仅支持文本；图片和文件附件尚未接入。')); if (running) actions.append(button('停止', () => { void cancelTurn(); }, 'danger'));
    const catalogUnavailable = !selectedThreadId && (catalogLoading || !catalog || catalogHarness !== selectedHarness);
    const send = button(running ? '引导当前回合' : '发送', () => { void submit(); }, 'primary'); send.disabled = sending || readOnlyHistory || catalogUnavailable || !draftText.trim(); actions.append(send); composer.append(actions); main.append(composer); shell.append(rail, main); dialog.append(shell);
    const approvalLayer = el('div', 'approvals'); for (const frame of approvals.values()) approvalLayer.append(renderApproval(frame)); dialog.append(approvalLayer);
    queueMicrotask(() => {
      const pane = shadow.querySelector<HTMLElement>('.messages');
      if (pane && preserveHistoryScroll) { pane.scrollTop = previousTop + (pane.scrollHeight - previousHeight); preserveHistoryScroll = false; }
      else if (pane && wasNearBottom) pane.scrollTop = pane.scrollHeight;
      const replacement = focusRole ? shadow.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-role="${focusRole}"]`) : null;
      if (replacement) { replacement.focus(); if (selection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(selection[0], selection[1]); }
    });
  }

  async function open(): Promise<void> {
    if (disposed) return; if (!dialog.open) dialog.showModal(); render();
    try { await Promise.all([loadHarnesses(), loadThreads(false)]); connected = true; error = ''; syncApprovals(); }
    catch (cause) { connected = false; error = `连接 Harness 后台失败：${errorText(cause)}`; } render();
  }

  return {
    dispose() { if (disposed) return; disposed = true; generation += 1; if (refreshTimer) clearTimeout(refreshTimer); if (renderTimer) clearTimeout(renderTimer); unsubscribe(); lifetime.abort(); if (dialog.open) dialog.close(); host.remove(); client.dispose(); },
    open() { void open(); },
    status() { return { state: 'ready', reason: 'independent-sidecar-panel' }; },
  };
}
