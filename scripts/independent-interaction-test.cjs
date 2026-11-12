const assert = require('node:assert/strict');
const { NativeProtocol } = require('../src/main/native/protocol');

(async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = { respond: async message => { calls++; assert.equal(message.result.decision, 'accept'); await gate; return true; } };
  const request = params => NativeProtocol.prototype.request.call(context, 'harnessmix/interaction/respond', params);
  const params = { requestId: 'harness-mix:approval:a', result: { decision: 'accept' } };
  const first = request(params), retry = request(params);
  await Promise.resolve(); assert.equal(calls, 1); release();
  assert.deepEqual(await first, { accepted: true }); assert.deepEqual(await retry, { accepted: true });
  assert.deepEqual(await request(params), { accepted: true }); assert.equal(calls, 1);
  await assert.rejects(request({ ...params, result: { decision: 'decline' } }), /different response/);
  await assert.rejects(request({ requestId: 'official-request', result: {} }), /Invalid Harness/);
  const failing = { respond: async () => { throw new Error('native failed'); } };
  await assert.rejects(NativeProtocol.prototype.request.call(failing, 'harnessmix/interaction/respond', params), /native failed/);
  assert.equal(failing.panelInteractionResponses.size, 0);
  failing.respond = async () => false;
  await assert.rejects(NativeProtocol.prototype.request.call(failing, 'harnessmix/interaction/respond', params), /no longer pending/);
  console.log('independent interaction: acknowledged delivery, concurrent dedupe, retry and stale request checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
