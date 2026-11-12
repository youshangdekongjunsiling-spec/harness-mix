import type { AttentionData, AttentionRepository, AttentionThread } from './attention-types.js';

export interface AttentionAnchor {
  kind: 'workspace' | 'commit' | 'unbound';
  repository: AttentionRepository | null;
  branch: string | null;
  hash: string | null;
  dirty: number | null;
  label: string;
}

export interface AttentionLane {
  id: string;
  name: string;
  repository: AttentionRepository | null;
  threads: AttentionThread[];
  head: string | null;
  merged: boolean | null;
}

export function normalizeAttentionPath(value: string): string {
  const result = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(result) ? result.toLowerCase() : result;
}

function contains(root: string, value: string): boolean {
  const a = normalizeAttentionPath(root);
  const b = normalizeAttentionPath(value);
  return !!a && (a === b || b.startsWith(`${a}/`));
}

type ThreadActivity = { cwd: string; observedAt: number; source: 'command' | 'worktree'; itemId?: string | undefined };

function threadActivity(thread: AttentionThread): ThreadActivity | undefined {
  const activity = (thread as AttentionThread & { activity?: ThreadActivity | undefined }).activity;
  if (activity?.source === 'command') return activity;
  return activity?.source === 'worktree' && thread.workspace?.mode === 'worktree' ? activity : undefined;
}

function anchorPath(thread: AttentionThread): string {
  return threadActivity(thread)?.cwd || thread.workspace?.root || thread.cwd || '';
}

function exactRepositoryPath(repository: AttentionRepository, cwd: string): boolean {
  const target = normalizeAttentionPath(cwd);
  return !!target && [repository.root, ...repository.paths].some(value => normalizeAttentionPath(value) === target);
}

function repositoryMatch(repository: AttentionRepository, cwd: string): { repository: AttentionRepository; specificity: number } | null {
  const worktree = repository.worktrees.filter(candidate => contains(candidate.path, cwd))
    .sort((a, b) => normalizeAttentionPath(b.path).length - normalizeAttentionPath(a.path).length)[0];
  const rootMatches = contains(repository.root, cwd);
  if (!worktree && !rootMatches && !exactRepositoryPath(repository, cwd)) return null;
  return { repository, specificity: Math.max(
    worktree ? normalizeAttentionPath(worktree.path).length : 0,
    rootMatches ? normalizeAttentionPath(repository.root).length : 0,
  ) };
}

export function attentionAnchor(thread: AttentionThread, repositories: AttentionRepository[]): AttentionAnchor {
  const activity = threadActivity(thread);
  const cwd = anchorPath(thread);
  if (activity && repositories.some(repo => !repo.available && exactRepositoryPath(repo, cwd))) {
    return { kind: 'unbound', repository: null, branch: null, hash: null, dirty: null, label: '活动位置暂不可用' };
  }
  const repository = repositories.filter(repo => repo.available).map(repo => repositoryMatch(repo, cwd))
    .filter((match): match is NonNullable<typeof match> => match !== null)
    .sort((a, b) => b.specificity - a.specificity || b.repository.root.length - a.repository.root.length || a.repository.id.localeCompare(b.repository.id))[0]?.repository ?? null;
  if (!repository) return { kind: 'unbound', repository: null, branch: null, hash: null, dirty: null, label: '未关联可验证的 Git 工作树' };
  const worktree = repository.worktrees.filter(wt => contains(wt.path, cwd))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const recordedBranch = thread.workspace?.branch || thread.gitInfo?.branch;
  const recordedHash = thread.gitInfo?.sha || thread.workspace?.baseCommit;
  const ownsWorktree = thread.workspace?.mode === 'worktree';
  const hasLiveCommand = activity?.source === 'command' && (thread.status === 'running' || thread.status === 'waiting');
  if ((hasLiveCommand || ownsWorktree) && worktree) return {
    kind: 'workspace', repository, branch: worktree.branch, hash: worktree.head,
    dirty: worktree.dirty, label: worktree.detached ? '最近活动工作树 · detached HEAD' : '最近活动工作树位置',
  };
  // A recorded branch that no longer matches cwd is historical evidence. Never
  // silently move that conversation onto a newly checked-out branch.
  if (recordedBranch && worktree?.branch !== recordedBranch) {
    return { kind: 'commit', repository, branch: recordedBranch, hash: recordedHash ?? null, dirty: null, label: '会话记录位置 · 当前工作树已切换' };
  }
  // Recorded Git metadata is historical evidence for every harness. A cwd or
  // branch name alone never proves that an older conversation is at today's
  // checkout HEAD.
  if (recordedHash) {
    return { kind: 'commit', repository, branch: recordedBranch || worktree?.branch || null, hash: recordedHash, dirty: null, label: '会话记录的提交' };
  }
  return { kind: 'commit', repository, branch: recordedBranch ?? worktree?.branch ?? null, hash: null, dirty: null,
    label: '已关联仓库 · 尚无提交证据' };
}

export function attentionProjectId(thread: AttentionThread, data: AttentionData): string {
  if (thread.projectId && data.projects.some(project => project.id === thread.projectId)) return thread.projectId;
  const cwd = thread.originalCwd || thread.cwd || '';
  const project = data.projects.flatMap(p => p.rootPaths.map(root => ({ project: p, root })))
    .filter(item => contains(item.root, cwd)).sort((a, b) => b.root.length - a.root.length)[0]?.project;
  if (project) return project.id;
  const repo = attentionAnchor(thread, data.repositories).repository;
  if (repo) {
    const matched = data.projects.find(p => p.rootPaths.some(root => contains(root, repo.root) || contains(repo.root, root)));
    if (matched) return matched.id;
    return `repo:${repo.id}`;
  }
  return thread.projectId || 'unassigned';
}

export function attentionProjects(data: AttentionData): Array<{ id: string; name: string; threads: AttentionThread[] }> {
  const groups = new Map<string, { id: string; name: string; threads: AttentionThread[] }>();
  for (const thread of data.threads) {
    const id = attentionProjectId(thread, data);
    if (!groups.has(id)) {
      const repo = attentionAnchor(thread, data.repositories).repository;
      const name = data.projects.find(p => p.id === id)?.name ||
        (id.startsWith('repo:') && repo ? repo.root.replace(/\\/g, '/').split('/').pop() : null) ||
        (id === 'unassigned' ? '未归属项目' : id);
      groups.set(id, { id, name, threads: [] });
    }
    groups.get(id)!.threads.push(thread);
  }
  return [...groups.values()];
}

export function attentionLanes(threads: AttentionThread[], repositories: AttentionRepository[]): AttentionLane[] {
  const lanes = new Map<string, AttentionLane>();
  for (const thread of threads) {
    const anchor = attentionAnchor(thread, repositories);
    const id = anchor.repository ? `${anchor.repository.id}::${anchor.branch ?? 'detached'}` : 'unbound';
    if (!lanes.has(id)) {
      const branch = anchor.repository?.branches.find(b => b.name === anchor.branch);
      lanes.set(id, { id, name: anchor.repository ? anchor.branch ?? 'detached HEAD' : '未关联',
        repository: anchor.repository, threads: [], head: branch?.head ?? (anchor.kind === 'workspace' ? anchor.hash : null), merged: branch?.merged ?? null });
    }
    lanes.get(id)!.threads.push(thread);
  }
  // Once a repository belongs to this project, preserve all of its local
  // branches as explicit lanes, including branches without conversations.
  for (const repo of new Set([...lanes.values()].map(l => l.repository).filter(r => r !== null))) {
    for (const branch of repo.branches) {
      const id = `${repo.id}::${branch.name}`;
      if (!lanes.has(id)) lanes.set(id, { id, name: branch.name, repository: repo, threads: [], head: branch.head, merged: branch.merged });
    }
  }
  return [...lanes.values()].sort((a, b) => {
    if (a.id === 'unbound') return 1;
    if (b.id === 'unbound') return -1;
    const baseA = a.name === a.repository?.defaultBranch ? 0 : 1;
    const baseB = b.name === b.repository?.defaultBranch ? 0 : 1;
    return baseA - baseB || b.threads.length - a.threads.length || a.name.localeCompare(b.name);
  });
}

export interface AttentionGraphNode { id: string; hash: string; parentIds: string[]; subject: string; lane: string; column: number }

export function attentionGraph(lanes: AttentionLane[]): AttentionGraphNode[] {
  const selected = new Map<string, { id: string; hash: string; parentIds: string[]; subject: string; timestamp: number; lane: string }>();
  const seeds: Array<{ repository: AttentionRepository; hash: string; lane: string }> = [];
  const seedIds = new Set<string>();
  for (const lane of lanes) {
    if (!lane.repository) continue;
    const hashes = [lane.head, ...lane.threads.map(t => attentionAnchor(t, [lane.repository!]).hash)].filter((hash): hash is string => !!hash);
    for (const hash of hashes) {
      const id = `${lane.repository.id}::${hash}`;
      if (seedIds.has(id)) continue;
      seedIds.add(id); seeds.push({ repository: lane.repository, hash, lane: lane.id });
    }
  }
  const pending = [...seeds];
  // Insert every available head/recorded anchor first so ancestry sampling
  // cannot evict the locations the UI needs to explain.
  for (const seed of seeds) {
    if (selected.size >= 24) break;
    const commit = seed.repository.commits.find(candidate => candidate.hash === seed.hash);
    if (!commit) continue;
    const id = `${seed.repository.id}::${commit.hash}`;
    selected.set(id, { id, hash: commit.hash, parentIds: commit.parents.map(parent => `${seed.repository.id}::${parent}`),
      subject: commit.subject, timestamp: commit.timestamp, lane: seed.lane });
  }
  const expanded = new Set<string>();
  while (pending.length && selected.size < 24) {
    const current = pending.shift()!;
    const currentId = `${current.repository.id}::${current.hash}`;
    if (expanded.has(currentId)) continue;
    expanded.add(currentId);
    const commit = current.repository.commits.find(candidate => candidate.hash === current.hash);
    if (!commit) continue;
    for (const parent of commit.parents) {
      const parentCommit = current.repository.commits.find(candidate => candidate.hash === parent);
      if (!parentCommit) continue;
      const id = `${current.repository.id}::${parent}`;
      if (!selected.has(id) && selected.size < 24) selected.set(id, { id, hash: parent, parentIds: parentCommit.parents.map(value => `${current.repository.id}::${value}`),
        subject: parentCommit.subject, timestamp: parentCommit.timestamp, lane: current.lane });
      pending.push({ repository: current.repository, hash: parent, lane: current.lane });
    }
  }
  const ordered: Array<(typeof selected extends Map<string, infer T> ? T : never)> = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = selected.get(id);
    if (!node) return;
    node.parentIds.forEach(visit);
    ordered.push(node);
  };
  [...selected.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).forEach(node => visit(node.id));
  return ordered.map((node, column) => ({ ...node, column }));
}
