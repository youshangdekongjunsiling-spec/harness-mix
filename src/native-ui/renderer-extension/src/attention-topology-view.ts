import { buildAttentionTopology, compactAttentionTopology } from './attention-topology.js';
import type { AttentionRepository, AttentionThread } from './attention-types.js';

export interface AttentionTopologyViewState {
  /** Legacy page field retained for in-memory callers. The graph now scrolls. */
  page: number;
  scrollTop?: number | undefined;
  scrollAnchor?: { hash: string; offset: number } | undefined;
  focusHash?: string | undefined;
  selectedHash?: string | undefined;
  pinPage: number;
  expanded?: boolean | undefined;
  unresolved?: boolean | undefined;
  selectedThreadId?: string | undefined;
}
export interface AttentionTopologyViewOptions {
  repository: AttentionRepository;
  threads: AttentionThread[];
  state: AttentionTopologyViewState;
  preferredThreadId?: string | undefined;
  chat(thread: AttentionThread): HTMLElement;
  change(): void;
  openBranch(name: string): void;
}

/** Keep the source meaning; remove conventional-commit bookkeeping, never infer changes. */
export function conciseCommitSubject(subject: string): string {
  const cleaned = subject.trim().replace(/^(?:feat|fix|chore|docs|refactor|test|style|perf|build|ci|revert)(?:\([^)]*\))?!?:\s*/i, '').replace(/\s+/g, ' ');
  const text = cleaned || '未填写改动说明';
  const chars = Array.from(text);
  return chars.length > 48 ? `${chars.slice(0, 47).join('')}…` : text;
}

/** A commit owns its refs and chat pins; branch names never allocate drawing tracks. */
export function renderAttentionTopology(options: AttentionTopologyViewOptions): HTMLElement {
  const { repository, threads, state, change } = options;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, action: () => void, label?: string): HTMLButtonElement => {
    const node = el('button', '', text); node.type = 'button'; node.addEventListener('click', action);
    node.dataset.focusKey = `topology:${label ?? text}`;
    if (label) node.setAttribute('aria-label', label);
    return node;
  };
  const baseRowHeight = 56;
  const pinnedRowHeight = 92;
  const full = buildAttentionTopology(repository, threads);
  const topology = state.expanded ? full : compactAttentionTopology(full);
  const byHash = new Map(topology.nodes.map(node => [node.hash, node]));
  const threadById = new Map(threads.map(thread => [String(thread.id), thread]));
  const pinsByHash = new Map<string, typeof topology.pins>();
  for (const pin of topology.pins) {
    const pins = pinsByHash.get(pin.hash) ?? [];
    pins.push(pin); pinsByHash.set(pin.hash, pins);
  }
  const preferred = topology.pins.find(pin => pin.threadId === options.preferredThreadId)
    ?? topology.pins.find(pin => threadById.get(pin.threadId)?.status === 'running')
    ?? topology.pins[0];
  if (state.unresolved === undefined) state.unresolved = topology.pins.length === 0 && topology.unresolved.length > 0;
  if (!state.selectedHash || !byHash.has(state.selectedHash)) {
    state.selectedHash = preferred?.hash ?? topology.nodes[0]?.hash;
    if (state.scrollTop === undefined) state.focusHash = state.selectedHash;
  }
  const visible = topology.nodes;
  let nextRowTop = 0;
  const rowMetrics = visible.map(node => {
    const height = pinsByHash.has(node.hash) ? pinnedRowHeight : baseRowHeight;
    const metric = { hash: node.hash, top: nextRowTop, height };
    nextRowTop += height; return metric;
  });
  const metricsByHash = new Map(rowMetrics.map(metric => [metric.hash, metric]));
  const contentHeight = Math.max(baseRowHeight * 2, nextRowTop + 12);
  const rankedThreads = (threadIds: readonly string[]): AttentionThread[] => {
    const selectedId = state.selectedThreadId ?? options.preferredThreadId;
    const rank = (thread: AttentionThread): number => String(thread.id) === selectedId ? 0 : thread.status === 'running' ? 1 : 2;
    return threadIds.map(id => threadById.get(id)).filter((thread): thread is AttentionThread => !!thread)
      .toSorted((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  };
  const statusLabel: Record<AttentionThread['status'], string> = {
    running: '运行', waiting: '等你', completed: '完成', error: '异常', idle: '空闲', interrupted: '已中断', unknown: '状态未知',
  };
  const root = el('section', 'topology'); root.setAttribute('aria-label', '提交拓扑与对话位置');
  const controls = el('div', 'topology-controls');
  const branchSelect = el('select'); branchSelect.setAttribute('aria-label', '定位分支提交'); branchSelect.dataset.focusKey = 'topology:branch-locator';
  const placeholder = el('option', '', `定位分支 · ${repository.branches.length}`); placeholder.value = ''; branchSelect.append(placeholder);
  for (const branch of repository.branches) {
    const item = el('option', '', branch.name); item.value = branch.name;
    if (!byHash.has(branch.head)) item.textContent += ' · 历史范围外';
    branchSelect.append(item);
  }
  branchSelect.addEventListener('change', () => {
    const ref = repository.branches.find(branch => branch.name === branchSelect.value);
    const node = ref && byHash.get(ref.head);
    if (!node) { if (ref) options.openBranch(ref.name); return; }
    state.selectedHash = node.hash; state.focusHash = node.hash; state.pinPage = 0; state.unresolved = false; change();
  });
  controls.append(branchSelect);
  const threadSelect = el('select', 'thread-locator'); threadSelect.setAttribute('aria-label', '定位对话');
  threadSelect.dataset.focusKey = 'topology:thread-locator';
  const threadPlaceholder = el('option', '', `定位对话 · ${topology.pins.length + topology.unresolved.length}`);
  threadPlaceholder.value = ''; threadSelect.append(threadPlaceholder);
  const unresolvedIds = new Set(topology.unresolved.map(item => item.threadId));
  const repositoryThreadIds = [...new Set([...topology.pins.map(pin => pin.threadId), ...topology.unresolved.map(item => item.threadId)])];
  for (const thread of rankedThreads(repositoryThreadIds)) {
    const pin = topology.pins.find(item => item.threadId === String(thread.id));
    const item = el('option', '', `${thread.title || '未命名对话'} · ${statusLabel[thread.status]}${pin ? '' : ' · 待定位'}`);
    item.value = String(thread.id); item.dataset.location = pin ? 'verified' : 'unresolved'; threadSelect.append(item);
  }
  threadSelect.addEventListener('change', () => {
    const threadId = threadSelect.value; if (!threadId) return;
    const pin = topology.pins.find(item => item.threadId === threadId);
    state.selectedThreadId = threadId; state.pinPage = 0;
    if (pin) { state.selectedHash = pin.hash; state.focusHash = pin.hash; state.unresolved = false; }
    else if (unresolvedIds.has(threadId)) state.unresolved = true;
    change();
  });
  controls.append(threadSelect);
  const expand = button(state.expanded ? '关系概览' : '逐条提交', () => {
    state.expanded = !state.expanded; state.focusHash = state.selectedHash; change();
  });
  controls.append(expand);
  if (topology.unresolved.length) controls.append(button(`待定位 · ${topology.unresolved.length}`, () => { state.unresolved = true; state.pinPage = 0; change(); }));
  controls.append(el('span', 'topology-count muted', `${topology.nodes.length} 个节点 · 上下滚动`));
  root.append(controls);
  const main = el('div', 'topology-main'); root.append(main);
  const graph = el('div', 'graph commit-graph'); graph.tabIndex = 0; graph.dataset.focusKey = 'topology:graph-scroll';
  graph.setAttribute('role', 'region'); graph.setAttribute('aria-label', '上下滚动查看提交图谱'); main.append(graph);
  const canvas = el('div', 'commit-canvas'); canvas.style.height = `${contentHeight}px`; graph.append(canvas);
  const tooltip = el('div', 'commit-tooltip'); tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip');
  tooltip.id = 'attention-commit-tooltip'; root.append(tooltip);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !tooltip.hidden) {
      tooltip.hidden = true; event.preventDefault(); event.stopPropagation();
    }
  });
  const showDetail = (target: HTMLElement, text: string): void => {
    tooltip.textContent = text; tooltip.hidden = false;
    const r = target.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(r.left + 36, window.innerWidth - bounds.width - 12))}px`;
    tooltip.style.top = `${Math.max(12, r.bottom + bounds.height + 10 < window.innerHeight ? r.bottom + 7 : r.top - bounds.height - 7)}px`;
  };
  const describe = (target: HTMLElement, text: string): void => {
    target.setAttribute('aria-describedby', tooltip.id);
    target.addEventListener('pointerenter', () => showDetail(target, text));
    target.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    target.addEventListener('focus', () => showDetail(target, text));
    target.addEventListener('blur', () => { tooltip.hidden = true; });
  };
  graph.addEventListener('scroll', () => {
    state.scrollTop = graph.scrollTop;
    let low = 0, high = rowMetrics.length - 1, row = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2); const metric = rowMetrics[middle]!;
      if (graph.scrollTop < metric.top) high = middle - 1;
      else if (graph.scrollTop >= metric.top + metric.height) low = middle + 1;
      else { row = middle; break; }
    }
    if (row < 0 && rowMetrics.length) row = Math.min(rowMetrics.length - 1, low);
    const first = rowMetrics[row];
    if (first) state.scrollAnchor = { hash: first.hash, offset: graph.scrollTop - first.top };
    tooltip.hidden = true;
  }, { passive: true });
  queueMicrotask(() => {
    if (!graph.isConnected) return;
    const focus = state.focusHash && byHash.get(state.focusHash);
    const anchor = state.scrollAnchor && byHash.get(state.scrollAnchor.hash);
    graph.scrollTop = focus ? Math.max(0, (metricsByHash.get(focus.hash)?.top ?? 0) - graph.clientHeight / 3)
      : anchor ? (metricsByHash.get(anchor.hash)?.top ?? 0) + (state.scrollAnchor?.offset ?? 0) : state.scrollTop ?? 0;
    state.focusHash = undefined; tooltip.hidden = true;
    if (focus) {
      [...canvas.querySelectorAll<HTMLButtonElement>('[data-commit-hash]')]
        .find(item => item.dataset.commitHash === focus.hash)?.focus({ preventScroll: true });
    }
  });
  const graphWidth = Math.max(60, Math.min(190, 30 + topology.trackCount * 26));
  graph.style.setProperty('--track-width', `${graphWidth}px`);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', String(graphWidth)); svg.setAttribute('height', String(contentHeight));
  svg.setAttribute('viewBox', `0 0 ${graphWidth} ${contentHeight}`); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '从上到下为新到旧；实线连接父提交，虚线注明省略的连续提交或读取边界'); canvas.append(svg);
  const mark = (tag: string, attributes: Record<string, string | number>, text?: string): SVGElement => {
    const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text; svg.append(node); return node;
  };
  const x = (track: number): number => 15 + track * (graphWidth - 30) / Math.max(1, topology.trackCount - 1);
  const y = (hash: string): number => {
    const metric = metricsByHash.get(hash); return metric ? metric.top + baseRowHeight / 2 : 0;
  };
  const title = (node: SVGElement, text: string): void => { const t = document.createElementNS(ns, 'title'); t.textContent = text; node.append(t); };
  for (const edge of topology.edges) {
    const child = byHash.get(edge.from); const parent = edge.to ? byHash.get(edge.to) : undefined;
    if (!child) continue;
    if (!parent) {
      const sy = y(child.hash); const ey = Math.min(contentHeight - 3, sy + 22);
      const line = mark('path', { d: `M${x(child.track)},${sy} L${x(child.track)},${ey}`, class: 'edge boundary', 'data-boundary': edge.boundary?.hash ?? '' });
      title(line, `父提交未读取：${edge.boundary?.hash ?? '未知'}`);
      mark('text', { x: x(child.track) + 7, y: ey + 2, class: 'boundary-label' }, '…'); continue;
    }
    const sy = y(child.hash); const ey = y(parent.hash);
    const sx = x(child.track), ex = x(parent.track);
    const bend = Math.min(baseRowHeight * 0.65, Math.max(8, (ey - sy) / 2));
    const path = mark('path', {
      d: `M${sx},${sy} C${sx},${sy + bend} ${ex},${sy + bend} ${ex},${Math.min(ey, sy + bend * 2)} L${ex},${ey}`,
      class: `edge${edge.skippedCount ? ' condensed' : ''}${state.selectedHash === edge.from || state.selectedHash === edge.to ? ' selected' : ''}`,
      'data-from': edge.from, 'data-to': parent.hash, 'data-skipped': edge.skippedCount ?? 0,
    });
    title(path, edge.skippedCount ? `沿真实父链省略 ${edge.skippedCount} 条提交` : `${edge.from.slice(0, 8)} → 父提交 ${edge.to?.slice(0, 8)}`);
    if (edge.skippedCount) mark('text', { x: sx + 6, y: sy + 24, class: 'skipped-label' }, `+${edge.skippedCount}`);
  }
  for (const node of visible) {
    const pins = pinsByHash.get(node.hash) ?? [];
    const metric = metricsByHash.get(node.hash)!;
    const item = button('', () => { state.selectedHash = node.hash; state.pinPage = 0; state.unresolved = false; change(); }, `查看改动：${conciseCommitSubject(node.subject)}`);
    item.className = `commit-row${pins.length ? ' has-pins' : ''}`; item.style.top = `${metric.top}px`; item.style.height = `${metric.height}px`;
    item.dataset.focusKey = `commit:${node.hash}`; item.dataset.commitHash = node.hash; item.dataset.track = String(node.track); item.setAttribute('aria-pressed', String(state.selectedHash === node.hash && !state.unresolved));
    const line = el('span', 'commit-title');
    line.append(el('span', 'commit-summary', conciseCommitSubject(node.subject)));
    if (pins.length) line.append(el('span', 'pin-count', `${pins.length} 对话`));
    const refs = el('span', 'commit-subject');
    for (const branch of node.branches.slice(0, 2)) { const ref = el('span', 'ref-label', branch); ref.title = branch; refs.append(ref); }
    if (node.branches.length > 2) refs.append(el('span', 'ref-label', `+${node.branches.length - 2}`));
    if (!refs.childNodes.length) refs.append(el('span', 'commit-kind', node.parents.length > 1 ? '合并' : node.parents.length === 0 ? '起点' : '提交'));
    item.append(line, refs);
    const detailText = `${node.subject || '未填写改动说明'}\n${node.branches.length ? `分支：${node.branches.join(' · ')}\n` : ''}${node.parents.length > 1 ? `合并 · ${node.parents.length} 个父提交\n` : ''}提交：${node.hash}`;
    describe(item, detailText);
    canvas.append(item);
    if (pins.length) {
      const pinBar = el('div', 'commit-chat-pins'); pinBar.style.top = `${metric.top + 55}px`;
      pinBar.dataset.commitHash = node.hash; pinBar.setAttribute('role', 'group');
      pinBar.setAttribute('aria-label', `定位在“${conciseCommitSubject(node.subject)}”的对话`);
      const pinThreads = rankedThreads(pins.map(pin => pin.threadId));
      const visiblePinCount = window.innerWidth < 1001 ? 1 : 2;
      for (const thread of pinThreads.slice(0, visiblePinCount)) {
        const pinButton = options.chat(thread); pinButton.classList.add('commit-chat-pin');
        const threadId = String(thread.id); const isSelectedThread = threadId === (state.selectedThreadId ?? options.preferredThreadId);
        pinButton.dataset.focusKey = `graph-thread:${threadId}`; pinButton.classList.remove('is-current');
        pinButton.classList.toggle('is-selected', isSelectedThread);
        if (isSelectedThread) pinButton.setAttribute('aria-current', 'true');
        pinButton.dataset.pinHash = node.hash; pinButton.dataset.pinKind = pins.find(pin => pin.threadId === String(thread.id))?.kind ?? 'commit';
        pinButton.addEventListener('click', () => {
          state.selectedHash = node.hash; state.selectedThreadId = threadId; state.pinPage = 0; state.unresolved = false;
        }, { capture: true });
        pinBar.append(pinButton);
      }
      if (pinThreads.length > visiblePinCount) {
        const more = button(`+${pinThreads.length - visiblePinCount}`, () => {
          state.selectedHash = node.hash; state.selectedThreadId = pinThreads[visiblePinCount]?.id?.toString();
          state.pinPage = 0; state.unresolved = false; change();
        }, `查看此提交的全部 ${pinThreads.length} 个对话`);
        more.className = 'commit-chat-more'; more.dataset.focusKey = `graph-more:${node.hash}`;
        more.dataset.pinHash = node.hash; pinBar.append(more);
      }
      canvas.append(pinBar);
    }
    const dot = mark('circle', { cx: x(node.track), cy: y(node.hash), r: pins.length ? 6 : 4.5,
      class: state.selectedHash === node.hash && !state.unresolved ? 'head' : 'node', 'data-node-hash': node.hash });
    title(dot, detailText);
  }
  if (!visible.length) canvas.append(el('p', 'empty', '当前未读取到提交历史'));
  const detail = el('aside', 'position-panel'); detail.setAttribute('aria-label', '所选位置的对话'); main.append(detail);
  const selected = byHash.get(state.selectedHash ?? '');
  const selectedPins = topology.pins.filter(pin => pin.hash === selected?.hash);
  const selectedThreads = state.unresolved
    ? rankedThreads(topology.unresolved.map(item => item.threadId))
    : rankedThreads(selectedPins.map(pin => pin.threadId));
  const heading = el('strong', 'position-heading', state.unresolved ? '位置待确认' : selected ? conciseCommitSubject(selected.subject) : '选择一处改动');
  detail.append(heading);
  if (selected && !state.unresolved) describe(heading, `${selected.subject}\n提交：${selected.hash}`);
  if (state.unresolved) detail.append(el('p', 'muted position-note', '缺少可验证的提交记录，或提交超出读取范围。'));
  else if (selected) {
    const refs = el('div', 'position-refs');
    for (const branch of selected.branches) { const ref = button(branch, () => options.openBranch(branch)); ref.className = 'ref-link'; refs.append(ref); }
    if (refs.childNodes.length) detail.append(refs);
    if (selected.parents.length > 1) detail.append(el('p', 'muted', `合并提交 · ${selected.parents.length} 个父提交`));
    detail.append(el('p', 'muted position-note', `${selectedThreads.length} 个对话定位于此；工作区记录只说明执行位置。`));
  }
  const pinPageSize = window.innerHeight < 700 ? 1 : 2;
  state.pinPage = Math.min(state.pinPage, Math.max(0, Math.ceil(selectedThreads.length / pinPageSize) - 1));
  const cards = el('div', 'position-chats');
  for (const thread of selectedThreads.slice(state.pinPage * pinPageSize, (state.pinPage + 1) * pinPageSize)) {
    const card = options.chat(thread); const pin = selectedPins.find(item => item.threadId === thread.id);
    const unresolved = topology.unresolved.find(item => item.threadId === String(thread.id));
    card.dataset.pinHash = pin?.hash ?? ''; card.dataset.pinKind = pin?.kind ?? 'unresolved';
    const unresolvedContext = unresolved?.reason === 'missing-commit' ? '提交超出当前历史范围'
      : unresolved?.reason === 'no-hash' ? '缺少可验证的提交记录' : '尚未关联到此仓库';
    const context = pin ? pin.kind === 'workspace' ? `${thread.activity?.source === 'command' ? '最近执行工作区' : '关联独立工作树'}${pin.dirty ? ` · ${pin.dirty} 处未提交` : ''}` : '对话记录的提交' : unresolvedContext;
    card.append(el('span', 'chat-evidence', context)); cards.append(card);
  }
  detail.append(cards);
  if (!selectedThreads.length) detail.append(el('p', 'muted position-note', '此提交没有关联对话'));
  if (selectedThreads.length > pinPageSize) {
    const p = el('div', 'position-pager');
    const prev = button('‹', () => { state.pinPage--; change(); }, '上一页位置对话'); prev.disabled = state.pinPage === 0;
    const after = button('›', () => { state.pinPage++; change(); }, '下一页位置对话'); after.disabled = (state.pinPage + 1) * pinPageSize >= selectedThreads.length;
    p.append(prev, el('span', 'muted', `${state.pinPage + 1}/${Math.ceil(selectedThreads.length / pinPageSize)}`), after); detail.append(p);
  }
  const hint = el('p', 'topology-legend', state.expanded ? '新 → 旧 · 悬停查看详情' : `新 → 旧 · 虚线 +N 表示省略的提交 · 悬停查看详情`);
  if (topology.missingParents.length) hint.textContent += ` · ${topology.missingParents.length} 处历史边界`;
  root.append(hint);
  return root;
}
