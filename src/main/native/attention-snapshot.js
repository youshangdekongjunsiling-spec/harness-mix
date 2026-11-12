const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  listCodexProjects,
  readCodexProjectState,
  resolveThreadProjectId,
} = require('./codex-projects');

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 10_000;
const MAX_PATHS = 32;
const MAX_TOTAL_PATHS = MAX_PATHS * 2;
const MAX_PATH_LENGTH = 16_384;
const MAX_REPOSITORIES = 16;
const MAX_COMMITS = 1024;
const MAX_WORKTREES = 32;

function normalizedDirectory(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '') || path.parse(value).root;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isAbsoluteLocalPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0') && path.isAbsolute(value) && !/^[\\/]{2}/.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function validatePaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PATHS) throw new Error(`cwdPaths must be an array of at most ${MAX_PATHS} paths`);
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || !isAbsoluteLocalPath(entry)) {
      throw new Error('cwdPaths must contain absolute local filesystem paths');
    }
    const absolute = path.resolve(entry);
    const key = normalizedDirectory(absolute);
    if (!seen.has(key)) { seen.add(key); result.push(absolute); }
  }
  return result;
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async run(task) {
    if (this.active >= this.limit) await new Promise(resolve => this.queue.push(resolve));
    this.active++;
    try { return await task(); }
    finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function parseLog(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const [hash, parentText = '', subject = '', seconds = '0'] = line.split('\x1f');
    return { hash, parents: parentText ? parentText.split(' ') : [], subject, timestamp: Number(seconds) * 1000 };
  }).filter(commit => /^[0-9a-f]{40,64}$/i.test(commit.hash) && Number.isFinite(commit.timestamp));
}

function parseBranches(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, head] = line.split('\x00');
    return { name, head };
  }).filter(branch => branch.name && /^[0-9a-f]{40,64}$/i.test(branch.head));
}

function branchNames(text) {
  return new Set(text.split(/\r?\n/).map(line => line.replace(/^\*?\s*/, '').trim()).filter(Boolean));
}

function parseWorktrees(text) {
  const result = [];
  let current = null;
  const finish = () => { if (current?.path) result.push(current); current = null; };
  const records = text.includes('\0') ? text.split('\0') : text.split(/\r?\n/);
  for (const line of records) {
    if (!line) { finish(); continue; }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') { finish(); current = { path: value, branch: null, head: null, dirty: null, detached: false }; }
    else if (!current) continue;
    else if (key === 'HEAD') current.head = value || null;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'detached') current.detached = true;
  }
  finish();
  return result;
}

function countPorcelainEntries(text) {
  const records = text.split('\0');
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    count++;
    if (status.includes('R') || status.includes('C')) index++;
  }
  return count;
}

function asTimestamp(value) {
  if (Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stableTime(...values) {
  for (const value of values) {
    const parsed = asTimestamp(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function gitFailure(error, input) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const raw = String(error?.stderr || error?.message || error || '');
  if (/not a git repository/i.test(raw)) return { reason: 'not-git' };
  if (code === 'ENOENT') return { reason: 'missing-path', error: 'Directory or Git executable was not found' };
  if (code === 'EACCES' || code === 'EPERM') return { reason: 'permission-denied', error: 'Git repository access was denied' };
  if (error?.killed || error?.signal) return { reason: 'timeout', error: 'Git repository inspection timed out' };
  const escapedInput = String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const detail = raw.replace(new RegExp(escapedInput, 'gi'), '<cwd>')
    .replace(/\b(?:fatal|error):\s*/gi, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { reason: 'git-error', error: detail || 'Git repository inspection failed' };
}

function threadProjection(runtime, thread, state) {
  const turn = thread.currentTurn && typeof thread.currentTurn === 'object' ? thread.currentTurn : null;
  const running = typeof runtime.execution?.isRunning === 'function'
    ? runtime.execution.isRunning(thread.id)
    : ['created', 'starting', 'running', 'waiting_interaction'].includes(turn?.status);
  let status = 'unknown';
  if (running) status = turn?.status === 'waiting_interaction' ? 'waiting' : 'running';
  else if (thread.status === 'interrupted' || turn?.status === 'cancelled') status = 'interrupted';
  else if (thread.status === 'error' || thread.connectionStatus === 'error' || turn?.status === 'error' || turn?.status === 'failed') status = 'error';
  else if (turn?.status === 'completed') status = 'completed';
  else if (thread.status === 'ready' || thread.status === 'opening') status = 'idle';

  let event;
  if (status === 'waiting') {
    const interactions = Array.isArray(thread.interactions) ? thread.interactions : Array.isArray(thread.pendingApprovals) ? thread.pendingApprovals : [];
    const ids = interactions.map(item => item?.id || item?.requestId).filter(Boolean).map(String).sort();
    event = {
      id: `${thread.id}:${turn?.id || 'thread'}:waiting:${ids.join(',') || 'turn'}`,
      kind: 'waiting',
      at: stableTime(...interactions.map(item => item?.createdAt), turn?.startedAt, turn?.createdAt, thread.updatedAt),
    };
  } else if (status === 'completed' && turn?.id) {
    event = { id: `${thread.id}:${turn.id}:completed`, kind: 'completed', at: stableTime(turn.completedAt, turn.updatedAt, turn.startedAt, thread.updatedAt) };
  } else if (status === 'error') {
    const identity = turn?.id || 'thread';
    const detail = turn?.status === 'error' || turn?.status === 'failed' ? turn.status : (thread.errorKind || thread.connectionStatus || 'error');
    event = { id: `${thread.id}:${identity}:error:${detail}`, kind: 'error', at: stableTime(turn?.completedAt, turn?.updatedAt, thread.updatedAt, thread.createdAt) };
  }

  const gitInfo = thread.gitInfo && typeof thread.gitInfo === 'object'
    ? Object.fromEntries(['branch', 'sha'].filter(key => typeof thread.gitInfo[key] === 'string' && thread.gitInfo[key]).map(key => [key, thread.gitInfo[key]]))
    : {};
  const workspace = thread.workspace && typeof thread.workspace === 'object'
    ? Object.fromEntries(['mode', 'root', 'branch', 'baseCommit'].filter(key => typeof thread.workspace[key] === 'string' && thread.workspace[key]).map(key => [key, thread.workspace[key]]))
    : {};
  return {
    id: String(thread.id),
    title: typeof thread.title === 'string' ? thread.title : '',
    harnessId: String(thread.harnessId || ''),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
    originalCwd: typeof thread.originalCwd === 'string' ? thread.originalCwd : (typeof thread.cwd === 'string' ? thread.cwd : ''),
    projectId: resolveThreadProjectId(thread, state),
    updatedAt: stableTime(thread.updatedAt, thread.createdAt),
    status,
    ...(turn?.id ? { turnId: String(turn.id) } : {}),
    ...(event ? { event } : {}),
    ...(Object.keys(gitInfo).length ? { gitInfo } : {}),
    ...(Object.keys(workspace).length ? { workspace } : {}),
  };
}

class AttentionSnapshotService {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.gitBinary = options.gitBinary || 'git';
    this.semaphore = new Semaphore(2);
    this.discoveryCache = new Map();
    this.repositoryCache = new Map();
  }

  async git(cwd, args) {
    return this.semaphore.run(async () => (await execFileAsync(this.gitBinary,
      ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
        cwd,
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      })).stdout);
  }

  cached(cache, key) {
    const item = cache.get(key);
    if (item && Date.now() - item.at < this.cacheTtlMs) return item.value;
    if (item) cache.delete(key);
    return null;
  }

  async discover(input) {
    const key = normalizedDirectory(input);
    const cached = this.cached(this.discoveryCache, key);
    if (cached) return cached;
    let value;
    try {
      const [topLevelText, commonDirText] = await Promise.all([
        this.git(input, ['rev-parse', '--show-toplevel']),
        this.git(input, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ]);
      const topLevel = path.resolve(topLevelText.trim());
      const commonDir = path.resolve(commonDirText.trim());
      const root = path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : topLevel;
      value = { input, root, key: normalizedDirectory(commonDir) };
    } catch (error) {
      value = { input, root: input, key, ...gitFailure(error, input) };
    }
    this.discoveryCache.set(key, { at: Date.now(), value });
    return value;
  }

  async defaultBranch(root, branches) {
    try {
      const remote = (await this.git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
      if ((remote === 'main' || remote === 'master') && branches.some(branch => branch.name === remote)) return remote;
    } catch { /* local repositories need not have a remote HEAD */ }
    if (branches.some(branch => branch.name === 'main')) return 'main';
    if (branches.some(branch => branch.name === 'master')) return 'master';
    return null;
  }

  async inspectRepository(root) {
    const key = normalizedDirectory(root);
    const cached = this.cached(this.repositoryCache, key);
    if (cached) return cached;
    const value = await (async () => {
      try {
        const [logText, branchText, worktreeText] = await Promise.all([
          this.git(root, ['log', '--all', '--topo-order', `--max-count=${MAX_COMMITS + 1}`, '--format=%H%x1f%P%x1f%s%x1f%ct']),
          this.git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(objectname)']),
          this.git(root, ['worktree', 'list', '--porcelain', '-z']),
        ]);
        const allCommits = parseLog(logText);
        const branches = parseBranches(branchText);
        const defaultBranch = await this.defaultBranch(root, branches);
        if (defaultBranch) {
          const [mergedText, unmergedText] = await Promise.all([
            this.git(root, ['branch', '--format=%(refname:short)', '--merged', defaultBranch]),
            this.git(root, ['branch', '--format=%(refname:short)', '--no-merged', defaultBranch]),
          ]);
          const merged = branchNames(mergedText);
          const unmerged = branchNames(unmergedText);
          for (const branch of branches) branch.merged = merged.has(branch.name) ? true : unmerged.has(branch.name) ? false : null;
        } else {
          for (const branch of branches) branch.merged = null;
        }
        const worktrees = parseWorktrees(worktreeText);
        await Promise.all(worktrees.slice(0, MAX_WORKTREES).map(async worktree => {
          try {
            const dirty = await this.git(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
            worktree.dirty = countPorcelainEntries(dirty);
          } catch { worktree.dirty = null; }
        }));
        return {
          id: key,
          root,
          available: true,
          defaultBranch,
          commits: allCommits.slice(0, MAX_COMMITS),
          branches,
          worktrees,
          truncated: allCommits.length > MAX_COMMITS || worktrees.length > MAX_WORKTREES,
        };
      } catch (error) {
        return { id: key, root, available: false, ...gitFailure(error, root), defaultBranch: null, commits: [], branches: [], worktrees: [], truncated: false };
      }
    })();
    this.repositoryCache.set(key, { at: Date.now(), value });
    return value;
  }

  async repositories(paths, errors) {
    const discovered = await Promise.all(paths.map(input => this.discover(input)));
    const groups = new Map();
    for (const entry of discovered) {
      if (!groups.has(entry.key)) groups.set(entry.key, { ...entry, paths: [] });
      groups.get(entry.key).paths.push(entry.input);
    }
    const ordered = [...groups.values()];
    const valid = ordered.filter(group => !group.reason && !group.error);
    const selectedValid = new Set(valid.slice(0, MAX_REPOSITORIES));
    if (valid.length > MAX_REPOSITORIES) errors.push(`Repository limit exceeded: ${valid.length - MAX_REPOSITORIES} omitted`);
    // Unavailable paths remain visible to the caller but never consume the
    // bounded inspection budget reserved for real repositories.
    const selected = ordered.filter(group => group.reason || group.error || selectedValid.has(group));
    return Promise.all(selected.map(async group => {
      if (group.reason || group.error) {
        const reason = group.reason || 'git-error';
        if (reason !== 'not-git' && group.error) errors.push(`${group.input}: ${group.error}`);
        return { id: group.key, root: group.root, paths: group.paths, available: false, reason,
          ...(group.error ? { error: group.error } : {}), defaultBranch: null, commits: [], branches: [], worktrees: [], truncated: false };
      }
      const repository = { ...(await this.inspectRepository(group.root)), id: group.key, paths: group.paths };
      if (!repository.available && repository.reason !== 'not-git' && repository.error) errors.push(`${group.input}: ${repository.error}`);
      return repository;
    }));
  }

  async snapshot(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('attention snapshot params must be an object');
    const requestedPaths = validatePaths(params.cwdPaths);
    if (params.includeGit !== undefined && typeof params.includeGit !== 'boolean') throw new Error('includeGit must be a boolean');
    const state = readCodexProjectState();
    const errors = [];
    const managed = (Array.isArray(this.runtime.threads) ? this.runtime.threads : []).filter(thread => thread && !thread.archived);
    const threads = managed.map(thread => threadProjection(this.runtime, thread, state));
    const paths = [...requestedPaths];
    const pathKeys = new Set(paths.map(normalizedDirectory));
    const recent = [...managed].sort((a, b) => (asTimestamp(b.updatedAt) ?? asTimestamp(b.createdAt) ?? 0)
      - (asTimestamp(a.updatedAt) ?? asTimestamp(a.createdAt) ?? 0));
    for (const thread of recent) {
      if (paths.length >= MAX_TOTAL_PATHS) break;
      if (!isAbsoluteLocalPath(thread.cwd)) {
        if (thread.cwd != null) errors.push(`Managed thread ${thread.id} has an invalid local cwd`);
        continue;
      }
      const absolute = path.resolve(thread.cwd);
      const key = normalizedDirectory(absolute);
      if (pathKeys.has(key)) continue;
      pathKeys.add(key);
      paths.push(absolute);
    }
    const repositories = params.includeGit === true ? await this.repositories(paths, errors) : [];
    return { version: 1, generatedAt: Date.now(), projects: listCodexProjects(state), threads, repositories, errors };
  }
}

module.exports = {
  AttentionSnapshotService,
  MAX_COMMITS,
  MAX_PATH_LENGTH,
  MAX_PATHS,
  MAX_TOTAL_PATHS,
  MAX_REPOSITORIES,
  MAX_WORKTREES,
  countPorcelainEntries,
  isAbsoluteLocalPath,
  normalizedDirectory,
  parseWorktrees,
  threadProjection,
  validatePaths,
};
