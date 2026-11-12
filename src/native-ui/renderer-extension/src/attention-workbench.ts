import css from './attention-workbench.css';
import type { AttentionClient } from './attention-client.js';
import { EMPTY_ATTENTION_DATA, type AttentionData, type AttentionEvent, type AttentionThread } from './attention-types.js';
import { parseAttentionState, serializeAttentionState, applyAttentionSnapshot, markAttentionThreadRead, attentionUnreadEvents } from './attention-state.js';
import { attentionAnchor, attentionLanes, attentionProjects, normalizeAttentionPath, type AttentionLane } from './attention-layout.js';
import { installAttentionTrigger } from './attention-trigger.js';
import { conciseCommitSubject, renderAttentionTopology, type AttentionTopologyViewState } from './attention-topology-view.js';

const STORAGE_KEY = 'harnessmix.attention.v1.local';
const STATUS = { running: '运行', waiting: '等你', completed: '完成', error: '异常', idle: '空闲', interrupted: '已中断', unknown: '状态未知' };
const EVENT = { completed: '回合完成', waiting: '等你回复', error: '出现异常' };
const HARNESS: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code', 'deepseek-harness': 'DeepSeek', 'codex-harness': 'Codex 协作' };

export interface AttentionWorkbenchOptions {
  getClient(): AttentionClient | null;
  openThread(threadId: string, signal: AbortSignal): Promise<void>;
  /** Test/embedding host; production mounts in the native destination rail. */
  triggerContainer?: HTMLElement;
}

export interface AttentionWorkbenchControl { open(): void; close(): void; refresh(): Promise<void>; dispose(): void }
declare global { interface Window { __harnessmixAttentionWorkbenchV1?: AttentionWorkbenchControl } }

export function installAttentionWorkbench(options: AttentionWorkbenchOptions): AttentionWorkbenchControl {
  window.__harnessmixAttentionWorkbenchV1?.dispose();
  let data: AttentionData = { ...EMPTY_ATTENTION_DATA };
  let state = parseAttentionState(safeRead());
  let activeClient: AttentionClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let busy = false;
  let needsRefresh = false;
  let lastError = '';
  let returnLabel = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  const repositoryByProject = new Map<string, string>();
  const topologyViews = new Map<string, AttentionTopologyViewState>();
  const listByProject = new Map<string, string>();
  const listPageByProject = new Map<string, number>();
  const lifetime = new AbortController();
  const host = document.createElement('div');
  host.setAttribute('data-harnessmix-attention-root', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = css;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '对话工作台');
  const live = document.createElement('p'); live.className = 'sr'; live.setAttribute('aria-live', 'polite');
  shadow.append(style, dialog, live);
  document.body.append(host);
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.setAttribute('data-harnessmix-attention-trigger', '');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.addEventListener('click', () => open(), { signal: lifetime.signal });
  dialog.addEventListener('close', () => { trigger.focus(); }, { signal: lifetime.signal });
  dialog.addEventListener('scroll', () => {
    const tooltip = shadow.querySelector<HTMLElement>('.commit-tooltip');
    if (tooltip) tooltip.hidden = true;
  }, { capture: true, passive: true, signal: lifetime.signal });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
  } }, { signal: lifetime.signal });
  const triggerControl = installAttentionTrigger(trigger, options.triggerContainer ? { container: options.triggerContainer } : {});
  const resize = new ResizeObserver(() => { if (dialog.open) render(); });
  // Observe viewport rather than dialog content; rendering must not cause a resize loop.
  resize.observe(document.documentElement);
  updateTrigger();
  timer = setTimeout(() => void refresh(), 1500);

  function safeRead(): string | null { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } }
  function persist(): void { try { localStorage.setItem(STORAGE_KEY, serializeAttentionState(state)); } catch { /* memory-only view remains usable */ } }
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
  }
  function button(text: string, action: () => void, cls = ''): HTMLButtonElement {
    const node = el('button', cls, text); node.type = 'button'; node.dataset.focusKey = `action:${text}`; node.addEventListener('click', action); return node;
  }
  function badge(count: number): HTMLElement { const node = el('span', 'badge', String(count)); node.setAttribute('aria-label', `${count} 条新动态`); return node; }
  function unread(): AttentionEvent[] { const ids = new Set(data.threads.map(t => String(t.id))); return attentionUnreadEvents(state, data).filter(e => ids.has(e.threadId)); }
  function updateTrigger(): void {
    trigger.replaceChildren(document.createTextNode(returnLabel ? '返回工作台' : '对话工作台'));
    const count = unread().length;
    if (count) { const dot = badge(count); Object.assign(dot.style, { background: '#c82c24', color: '#fff', borderRadius: '8px', fontSize: '11px', padding: '0 4px' }); trigger.append(dot); }
    trigger.setAttribute('aria-label', `${returnLabel ? '返回' : '打开'}对话工作台${count ? `，${count} 条新动态` : ''}`);
  }
  function currentGroup() {
    const groups = attentionProjects(data);
    return groups.find(p => p.id === state.currentProject) ?? groups[0] ?? null;
  }
  function currentView(id: string) { return state.projectViews[id] ??= {}; }
  function selectProject(id: string): void {
    state.currentProject = id; state.selectedProjectId = id; persist(); render(); void refresh();
  }
  function eventProject(event: AttentionEvent): string | null {
    return attentionProjects(data).find(p => p.threads.some(t => t.id === event.threadId))?.id ?? null;
  }
  function open(): void {
    if (disposed) return;
    render(); if (!dialog.open) dialog.showModal();
    render(); void refresh();
  }
  function close(): void { if (dialog.open) dialog.close(); }
  async function refresh(): Promise<void> {
    if (disposed) return;
    if (busy) { needsRefresh = true; return; }
    clearTimeout(timer);
    const client = options.getClient();
    if (!client) {
      lastError = '等待本地连接就绪'; if (dialog.open) render();
      timer = setTimeout(() => void refresh(), 3000); return;
    }
    if (client !== activeClient) {
      unsubscribe?.(); activeClient = client;
      unsubscribe = client.subscribe(() => {
        clearTimeout(notificationTimer);
        notificationTimer = setTimeout(() => void refresh(), 350);
      });
    }
    busy = true;
    const includeGit = dialog.open;
    try {
      const next = await client.load({ includeGit, ...(state.currentProject ? { projectId: state.currentProject } : {}) });
      if (disposed || activeClient !== client) return;
      if (!includeGit) next.repositories = data.repositories;
      data = next; state = applyAttentionSnapshot(state, data);
      const groups = attentionProjects(data);
      if (!groups.some(p => p.id === state.currentProject) && groups[0]) { state.currentProject = groups[0].id; state.selectedProjectId = groups[0].id; }
      persist(); lastError = '';
      updateTrigger();
    } catch (error) { lastError = error instanceof Error ? error.message : '暂时无法刷新'; }
    finally {
      busy = false;
      if (!disposed) {
        if (dialog.open) render();
        timer = setTimeout(() => { needsRefresh = false; void refresh(); }, needsRefresh ? 200 : dialog.open ? 10000 : 30000);
      }
    }
  }
  async function navigate(thread: AttentionThread): Promise<void> {
    if (disposed) return;
    const group = currentGroup();
    if (group) { currentView(group.id).conversationId = String(thread.id); persist(); }
    close();
    try {
      await options.openThread(String(thread.id), lifetime.signal);
      if (disposed) return;
      state = markAttentionThreadRead(state, data, String(thread.id)); persist();
      returnLabel = true; updateTrigger(); live.textContent = `已打开${thread.title}，点击返回工作台可回到原位置`;
    } catch {
      if (disposed) return;
      lastError = '未能确认对话已打开，请重试。提醒已保留。';
      render(); dialog.showModal();
    }
  }
  function chat(thread: AttentionThread, position?: { left: number; top: number }): HTMLButtonElement {
    const anchor = attentionAnchor(thread, data.repositories);
    const b = button('', () => void navigate(thread), 'chat'); b.dataset.threadId = String(thread.id); b.dataset.focusKey = `thread:${thread.id}`;
    const title = el('span', 'chat-title', thread.title || '未命名对话');
    const meta = el('span', 'chat-meta');
    const status = el('span', 'status', STATUS[thread.status]); status.dataset.status = thread.status;
    meta.append(el('span', '', HARNESS[thread.harnessId] ?? thread.harnessId), status);
    const subject = anchor.repository?.commits.find(commit => commit.hash === anchor.hash)?.subject;
    const where = anchor.kind === 'unbound' ? '未关联 Git' : !anchor.hash ? '提交位置待确认'
      : anchor.kind === 'workspace' ? (anchor.dirty ? `工作区 · ${anchor.dirty} 处改动` : '当前工作区')
      : subject ? conciseCommitSubject(subject) : '已记录的提交位置';
    b.append(title, meta, el('span', 'chat-position', where));
    if (!position) b.append(el('span', 'chat-position', anchor.repository
      ? `${anchor.repository.root.replace(/\\/g, '/').split('/').pop()} · ${anchor.branch ?? 'detached HEAD'}`
      : '待关联仓库'));
    const isNew = unread().some(e => e.threadId === thread.id);
    b.classList.toggle('is-new', isNew);
    const selected = currentGroup();
    b.classList.toggle('is-current', !isNew && !!selected && currentView(selected.id).conversationId === thread.id);
    b.title = `${thread.title}\n${anchor.branch ?? '未关联分支'} · ${anchor.label}\n${thread.activity?.cwd ?? thread.workspace?.root ?? thread.cwd ?? '工作目录未知'}\n${anchor.hash ?? ''}`;
    b.setAttribute('aria-label', `打开${thread.title}，${STATUS[thread.status]}，${anchor.branch ?? '未关联'}，${where}${isNew ? '，有新动态' : ''}`);
    if (position) { b.style.left = `${position.left}px`; b.style.top = `${position.top}px`; }
    return b;
  }
  function render(): void {
    if (disposed) return;
    const focused = shadow.activeElement instanceof HTMLElement ? shadow.activeElement.dataset.focusKey : undefined;
    dialog.replaceChildren();
    dialog.classList.remove('is-graph-view');
    const groups = attentionProjects(data), group = currentGroup();
    const top = el('header', 'top'); top.append(el('h2', '', '分支上的对话'));
    const tabs = el('div', 'tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '项目');
    const featured = groups.slice(0, 4);
    if (group && !featured.some(project => project.id === group.id) && featured.length) featured[featured.length - 1] = group;
    for (const project of featured) {
      const b = button('', () => selectProject(project.id)); b.dataset.focusKey = `project:${project.id}`;
      b.setAttribute('aria-pressed', String(project.id === group?.id)); b.title = project.name;
      b.append(el('span', 'tab-name', project.name));
      const count = unread().filter(e => eventProject(e) === project.id).length;
      if (count) b.append(badge(count)); tabs.append(b);
    }
    if (groups.length > 4) {
      const select = el('select'); select.setAttribute('aria-label', '切换所有项目');
      for (const project of groups) {
        const count = unread().filter(e => eventProject(e) === project.id).length;
        const option = el('option', '', `${project.name}${count ? ` · ${count} 条新动态` : ''}`); option.value = project.id; option.selected = project.id === group?.id; select.append(option);
      }
      select.addEventListener('change', () => selectProject(select.value)); tabs.append(select);
    }
    top.append(tabs, button('关闭', close, 'close')); dialog.append(top);
    if (!group) {
      dialog.append(el('div', 'empty', busy ? '正在读取本地对话…' : lastError || '尚未找到可显示的本地对话'));
      dialog.append(button('重新读取', () => void refresh())); return;
    }
    const lanes = attentionLanes(group.threads, data.repositories);
    const view = currentView(group.id);
    const activeLane = lanes.find(l => l.id === view.branch) ?? lanes.find(l => l.threads.length > 0) ?? lanes[0];
    const narrow = window.innerWidth < 701;
    const events = unread().filter(e => eventProject(e) === group.id).sort((a, b) => b.at - a.at);
    const toolbar = el('div', 'toolbar');
    const event = events[0];
    if (event) {
      const thread = group.threads.find(t => t.id === event.threadId);
      const notice = el('div', 'notice'); notice.append(el('span', 'dot'));
      const text = `${thread?.title ?? '对话'} · ${EVENT[event.kind]}${events.length > 1 ? ` · 共 ${events.length} 条` : ''}`;
      const label = el('span', 'notice-text', text); label.title = text; notice.append(label);
      notice.append(button('定位', () => {
        const index = lanes.findIndex(l => l.threads.some(t => t.id === event.threadId));
        const lane = lanes[index]; if (!lane) return;
        view.branch = lane.id; view.conversationId = event.threadId;
        if (lane.repository) { repositoryByProject.set(group.id, lane.repository.id); topologyViews.delete(`${group.id}::${lane.repository.id}`); }
        listByProject.delete(group.id); persist(); render();
      })); toolbar.append(notice);
    }
    const actions = el('div', 'actions');
    if (!narrow) {
      const all = button(`全部对话 · ${group.threads.length}`, () => {
        listByProject.set(group.id, '__all__'); listPageByProject.set(group.id, 0); render();
      });
      all.setAttribute('aria-pressed', String(listByProject.get(group.id) === '__all__'));
      actions.append(all);
    }
    if (narrow && activeLane) {
      const select = el('select', 'narrow-select'); select.setAttribute('aria-label', '选择分支');
      for (const lane of lanes) { const option = el('option', '', `${lane.name} · ${lane.threads.length}`); option.value = lane.id; option.selected = lane.id === activeLane.id; select.append(option); }
      select.addEventListener('change', () => { view.branch = select.value; listPageByProject.set(group.id, 0); persist(); render(); }); actions.append(select);
    }
    const refreshButton = button(busy ? '刷新中' : '刷新', () => void refresh()); refreshButton.disabled = busy;
    actions.append(refreshButton); toolbar.append(actions); dialog.append(toolbar);
    const listLane: AttentionLane | undefined = listByProject.get(group.id) === '__all__'
      ? { id: '__all__', name: '全部对话', repository: null, threads: group.threads, head: null, merged: null }
      : lanes.find(l => l.id === listByProject.get(group.id));
    if (listLane || narrow) renderList(listLane ?? activeLane!, group.id, !narrow);
    else renderGraph(lanes, group.id);
    const footer = el('footer', 'footer');
    footer.append(el('span', '', `${group.threads.length} 个对话 · 本地实时读取`), el('span', '', 'Git 只读 · 回合完成与代码合并分别显示'));
    const activityPaths = new Set(group.threads.map(t => normalizeAttentionPath(t.activity?.cwd || t.workspace?.root || t.cwd || '')));
    const failedRepository = data.repositories.find(repo => !repo.available && repo.reason !== 'not-git'
      && repo.paths.some(path => activityPaths.has(normalizeAttentionPath(path))));
    const unbound = group.threads.filter(t => attentionAnchor(t, data.repositories).kind === 'unbound').length;
    if (unbound) footer.append(el('span', '', `${unbound} 个对话待关联仓库`));
    const warning = lastError || (failedRepository ? `当前项目有仓库暂时无法读取：${failedRepository.root}` : '') || data.errors[0] || data.warnings[0];
    if (warning) { const note = el('span', 'warning', warning); note.title = failedRepository?.error || [...data.errors, ...data.warnings].join('\n') || warning; footer.append(note); }
    else if (data.partial) footer.append(el('span', 'warning', '当前显示已读取的数据，范围受限'));
    dialog.append(footer);
    if (focused) [...shadow.querySelectorAll<HTMLElement>('[data-focus-key]')].find(e => e.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  function renderList(lane: AttentionLane, projectId: string, back: boolean): void {
    const header = el('div', 'list-head');
    if (back) header.append(button('← 返回分支图', () => { listByProject.delete(projectId); render(); }));
    header.append(el('span', '', `${lane.name} · ${lane.threads.length} 个对话`)); dialog.append(header);
    const context = lane.id === '__all__' ? '当前项目的全部对话；点击卡片进入，左侧入口返回。' : lane.repository ? `分支对话 · ${lane.repository.root.replaceAll('\\', '/').split('/').pop()}` : '普通目录或开发位置尚未验证的对话保留在此处';
    dialog.append(el('p', 'lane-context', context));
    const threads = ranked(lane.threads, projectId);
    const page = Math.min(listPageByProject.get(projectId) ?? 0, Math.max(0, Math.ceil(threads.length / 6) - 1));
    const list = el('div', 'list'); for (const thread of threads.slice(page * 6, page * 6 + 6)) list.append(chat(thread));
    if (!threads.length) list.append(el('p', 'muted', '该分支尚无关联对话'));
    dialog.append(list);
    if (threads.length > 6) {
      const pager = el('div', 'list-head');
      const prev = button('上一页', () => { listPageByProject.set(projectId, page - 1); render(); }); prev.disabled = page === 0;
      const next = button('下一页', () => { listPageByProject.set(projectId, page + 1); render(); }); next.disabled = (page + 1) * 6 >= threads.length;
      pager.append(prev, el('span', 'muted', `${page + 1}/${Math.ceil(threads.length / 6)}`), next); dialog.append(pager);
    }
  }
  function ranked(threads: AttentionThread[], projectId: string): AttentionThread[] {
    const selected = currentView(projectId).conversationId;
    const news = new Set(unread().map(e => e.threadId));
    const rank = (t: AttentionThread): number => t.id === selected ? 0 : news.has(String(t.id)) ? 1 : t.status === 'running' ? 2 : 3;
    return [...threads].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  function renderGraph(lanes: AttentionLane[], projectId: string): void {
    const repositories = [...new Set(lanes.map(lane => lane.repository).filter(repo => repo !== null))];
    const threads = ranked(lanes.flatMap(lane => lane.threads), projectId);
    const preferred = threads.find(thread => thread.id === currentView(projectId).conversationId) ?? threads.find(thread => thread.status === 'running') ?? threads[0];
    const preferredRepository = preferred && attentionAnchor(preferred, data.repositories).repository;
    const repository = repositories.find(repo => repo.id === repositoryByProject.get(projectId)) ?? preferredRepository ?? repositories[0];
    if (!repository) {
      renderList({ id: 'unbound', name: '待关联仓库', repository: null, threads, head: null, merged: null }, projectId, false);
      return;
    }
    dialog.classList.add('is-graph-view');
    repositoryByProject.set(projectId, repository.id);
    const context = el('div', 'repository-context');
    const label = el('span', 'muted', '仓库'); context.append(label);
    if (repositories.length > 1) {
      const select = el('select'); select.setAttribute('aria-label', '选择 Git 仓库');
      for (const repo of repositories) {
        const option = el('option', '', repo.root.replaceAll('\\', '/').split('/').pop() || repo.root);
        option.value = repo.id; option.selected = repo.id === repository.id; select.append(option);
      }
      select.addEventListener('change', () => { repositoryByProject.set(projectId, select.value); render(); }); context.append(select);
    } else context.append(el('span', '', repository.root.replaceAll('\\', '/').split('/').pop() || repository.root));
    context.title = repository.root;
    const outside = repository.branches.filter(branch => !repository.commits.some(commit => commit.hash === branch.head)).length;
    const info = el('span', 'muted repository-count', `${repository.branches.length} 分支 · ${repository.commits.length} 提交${outside ? ` · ${outside} 个分支头在范围外` : ''}`);
    context.append(info); dialog.append(context);
    const key = `${projectId}::${repository.id}`;
    let topologyState = topologyViews.get(key);
    if (!topologyState) { topologyState = { page: 0, pinPage: 0 }; topologyViews.set(key, topologyState); }
    dialog.append(renderAttentionTopology({
      repository, threads: threads.filter(thread => attentionAnchor(thread, data.repositories).repository?.id === repository.id),
      state: topologyState, preferredThreadId: currentView(projectId).conversationId,
      chat: thread => chat(thread), change: render,
      openBranch: name => {
        const lane = lanes.find(candidate => candidate.repository?.id === repository.id && candidate.name === name);
        if (!lane) return;
        currentView(projectId).branch = lane.id; listByProject.set(projectId, lane.id); listPageByProject.set(projectId, 0); persist(); render();
      },
    }));
  }
  const control: AttentionWorkbenchControl = { open, close, refresh, dispose() {
    if (disposed) return; disposed = true; lifetime.abort(); clearTimeout(timer); clearTimeout(notificationTimer);
    unsubscribe?.(); triggerControl.dispose(); resize.disconnect(); close(); host.remove();
    if (window.__harnessmixAttentionWorkbenchV1 === control) delete window.__harnessmixAttentionWorkbenchV1;
  } };
  window.__harnessmixAttentionWorkbenchV1 = control;
  return control;
}
