// test/server.test.mjs — HTTP 集成测试（临时端口启动真实服务）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';
import { BIG_SPEC } from '../scripts/bigspec.mjs';

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

test('健康检查响应', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.equal(typeof j.activeJobs, 'number');
});

test('静默双环经 HTTP 判为不可诊断，证据完整', async () => {
  const spec = [
    'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
    'trans f1 0 1 F SILENT',
    'trans g1 1 2 N a', 'trans g2 2 1 N a',
    'trans h1 0 3 N a', 'trans h2 3 0 N a',
  ].join('\n');
  const { status, json } = await post('/api/analyze', { jobId: 't1', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, false);
  assert.equal(json.result.witness.prefixReceiptLength, 0);
  assert.ok(json.result.witness.sequencesIdentical);
  assert.ok(json.result.witness.loopReceiptLength >= 1);
});

test('可诊断回执经 HTTP 判为可诊断', async () => {
  const spec = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const { status, json } = await post('/api/analyze', { jobId: 't2', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
});

test('悬空目标返回定位错误且无结论', async () => {
  const { status, json } = await post('/api/analyze',
    { jobId: 't3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' });
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  const e = json.result.errors.find((x) => x.message.includes('悬空目标'));
  assert.ok(e);
  assert.equal(e.line, 3);
  assert.equal(e.column, 12);
});

test('非法 jobId 400、非法 JSON 400、未知路径 404、穿越被拦', async () => {
  const r1 = await post('/api/analyze', { jobId: '../x', spec: '' });
  assert.equal(r1.status, 400);

  const r2 = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  });
  assert.equal(r2.status, 400);

  const r3 = await fetch(`${base}/../etc/passwd`);
  assert.notEqual(r3.status, 200);
});

test('取消不存在的任务返回 cancelled=false', async () => {
  const r = await fetch(`${base}/api/jobs/nope`, { method: 'DELETE' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.cancelled, false);
});

// ---- 并发共享 / 取消 / 重提（大规程，计算期间可靠交错）----

const health = async () => (await (await fetch(`${base}/healthz`)).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在 inFlight 未落定前轮询健康接口，记录观测到的峰值
async function observeHealthWhile(inFlight) {
  let maxJobs = 0;
  let maxComputations = 0;
  let done = false;
  inFlight.then(() => { done = true; }, () => { done = true; });
  while (!done) {
    const h = await health();
    maxJobs = Math.max(maxJobs, h.activeJobs);
    maxComputations = Math.max(maxComputations, h.activeComputations);
    await sleep(25);
  }
  return { maxJobs, maxComputations };
}

test('两个并发相同规程：均成功、结果一致、只执行一次实际复核', async () => {
  const before = await health();
  const inFlight = Promise.all([
    post('/api/analyze', { jobId: 'dup-a', spec: BIG_SPEC }),
    post('/api/analyze', { jobId: 'dup-b', spec: BIG_SPEC }),
  ]);
  const observed = await observeHealthWhile(inFlight);
  const [a, b] = await inFlight;

  assert.equal(a.status, 200, '首个页面应收到裁决');
  assert.equal(b.status, 200, '后一个页面也应收到本次提交的裁决，而非超时');
  assert.deepEqual(b.json.result, a.json.result, '两者裁决内容一致');
  assert.equal(a.json.result.diagnosable, false);

  assert.equal(observed.maxJobs, 2, '计算期间应观测到两个活动任务');
  assert.equal(observed.maxComputations, 1, '相同规程在途时只有一次实际复核');

  const afterH = await health();
  assert.equal(afterH.computationsStarted - before.computationsStarted, 1,
    '服务只执行了一次实际复核');
  assert.equal(afterH.activeJobs, 0, '完成后无残留活动任务');
  assert.equal(afterH.activeComputations, 0, '完成后无残留复核计算');
});

test('取消并发中的一方：不影响另一方完成，且无残留任务', async () => {
  const p1 = post('/api/analyze', { jobId: 'keep-me', spec: BIG_SPEC });
  const p2 = post('/api/analyze', { jobId: 'drop-me', spec: BIG_SPEC });
  await sleep(150); // 确保两者都已进入同一次复核

  const dr = await fetch(`${base}/api/jobs/drop-me`, { method: 'DELETE' });
  const dj = await dr.json();
  assert.equal(dr.status, 200);
  assert.deepEqual(dj, { jobId: 'drop-me', cancelled: true }, '取消响应应确认取消');

  const [kept, dropped] = await Promise.all([p1, p2]);
  assert.equal(dropped.status, 409, '被取消的提交应收到 409');
  assert.match(dropped.json.error, /取消/);
  assert.equal(kept.status, 200, '仍在等待的请求应正常完成');
  assert.equal(kept.json.result.diagnosable, false);

  const h = await health();
  assert.equal(h.activeJobs, 0, '取消+完成后无残留活动任务');
  assert.equal(h.activeComputations, 0);
});

test('取消后以原文本重新提交：完成一次新的复核', async () => {
  const first = post('/api/analyze', { jobId: 'stale-1', spec: BIG_SPEC });
  await sleep(150);
  const dr = await fetch(`${base}/api/jobs/stale-1`, { method: 'DELETE' });
  assert.equal((await dr.json()).cancelled, true);
  assert.equal((await first).status, 409);

  const mid = await health();
  assert.equal(mid.activeJobs, 0, '取消后无残留活动任务');
  assert.equal(mid.activeComputations, 0, '取消后复核计算已终止');

  // 内容不变重提：不得沿用已终止的计算，应启动新复核并完成
  const again = await post('/api/analyze', { jobId: 'stale-2', spec: BIG_SPEC });
  assert.equal(again.status, 200, '重提应完成本次新的复核，而非报已取消');
  assert.equal(again.json.result.ok, true);
  assert.equal(again.json.result.diagnosable, false);

  const afterH = await health();
  assert.equal(afterH.computationsStarted - mid.computationsStarted, 1,
    '重提启动了一次新的实际复核');
  assert.equal(afterH.activeJobs, 0);
  assert.equal(afterH.activeComputations, 0);
});
