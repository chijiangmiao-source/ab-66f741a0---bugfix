// test/concurrency.test.mjs — 并发相同规程共享复核、取消与重提的 HTTP 集成测试
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

// 足够大的规程：单次复核约 0.5s，保证并发重叠与取消窗口
const SLOW_SPEC = (() => {
  const n = 120, d = 6, lines = [];
  for (let i = 0; i < n; i++) lines.push(`loc L${i}`);
  lines.push('init L0');
  lines.push('trans f1 L0 L1 F SILENT');
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) lines.push(`trans t${k++} L${i} L${(i + 1 + j) % n} N a`);
  }
  return lines.join('\n') + '\n';
})();

const post = (jobId, spec, extra = {}) =>
  fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, spec, ...extra }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const del = (jobId) =>
  fetch(`${base}/api/jobs/${jobId}`, { method: 'DELETE' }).then((r) => r.json());
const health = () => fetch(`${base}/healthz`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(pred, deadlineMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const h = await health();
    if (pred(h)) return h;
    assert.ok(Date.now() - t0 < deadlineMs, `等待健康接口条件超时：${JSON.stringify(h)}`);
    await sleep(20);
  }
}

test('两个并发相同规程：均成功、结果一致、只执行一次实际复核', async () => {
  const h0 = await health();
  const [r1, r2] = await Promise.all([post('cc-1a', SLOW_SPEC), post('cc-1b', SLOW_SPEC)]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.result.diagnosable, false);
  assert.deepEqual(r2.body.result, r1.body.result);
  const h1 = await health();
  assert.equal(h1.computationsStarted - h0.computationsStarted, 1, '只应启动一次实际复核');
  assert.equal(h1.activeJobs, 0);
  assert.equal(h1.activeComputations, 0);
});

test('取消其中一个并发页面：另一个照常完成，服务不残留任务', async () => {
  const h0 = await health();
  const p1 = post('cc-2a', SLOW_SPEC);
  await waitHealth((h) => h.activeJobs >= 1);
  const p2 = post('cc-2b', SLOW_SPEC);
  await waitHealth((h) => h.activeJobs >= 2 && h.activeComputations === 1);
  const d = await del('cc-2a');
  assert.equal(d.cancelled, true);
  const r1 = await p1;
  assert.equal(r1.status, 409, '被取消请求应得到 409');
  const r2 = await p2;
  assert.equal(r2.status, 200);
  assert.equal(r2.body.result.diagnosable, false);
  const h1 = await health();
  assert.equal(h1.computationsStarted - h0.computationsStarted, 1, '取消等待者不应重启复核');
  assert.equal(h1.activeJobs, 0);
  assert.equal(h1.activeComputations, 0);
});

test('取消后以相同文本重新提交：完成本次新复核', async () => {
  const h0 = await health();
  const p1 = post('cc-3a', SLOW_SPEC);
  await waitHealth((h) => h.activeJobs >= 1);
  const d = await del('cc-3a');
  assert.equal(d.cancelled, true);
  const r1 = await p1;
  assert.equal(r1.status, 409);
  const r2 = await post('cc-3b', SLOW_SPEC); // 原文本重提
  assert.equal(r2.status, 200);
  assert.equal(r2.body.result.diagnosable, false);
  const h1 = await health();
  assert.equal(h1.computationsStarted - h0.computationsStarted, 2, '取消与重提各启动一次复核');
  assert.equal(h1.activeJobs, 0);
  assert.equal(h1.activeComputations, 0);
});

test('计算中提交另一份规程：互不影响', async () => {
  const fastDiag = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const p1 = post('cc-4a', SLOW_SPEC);
  await waitHealth((h) => h.activeJobs >= 1);
  const r2 = await post('cc-4b', fastDiag);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.result.diagnosable, true);
  const r1 = await p1;
  assert.equal(r1.status, 200);
  assert.equal(r1.body.result.diagnosable, false);
  const h1 = await health();
  assert.equal(h1.activeJobs, 0);
  assert.equal(h1.activeComputations, 0);
});

test('supersedes 取代在途任务：被取代者 409，新提交完成复核', async () => {
  const p1 = post('cc-5a', SLOW_SPEC);
  await waitHealth((h) => h.activeJobs >= 1);
  const p2 = post('cc-5b', SLOW_SPEC, { supersedes: 'cc-5a' });
  const r1 = await p1;
  assert.equal(r1.status, 409);
  const r2 = await p2;
  assert.equal(r2.status, 200);
  assert.equal(r2.body.result.diagnosable, false);
  const h1 = await health();
  assert.equal(h1.activeJobs, 0);
  assert.equal(h1.activeComputations, 0);
});
