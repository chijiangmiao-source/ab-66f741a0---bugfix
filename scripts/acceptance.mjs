// scripts/acceptance.mjs — 并发/取消语义验收（真实 HTTP 请求）
//
// 覆盖：
//   1) 两个并发相同规程：均成功、结果一致，且服务只执行一次实际复核；
//   2) 取消其中一个并发页面：取消响应 cancelled=true、被取消请求 409，
//      另一请求不受影响、照常完成且裁决正确；
//   3) 取消后以相同文本重新提交：启动并完成本次新复核（不残留、不误报已取消）；
//   4) 计算中提交另一份规程：互不影响，各自正常裁决；
//   5) 同页面新提交携带 supersedes 取代在途任务（前端取消提交流程）。
//   每个场景后核对 /healthz 的 activeJobs / activeComputations 均归零。
//
// 用法：
//   BASE_URL=http://web:8080 node scripts/acceptance.mjs   # Compose 内对 web 服务验收
//   node scripts/acceptance.mjs                            # 本地自动拉起临时服务
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 足够大的规程：verifier 同步积约 8 万状态，单次复核约 1.5s，
// 保证并发请求必然重叠、取消必然落在计算窗口内
const SLOW_SPEC = (() => {
  const n = 200, d = 6, lines = [];
  for (let i = 0; i < n; i++) lines.push(`loc L${i}`);
  lines.push('init L0');
  lines.push('trans f1 L0 L1 F SILENT');
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) lines.push(`trans t${k++} L${i} L${(i + 1 + j) % n} N a`);
  }
  return lines.join('\n') + '\n';
})();

// 另一份（可诊断、计算极快）规程，用于“计算中改提交另一份规程”
const FAST_DIAG_SPEC = `loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;

let failures = 0;
const expect = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures++;
};
const expectDeepEqual = (a, b, msg) => {
  try { assert.deepStrictEqual(a, b); expect(true, msg); }
  catch { expect(false, `${msg}（两次响应不一致）`); }
};

let base;
const post = (jobId, spec, extra = {}) =>
  fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, spec, ...extra }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const del = (jobId) =>
  fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
const health = () => fetch(`${base}/healthz`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(pred, what, deadlineMs = 15_000) {
  const t0 = Date.now();
  let last = '尚未连通';
  for (;;) {
    try {
      const h = await health();
      if (pred(h)) return h;
      last = JSON.stringify(h);
    } catch (e) {
      last = String(e?.cause?.code ?? e); // 服务尚未监听时继续等待
    }
    if (Date.now() - t0 > deadlineMs) {
      throw new Error(`等待健康接口条件超时：${what}（当前 ${last}）`);
    }
    await sleep(25);
  }
}

async function main() {
  console.log('[acceptance] === 并发/取消语义验收（真实 HTTP）===');
  let child = null;
  const remote = process.env.BASE_URL?.replace(/\/$/, '') ?? '';
  if (remote) {
    base = remote;
    console.log(`[acceptance] 目标：${base}（既有服务）`);
  } else {
    const PORT = 8917;
    child = spawn(process.execPath, [join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    base = `http://127.0.0.1:${PORT}`;
    console.log(`[acceptance] 目标：${base}（临时拉起的真实服务进程）`);
  }
  try {
    await waitHealth((h) => h.status === 'ok', '服务上线');

    // ---- 场景 1：两个并发相同规程——均成功、结果一致、只复核一次 ----
    console.log('\n[acceptance] 场景 1：两个并发相同规程');
    {
      const h0 = await health();
      const [r1, r2] = await Promise.all([post('acc-1a', SLOW_SPEC), post('acc-1b', SLOW_SPEC)]);
      expect(r1.status === 200 && r2.status === 200, `两个并发请求均成功（${r1.status}/${r2.status}）`);
      expect(r1.body?.result?.diagnosable === false, '裁决正确：大规程判为不可诊断');
      expectDeepEqual(r1.body?.result, r2.body?.result, '两次响应的裁决结果完全一致');
      const h1 = await health();
      const delta = h1.computationsStarted - h0.computationsStarted;
      expect(delta === 1, `服务只执行一次实际复核（computationsStarted Δ=${delta}）`);
      expect(h1.activeJobs === 0 && h1.activeComputations === 0,
        `完成后无残留活动任务（activeJobs=${h1.activeJobs}, activeComputations=${h1.activeComputations}）`);
    }

    // ---- 场景 2：取消其中一个并发页面，另一个继续完成 ----
    console.log('\n[acceptance] 场景 2：取消其中一个并发页面');
    {
      const h0 = await health();
      const p1 = post('acc-2a', SLOW_SPEC);
      await waitHealth((h) => h.activeJobs >= 1, 'acc-2a 已挂接');
      const p2 = post('acc-2b', SLOW_SPEC);
      await waitHealth((h) => h.activeJobs >= 2 && h.activeComputations === 1,
        '两个请求共享同一次复核');
      const d = await del('acc-2a');
      expect(d.status === 200 && d.body?.cancelled === true, '取消响应 cancelled=true');
      const r1 = await p1;
      expect(r1.status === 409, `被取消请求得到 409（实际 ${r1.status}）`);
      const r2 = await p2;
      expect(r2.status === 200 && r2.body?.result?.diagnosable === false,
        '另一请求不受影响，照常完成且裁决正确');
      const h1 = await health();
      const delta = h1.computationsStarted - h0.computationsStarted;
      expect(delta === 1, `取消一个等待者不重启复核（computationsStarted Δ=${delta}）`);
      expect(h1.activeJobs === 0 && h1.activeComputations === 0,
        `完成后无残留活动任务（activeJobs=${h1.activeJobs}, activeComputations=${h1.activeComputations}）`);
    }

    // ---- 场景 3：取消后以相同文本重新提交 ----
    console.log('\n[acceptance] 场景 3：取消后以相同文本重新提交');
    {
      const h0 = await health();
      const p1 = post('acc-3a', SLOW_SPEC);
      await waitHealth((h) => h.activeJobs >= 1, 'acc-3a 已挂接');
      const d = await del('acc-3a');
      expect(d.status === 200 && d.body?.cancelled === true, '取消响应 cancelled=true');
      const r1 = await p1;
      expect(r1.status === 409, `被取消请求得到 409（实际 ${r1.status}）`);
      const r2 = await post('acc-3b', SLOW_SPEC); // 内容保持不变，重新提交
      expect(r2.status === 200 && r2.body?.result?.diagnosable === false,
        '重提请求完成本次新复核（而非悬挂后误报已取消）');
      const h1 = await health();
      const delta = h1.computationsStarted - h0.computationsStarted;
      expect(delta === 2, `取消与重提各启动一次实际复核（computationsStarted Δ=${delta}）`);
      expect(h1.activeJobs === 0 && h1.activeComputations === 0,
        `完成后无残留活动任务（activeJobs=${h1.activeJobs}, activeComputations=${h1.activeComputations}）`);
    }

    // ---- 场景 4：计算中提交另一份规程，互不影响 ----
    console.log('\n[acceptance] 场景 4：计算中提交另一份规程');
    {
      const p1 = post('acc-4a', SLOW_SPEC);
      await waitHealth((h) => h.activeJobs >= 1, 'acc-4a 已挂接');
      const r2 = await post('acc-4b', FAST_DIAG_SPEC);
      expect(r2.status === 200 && r2.body?.result?.diagnosable === true,
        '另一份规程正常裁决（可诊断）');
      const r1 = await p1;
      expect(r1.status === 200 && r1.body?.result?.diagnosable === false,
        '原有大规程复核不受影响，照常完成');
      const h1 = await health();
      expect(h1.activeJobs === 0 && h1.activeComputations === 0,
        `完成后无残留活动任务（activeJobs=${h1.activeJobs}, activeComputations=${h1.activeComputations}）`);
    }

    // ---- 场景 5：同页面携带 supersedes 的新提交取代在途任务 ----
    console.log('\n[acceptance] 场景 5：supersedes 取代在途任务（同规程文本）');
    {
      const p1 = post('acc-5a', SLOW_SPEC);
      await waitHealth((h) => h.activeJobs >= 1, 'acc-5a 已挂接');
      const p2 = post('acc-5b', SLOW_SPEC, { supersedes: 'acc-5a' });
      const r1 = await p1;
      expect(r1.status === 409, `被取代请求得到 409（实际 ${r1.status}）`);
      const r2 = await p2;
      expect(r2.status === 200 && r2.body?.result?.diagnosable === false,
        '新提交完成本次复核');
      const h1 = await health();
      expect(h1.activeJobs === 0 && h1.activeComputations === 0,
        `完成后无残留活动任务（activeJobs=${h1.activeJobs}, activeComputations=${h1.activeComputations}）`);
    }

    // ---- 终检：服务不遗留任何活动任务，后续提交仍可正常裁决 ----
    console.log('\n[acceptance] 终检');
    {
      const h = await health();
      expect(h.activeJobs === 0 && h.activeComputations === 0,
        `健康接口活动任务计数归零（${JSON.stringify(h)}）`);
      const r = await post('acc-final', FAST_DIAG_SPEC);
      expect(r.status === 200 && r.body?.result?.diagnosable === true, '后续提交仍可正常裁决');
    }
  } finally {
    child?.kill();
  }

  console.log(failures === 0
    ? '\n[acceptance] ✅ 验收全部通过'
    : `\n[acceptance] ❌ 验收失败 ${failures} 处`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[acceptance] 异常退出:', err);
  process.exit(1);
});
