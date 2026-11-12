const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  AttentionSnapshotService,
  MAX_COMMITS,
  MAX_PATHS,
  MAX_REPOSITORIES,
  MAX_TOTAL_PATHS,
  MAX_WORKTREES,
  countPorcelainEntries,
  parseWorktrees,
  normalizedDirectory,
} = require('../src/main/native/attention-snapshot');
const { NativeProtocol } = require('../src/main/native/protocol');

function git(cwd, ...args) {
  return execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function commit(repo, message, file, contents) {
  write(path.join(repo, file), contents);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-attention-'));
  const repo = path.join(temp, 'repo');
  const detached = path.join(temp, 'detached-worktree');
  const nonrepo = path.join(temp, 'not-a-repo');
  const codexHome = path.join(temp, 'codex-home');
  fs.mkdirSync(repo);
  fs.mkdirSync(nonrepo);
  fs.mkdirSync(codexHome);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Harness Mix Test');
  git(repo, 'config', 'user.email', 'harness-mix@example.invalid');
  const base = commit(repo, 'base commit', 'base.txt', 'base\n');
  git(repo, 'checkout', '-b', 'merged-topic');
  const mergedCommit = commit(repo, 'merged work', 'merged.txt', 'merged\n');
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', 'merged-topic', '-m', 'merge topic');
  const mergeHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'open-topic');
  const openCommit = commit(repo, 'unmerged work', 'open.txt', 'open\n');
  git(repo, 'checkout', 'main');
  git(repo, 'worktree', 'add', '--detach', detached, base);
  write(path.join(detached, '分离-未跟踪.txt'), 'dirty\n');
  write(path.join(repo, 'main-untracked.txt'), 'dirty\n');
  fs.renameSync(path.join(repo, 'base.txt'), path.join(repo, '基础-重命名.txt'));
  git(repo, 'add', '-A');
  write(path.join(repo, 'main-untracked.txt'), 'dirty\n');

  fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      project: { name: 'Attention Fixture', rootPaths: [repo] },
      fallback: { rootPaths: [path.join(temp, 'fallback-project')] },
    },
    'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'project' } },
  }));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  const now = 1_700_000_000_000;
  const threads = [
    { id: 'running', title: 'Running', harnessId: 'pi', cwd: repo, status: 'working', updatedAt: now, currentTurn: { id: 'turn-running', status: 'running', startedAt: now - 1000 } },
    { id: 'waiting', title: 'Waiting', harnessId: 'claude', cwd: repo, status: 'working', updatedAt: now + 99_999,
      currentTurn: { id: 'turn-waiting', status: 'waiting_interaction', startedAt: now - 2000 },
      interactions: [{ id: 'approval-b', createdAt: now - 500 }, { id: 'approval-a', createdAt: now - 600 }] },
    { id: 'completed', title: 'Completed', harnessId: 'pi', cwd: repo, status: 'ready', updatedAt: now,
      currentTurn: { id: 'turn-completed', status: 'completed', completedAt: new Date(now - 100).toISOString() } },
    { id: 'failed', title: 'Failed', harnessId: 'pi', cwd: repo, status: 'error', updatedAt: now,
      currentTurn: { id: 'turn-failed', status: 'error', completedAt: now - 50 }, gitInfo: { branch: 'main', sha: mergeHead, ignored: 'x' } },
    { id: 'connection-error', title: 'Connection error', harnessId: 'dsh', cwd: nonrepo, status: 'error', connectionStatus: 'error', errorKind: 'auth', updatedAt: now - 25 },
    { id: 'assigned', title: 'Idle worktree', harnessId: 'omp', cwd: detached, originalCwd: repo, status: 'ready', updatedAt: now,
      workspace: { mode: 'worktree', root: detached, branch: 'detached-test', baseCommit: base, source: repo, ignored: true } },
    { id: 'interrupted', title: 'Interrupted', harnessId: 'grok', cwd: repo, status: 'interrupted', updatedAt: now },
    { id: 'archived', title: 'Archived', harnessId: 'pi', cwd: repo, status: 'ready', updatedAt: now, archived: true },
  ];
  const runtime = {
    threads,
    execution: { isRunning(id) { return id === 'running' || id === 'waiting'; } },
  };
  const service = new AttentionSnapshotService(runtime);
  const before = {
    head: git(repo, 'rev-parse', 'HEAD'),
    refs: git(repo, 'for-each-ref', 'refs/heads', '--format=%(refname):%(objectname)'),
    status: git(repo, 'status', '--porcelain', '--untracked-files=normal'),
  };

  try {
    const snapshot = await service.snapshot({ cwdPaths: [repo, detached, nonrepo], includeGit: true });
    assert.equal(snapshot.version, 1);
    assert.ok(Number.isFinite(snapshot.generatedAt));
    assert.deepEqual(snapshot.projects.find(project => project.id === 'project'), { id: 'project', name: 'Attention Fixture', rootPaths: [path.normalize(repo)] });
    assert.equal(snapshot.projects.find(project => project.id === 'fallback').name, 'fallback-project');
    assert.equal(snapshot.threads.length, threads.length - 1, 'archived managed threads are omitted');
    assert.ok(!snapshot.threads.some(thread => thread.id === 'official-thread'), 'snapshot never invents or reads official Codex threads');
    assert.equal(snapshot.threads.find(thread => thread.id === 'running').status, 'running');
    const waiting = snapshot.threads.find(thread => thread.id === 'waiting');
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.event.kind, 'waiting');
    assert.equal(waiting.event.id, 'waiting:turn-waiting:waiting:approval-a,approval-b');
    assert.equal(waiting.event.at, now - 500, 'waiting event uses interaction creation time, not streaming update time');
    assert.equal(snapshot.threads.find(thread => thread.id === 'completed').event.id, 'completed:turn-completed:completed');
    assert.equal(snapshot.threads.find(thread => thread.id === 'completed').event.at, now - 100, 'ISO runtime timestamps normalize to milliseconds');
    assert.equal(snapshot.threads.find(thread => thread.id === 'failed').event.id, 'failed:turn-failed:error:error');
    assert.equal(snapshot.threads.find(thread => thread.id === 'connection-error').event.id, 'connection-error:thread:error:auth');
    assert.equal(snapshot.threads.find(thread => thread.id === 'interrupted').status, 'interrupted');
    assert.deepEqual(snapshot.threads.find(thread => thread.id === 'failed').gitInfo, { branch: 'main', sha: mergeHead });
    assert.deepEqual(snapshot.threads.find(thread => thread.id === 'assigned').workspace,
      { mode: 'worktree', root: detached, branch: 'detached-test', baseCommit: base });
    assert.equal(snapshot.threads.find(thread => thread.id === 'assigned').projectId, 'project', 'worktree maps through original cwd');

    const available = snapshot.repositories.find(item => item.available);
    assert.ok(available);
    assert.equal(available.id, normalizedDirectory(path.join(repo, '.git')));
    assert.equal(available.defaultBranch, 'main');
    assert.deepEqual(new Set(available.paths), new Set([repo, detached]));
    assert.ok(available.commits.some(commit => commit.hash === mergeHead && commit.parents.length === 2), 'real merge parents are returned');
    assert.ok(available.commits.some(commit => commit.hash === openCommit && commit.subject === 'unmerged work'));
    assert.ok(available.commits.length <= MAX_COMMITS);
    assert.equal(available.branches.find(branch => branch.name === 'merged-topic').merged, true);
    assert.equal(available.branches.find(branch => branch.name === 'open-topic').merged, false);
    assert.ok(available.worktrees.some(worktree => normalizedDirectory(worktree.path) === normalizedDirectory(detached)
      && worktree.detached && worktree.branch === null && worktree.dirty === 1));
    assert.ok(available.worktrees.some(worktree => normalizedDirectory(worktree.path) === normalizedDirectory(repo)
      && worktree.branch === 'main' && worktree.dirty === 2), 'NUL porcelain counts a rename and newline filename safely');
    const unavailable = snapshot.repositories.find(item => !item.available);
    assert.equal(unavailable.root, nonrepo);
    assert.equal(unavailable.reason, 'not-git');
    assert.equal(unavailable.error, undefined, 'ordinary non-Git cwd does not expose raw Git stderr');
    assert.ok(!snapshot.errors.some(error => error.includes(nonrepo)), 'ordinary non-Git cwd is not a snapshot-wide error');
    assert.ok(!snapshot.errors.some(error => /fatal:|not a git repository/i.test(error)), 'raw non-Git fatal output is not promoted globally');
    assert.equal(snapshot.repositories.find(item => item.available).root, repo, 'a non-Git sibling does not affect a valid repository');

    const missingPath = path.join(temp, 'missing-project');
    const missingSnapshot = await service.snapshot({ cwdPaths: [missingPath], includeGit: true });
    const missingRepository = missingSnapshot.repositories.find(item => item.paths.includes(missingPath));
    assert.equal(missingRepository.reason, 'missing-path');
    assert.equal(missingRepository.error, 'Directory or Git executable was not found');
    assert.ok(missingSnapshot.errors.some(error => error.includes(missingPath) && error.includes(missingRepository.error)),
      'missing paths remain a scoped diagnostic distinct from ordinary non-Git cwd');

    const stable = await service.snapshot({ includeGit: false });
    assert.equal(stable.repositories.length, 0);
    assert.equal(stable.threads.find(thread => thread.id === 'waiting').event.id, waiting.event.id);
    assert.equal(stable.threads.find(thread => thread.id === 'waiting').event.at, waiting.event.at);

    const managedOnly = new AttentionSnapshotService({
      threads: [{ id: 'managed-only', title: 'Managed only', harnessId: 'pi', cwd: detached, status: 'ready', updatedAt: now }],
      execution: { isRunning() { return false; } },
    });
    const managedGit = await managedOnly.snapshot({ includeGit: true });
    assert.equal(managedGit.repositories.length, 1, 'recent managed cwd supplies Git data without caller/native metadata');
    assert.deepEqual(managedGit.repositories[0].paths, [detached]);

    const protocolRuntime = {
      ...runtime,
      core: { subscribe() { return () => {}; } },
      subscribe() { return () => {}; },
    };
    const protocol = new NativeProtocol(protocolRuntime, () => {});
    try {
      const endpoint = await protocol.request('harnessmix/attention/snapshot', { includeGit: false });
      assert.equal(endpoint.version, 1);
      assert.equal(endpoint.threads.find(thread => thread.id === 'waiting').event.id, waiting.event.id);
      assert.deepEqual(endpoint.repositories, []);
    } finally { protocol.close(); }

    await assert.rejects(service.snapshot({ cwdPaths: ['relative/path'], includeGit: true }), /absolute local/);
    await assert.rejects(service.snapshot({ cwdPaths: ['//server/share'], includeGit: true }), /absolute local/);
    await assert.rejects(service.snapshot({ cwdPaths: [`${repo}\0bad`], includeGit: true }), /absolute local/);
    await assert.rejects(service.snapshot({ cwdPaths: [`C:\\${'x'.repeat(16_384)}`], includeGit: true }), /absolute local/);
    await assert.rejects(service.snapshot({ cwdPaths: Array(MAX_PATHS + 1).fill(repo), includeGit: true }), /at most/);
    await assert.rejects(service.snapshot({ cwdPaths: [], includeGit: 'yes' }), /boolean/);
    await assert.rejects(service.snapshot([]), /must be an object/);

    let gitCalls = 0;
    const noGit = new AttentionSnapshotService(runtime);
    noGit.git = async () => { gitCalls++; throw new Error('must not run'); };
    await noGit.snapshot({ cwdPaths: [repo], includeGit: false });
    assert.equal(gitCalls, 0, 'background status polls skip Git entirely');

    const bounded = new AttentionSnapshotService(runtime);
    bounded.discover = async input => ({ input, root: input, key: normalizedDirectory(input), error: 'fixture failure' });
    const many = Array.from({ length: MAX_REPOSITORIES + 2 }, (_, index) => path.join(temp, `missing-${index}`));
    const boundedErrors = [];
    const boundedRepositories = await bounded.repositories(many, boundedErrors);
    assert.equal(boundedRepositories.length, many.length, 'unavailable descriptors do not consume real repository slots');
    assert.ok(boundedErrors.some(error => error.includes('fixture failure')), 'real discovery failures remain diagnostic');
    assert.ok(!boundedErrors.some(error => error.includes('Repository limit exceeded')),
      'unavailable paths alone do not trigger the real repository limit');

    const priority = new AttentionSnapshotService(runtime);
    const nonGitPaths = Array.from({ length: 20 }, (_, index) => path.join(temp, `ordinary-${index}`));
    const validPaths = Array.from({ length: MAX_REPOSITORIES + 1 }, (_, index) => path.join(temp, `valid-${index}`));
    priority.discover = async input => nonGitPaths.includes(input)
      ? { input, root: input, key: normalizedDirectory(input), reason: 'not-git' }
      : { input, root: input, key: normalizedDirectory(input) };
    priority.inspectRepository = async root => ({ id: normalizedDirectory(root), root, available: true, defaultBranch: null,
      commits: [], branches: [], worktrees: [], truncated: false });
    const priorityErrors = [];
    const prioritized = await priority.repositories([...nonGitPaths, ...validPaths], priorityErrors);
    assert.equal(prioritized.filter(item => !item.available && item.reason === 'not-git').length, nonGitPaths.length,
      'ordinary directories remain represented without using inspection slots');
    assert.deepEqual(prioritized.filter(item => item.available).map(item => item.root), validPaths.slice(0, MAX_REPOSITORIES),
      'valid repositories keep requested-path priority even after many ordinary directories');
    assert.deepEqual(priorityErrors.filter(error => error.includes('Repository limit exceeded')),
      [`Repository limit exceeded: 1 omitted`], 'only real repositories beyond the inspection budget count as overflow');

    const managedPathThreads = Array.from({ length: MAX_PATHS + 8 }, (_, index) => ({
      id: `managed-path-${index}`, title: `Managed ${index}`, harnessId: 'pi', cwd: path.join(temp, `managed-path-${index}`),
      status: 'ready', updatedAt: now - index,
    }));
    const totalBounded = new AttentionSnapshotService({
      threads: managedPathThreads,
      execution: { isRunning() { return false; } },
    });
    totalBounded.discover = async input => ({ input, root: input, key: normalizedDirectory(input), reason: 'not-git' });
    const requestedAtLimit = Array.from({ length: MAX_PATHS }, (_, index) => path.join(temp, `requested-path-${index}`));
    const totalSnapshot = await totalBounded.snapshot({ cwdPaths: requestedAtLimit, includeGit: true });
    assert.equal(totalSnapshot.repositories.length, MAX_TOTAL_PATHS,
      'requested paths and managed additions share the explicit total path bound');
    assert.ok(totalSnapshot.repositories.some(item => item.paths.includes(managedPathThreads[MAX_PATHS - 1].cwd)));
    assert.ok(!totalSnapshot.repositories.some(item => item.paths.includes(managedPathThreads[MAX_PATHS].cwd)),
      'managed additions stop once the combined path bound is reached');

    const syntheticPath = `${temp}\nworktree`;
    assert.equal(parseWorktrees(`worktree ${syntheticPath}\0HEAD ${base}\0detached\0\0`)[0].path, syntheticPath,
      'NUL worktree parser preserves newline paths');
    assert.equal(countPorcelainEntries('?? odd\nname.txt\0R  renamed\npath.txt\0old\npath.txt\0'), 2,
      'NUL status parser counts newline filenames and rename dual records as two changed files');
    const manyWorktrees = new AttentionSnapshotService(runtime, { cacheTtlMs: 0 });
    let statusCalls = 0;
    manyWorktrees.git = async (_cwd, args) => {
      if (args[0] === 'log') return '';
      if (args[0] === 'for-each-ref') return `main\x00${base}\n`;
      if (args[0] === 'symbolic-ref') throw new Error('no remote');
      if (args[0] === 'branch') return args.includes('--merged') ? 'main\n' : '';
      if (args[0] === 'worktree') return Array.from({ length: MAX_WORKTREES + 2 }, (_, index) =>
        `worktree ${path.join(temp, `synthetic-${index}`)}\0HEAD ${base}\0detached\0\0`).join('');
      if (args[0] === 'status') { statusCalls++; return ''; }
      throw new Error(`unexpected Git args: ${args.join(' ')}`);
    };
    const cappedWorktrees = await manyWorktrees.inspectRepository(repo);
    assert.equal(cappedWorktrees.worktrees.length, MAX_WORKTREES + 2);
    assert.equal(statusCalls, MAX_WORKTREES);
    assert.equal(cappedWorktrees.worktrees.at(-1).dirty, null);
    assert.equal(cappedWorktrees.truncated, true);

    const deepHistory = new AttentionSnapshotService(runtime, { cacheTtlMs: 0 });
    const deepHash = index => String(index).padStart(40, '0');
    const deepLog = Array.from({ length: MAX_COMMITS + 1 }, (_, index) => {
      const parents = index === 100
        ? `${deepHash(index + 1)} ${'f'.repeat(40)}`
        : index === MAX_COMMITS ? '' : deepHash(index + 1);
      return `${deepHash(index)}\x1f${parents}\x1fdeep-${index}\x1f${1_700_000_000 - index}`;
    }).join('\n');
    let sawTopoOrder = false;
    deepHistory.git = async (_cwd, args) => {
      if (args[0] === 'log') {
        sawTopoOrder = args.includes('--topo-order');
        assert.ok(!args.includes('--date-order'), 'Git graph acquisition uses topo-order explicitly');
        return deepLog;
      }
      if (args[0] === 'for-each-ref') return `main\x00${deepHash(0)}\n`;
      if (args[0] === 'symbolic-ref') throw new Error('no remote');
      if (args[0] === 'branch') return args.includes('--merged') ? 'main\n' : '';
      if (args[0] === 'worktree') return `worktree ${repo}\0HEAD ${deepHash(0)}\0branch refs/heads/main\0\0`;
      if (args[0] === 'status') return '';
      throw new Error(`unexpected deep-history Git args: ${args.join(' ')}`);
    };
    const deepRepository = await deepHistory.inspectRepository(repo);
    assert.equal(sawTopoOrder, true);
    assert.equal(deepRepository.commits.length, MAX_COMMITS, 'MAX+1 probe is trimmed to MAX commits');
    assert.equal(deepRepository.truncated, true, 'MAX+1 probe marks the repository truncated');
    assert.deepEqual(deepRepository.commits.find(item => item.hash === deepHash(100)).parents,
      [deepHash(101), 'f'.repeat(40)], 'deep merge keeps both raw parent hashes');

    assert.deepEqual({
      head: git(repo, 'rev-parse', 'HEAD'),
      refs: git(repo, 'for-each-ref', 'refs/heads', '--format=%(refname):%(objectname)'),
      status: git(repo, 'status', '--porcelain', '--untracked-files=normal'),
    }, before, 'snapshot service does not change refs, HEAD, index, or working tree');
    assert.equal(mergedCommit, git(repo, 'rev-parse', 'merged-topic'));
    console.log('PASS: attention snapshot threads, stable events, projects, bounded read-only Git graph and failures');
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    try { git(repo, 'worktree', 'remove', '--force', detached); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
