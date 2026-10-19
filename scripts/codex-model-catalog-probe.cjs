const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JsonlProcess } = require('../src/main/host/jsonl');
const { appServerLaunch } = require('../src/main/adapters/codex-app-server');

let stage = 'spawn';
let diagnosticCount = 0;
const diagnosticFlags = { missingMetadata: false, catalog: false, configuration: false };

(async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-catalog-probe-'));
  const catalog = path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'codex-model-catalogs', 'deepseek-flash.json');
  const selectedCatalog = process.argv.includes('--default') ? undefined : catalog;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    "model_provider = 'local-probe'",
    '[model_providers.local-probe]',
    "name = 'Local probe'",
    "base_url = 'http://127.0.0.1:9'",
    "wire_api = 'responses'",
    'requires_openai_auth = false',
    '',
  ].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i.test(name)));
  env.CODEX_HOME = codexHome;
  const executable = process.platform === 'win32'
    ? execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean)
    : undefined;
  const { command, args } = appServerLaunch(executable, selectedCatalog);
  const server = new JsonlProcess(command, args, { env }, {
    onEvent() {},
    onRequest(message) {
      if (message.method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
      throw new Error('Catalog probe received an unexpected app-server request');
    },
    onDiagnostic(line) {
      diagnosticCount++;
      diagnosticFlags.missingMetadata ||= /model metadata.+not found/i.test(line);
      diagnosticFlags.catalog ||= /model.catalog|catalog.+model/i.test(line);
      diagnosticFlags.configuration ||= /config(?:uration)?\b/i.test(line);
    },
  });
  try {
    stage = 'initialize';
    await server.request('initialize', {
      clientInfo: { name: 'harness-mix-catalog-probe', title: 'Harness Mix catalog probe', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    });
    server.notify('initialized', {});
    stage = 'model/list';
    const listed = await server.request('model/list', { includeHidden: true });
    if (!selectedCatalog) {
      console.log(JSON.stringify({ initialized: true, defaultCatalog: true, diagnosticCount, diagnosticFlags }));
      return;
    }
    const model = listed.data?.find(entry => (entry.model ?? entry.id) === 'deepseek-flash');
    assert.ok(model, 'model/list must include deepseek-flash from the dedicated catalog');
    assert.deepEqual((model.supportedReasoningEfforts ?? []).map(entry => entry.reasoningEffort), ['low', 'high', 'max']);
    console.log(JSON.stringify({ initialized: true, model: model.model ?? model.id, diagnosticCount, diagnosticFlags }));
  } finally {
    const exited = server.child.exitCode === null
      ? new Promise(resolve => server.child.once('exit', resolve))
      : Promise.resolve();
    server.stop();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    fs.rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, stage, harnessExited: error?.harnessExited === true, diagnosticCount, diagnosticFlags }));
  process.exitCode = 1;
});
