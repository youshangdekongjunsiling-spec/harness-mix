const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  create,
  spawnSession,
  nativeSubagentMessages,
  resolveCmdShim,
  resolveClaudeExecutable,
} = require('../src/main/adapters/claude');

(async () => {
  const originalLegacy = process.env.HARNESS_MIX_CLAUDE_EXECUTABLE;
  const originalCanonical = process.env.HARNESSMIX_CLAUDE_COMMAND;
  const outputRoot = path.resolve('output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(outputRoot, 'claude-executable-test-'));
  try {
    delete process.env.HARNESS_MIX_CLAUDE_EXECUTABLE;
    delete process.env.HARNESSMIX_CLAUDE_COMMAND;
    assert.deepEqual(resolveClaudeExecutable(), { configured: null, executable: null, source: 'sdk' });

    const executable = path.join(fixtureRoot, 'claude.exe');
    assert.equal(resolveClaudeExecutable({ HARNESSMIX_CLAUDE_COMMAND: executable }).executable, executable);
    assert.equal(resolveClaudeExecutable({ HARNESS_MIX_CLAUDE_EXECUTABLE: 'legacy.exe', HARNESSMIX_CLAUDE_COMMAND: executable }).configured,
      'legacy.exe', 'the existing process override keeps compatibility precedence');

    const cli = path.join(fixtureRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const shim = path.join(fixtureRoot, 'claude.cmd');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "if (process.argv.includes('--version')) console.log('Claude Code 9.9.9');\n");
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    assert.equal(resolveCmdShim(shim), cli, 'npm .cmd wrappers resolve to the executable consumed by the SDK');
    const unsupportedShim = path.join(fixtureRoot, 'unsupported.cmd');
    fs.writeFileSync(unsupportedShim, '@ECHO off\r\necho unsupported\r\n');
    assert.throws(() => resolveCmdShim(unsupportedShim), /不是受支持的 npm/);

    process.env.HARNESSMIX_CLAUDE_COMMAND = shim;
    let options;
    const events = [];
    const sdk = {
      query(args) { options = args.options; return { async *[Symbol.asyncIterator]() {} }; },
      async getSubagentMessages(parent, agent, readOptions) {
        assert.equal(parent, 'parent-1');
        assert.equal(agent, 'agent-1');
        assert.equal(readOptions.dir, process.cwd());
        return [
          { type: 'user', message: { content: [{ type: 'text', text: '检查实现' }] } },
          { type: 'assistant', message: { content: [{ type: 'text', text: '已检查' }] } },
        ];
      },
    };
    const session = spawnSession(sdk, { cwd: process.cwd(), emit: event => events.push(event) });
    assert.equal(options.pathToClaudeCodeExecutable, cli, 'query uses the resolved configured executable');
    await options.hooks.SubagentStart[0].hooks[0]({ session_id: 'parent-1', agent_id: 'agent-1', agent_type: 'reviewer' });
    await options.hooks.SubagentStop[0].hooks[0]({ session_id: 'parent-1', agent_id: 'agent-1', agent_type: 'reviewer' });
    await new Promise(resolve => setImmediate(resolve));
    clearInterval(session.childPoll);
    const child = events.filter(event => event.kind === 'native-subagent').at(-1);
    assert.equal(child.nativeSessionId, 'parent-1:agent:agent-1');
    assert.equal(child.status, 'success');
    assert.equal(child.messages[1].parts[0].text, '已检查');
    assert.equal(nativeSubagentMessages([]).length, 0);

    const configuredInspection = await create().inspect();
    assert.equal(configuredInspection.available, true);
    assert.match(configuredInspection.detail, /Claude Code 9\.9\.9/);
    assert.match(configuredInspection.detail, /HARNESSMIX_CLAUDE_COMMAND/);

    const permissionAdapter = create();
    const permissionSession = {
      permissionMode: 'default',
      query: { async setPermissionMode() { throw new Error('native busy'); } },
    };
    await assert.rejects(permissionAdapter.setPermissionMode(permissionSession, 'acceptEdits'), /native busy/);
    assert.equal(permissionSession.permissionMode, 'default',
      'a rejected SDK transition must not mutate the adapter effective mode');

    delete process.env.HARNESSMIX_CLAUDE_COMMAND;
    let defaultOptions;
    const defaultSession = spawnSession({
      query(args) { defaultOptions = args.options; return { async *[Symbol.asyncIterator]() {} }; },
    }, { cwd: process.cwd(), emit() {} });
    clearInterval(defaultSession.childPoll);
    assert.equal(Object.hasOwn(defaultOptions, 'pathToClaudeCodeExecutable'), false,
      'no override leaves executable selection to the SDK bundle');
    const defaultInspection = await create().inspect();
    assert.equal(defaultInspection.available, true);
    assert.match(defaultInspection.detail, /^Agent SDK 内置 Claude Code/);
  } finally {
    if (originalLegacy === undefined) delete process.env.HARNESS_MIX_CLAUDE_EXECUTABLE;
    else process.env.HARNESS_MIX_CLAUDE_EXECUTABLE = originalLegacy;
    if (originalCanonical === undefined) delete process.env.HARNESSMIX_CLAUDE_COMMAND;
    else process.env.HARNESSMIX_CLAUDE_COMMAND = originalCanonical;
    if (fixtureRoot.startsWith(`${outputRoot}${path.sep}`)) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  console.log('Claude native subagent transcript projection passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
