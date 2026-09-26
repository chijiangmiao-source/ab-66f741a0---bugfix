// scripts/verify.mjs — Compose verify 服务入口
// 依次执行：语法/构建检查 → 单元测试 → 随机交叉验证 → HTTP 冒烟；
// 任一步失败立即以非零退出码退出（Compose 会显示 exited(1)）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BIG_SPEC } from './bigspec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
    p.on('error', (err) => {
      console.error(`无法启动 ${cmd}: ${err.message}`);
      resolve(-1);
    });
    p.on('checkExit', () => {});
    p.on('exit', (code) => {
      if (!opts.softFail) console.log(`\n[verify] ${cmd} ${args.join(' ')} → exit ${code}`);
      resolve(code ?? -1);
    });
  });
}

async function smoke() {
  console.log('\n[verify] === HTTP 冒烟 ===');
  const remote = process.env.BASE_URL || '';
  let server = null;
  let cancelJob = null;
  let base;
  if (remote) {
    base = remote.replace(/\/$/, '');
    console.log(`[verify] 目标：${base}（Compose web 服务）`);
  } else {
    const PORT = '8911';
    ({ server, cancelJob } = await import('../server.js'));
    await new Promise((r) => server.listen(Number(PORT), '127.0.0.1', r));
    base = `http://127.0.0.1:${PORT}`;
    console.log(`[verify] 目标：${base}（进程内临时服务）`);
  }
  let failures = 0;
  const expect = (cond, msg) => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
    if (!cond) failures++;
  };

  // 1) 健康检查
  let r = await fetch(`${base}/healthz`);
  expect(r.status === 200, '健康检查 200');
  expect((await r.json()).status === 'ok', '健康检查内容 ok');

  // 2) 静默双环 ⇒ 不可诊断
  const silentCase = `loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-1', spec: silentCase }),
  });
  let payload = await r.json();
  expect(r.status === 200, '静默双环 API 200');
  expect(payload.result?.diagnosable === false, '静默双环判为不可诊断');
  expect(
    payload.result?.witness?.prefixReceiptLength === 0,
    '静默双环前缀无回执（不得以位置名称比较代替）');
  const loop = payload.result?.witness?.loop;
  expect(Array.isArray(loop) && loop.every((x) => x.receipt === 'a' || x.receipt === null),
    '闭环回执全部为 a 或 ε');
  expect(loop?.some((x) => x.faultySide.transId) && loop.some((x) => x.normalSide),
    '闭环内两侧都移动（都是无限执行）');

  // 3) 可诊断回执 ⇒ 可诊断
  const diagCase = `loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-2', spec: diagCase }),
  });
  payload = await r.json();
  expect(r.status === 200, '可诊断例 API 200');
  expect(payload.result?.diagnosable === true, '可诊断例判为可诊断');
  expect(payload.result?.witness == null, '可诊断例无伪装证据');

  // 4) 非法输入：悬空目标定位 + 不产出结论
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' }),
  });
  payload = await r.json();
  expect(payload.result?.ok === false, '非法规程 ok=false');
  const dangling = payload.result?.errors?.find((e) => e.message.includes('悬空目标'));
  expect(Boolean(dangling) && dangling.line === 3 && dangling.column === 12,
    '悬空目标定位到第 3 行第 12 列');

  // 5) 静态页面与资源
  r = await fetch(`${base}/`);
  expect(r.status === 200 && (await r.text()).includes('故障闭环审计'), '页面可访问');
  r = await fetch(`${base}/app.js`);
  expect(r.status === 200, 'app.js 可访问');
  r = await fetch(`${base}/styles.css`);
  expect(r.status === 200, 'styles.css 可访问');

  // 6) 取消/过期任务：启动后立即 DELETE；其 promise reject(409)，
  //    随后的新任务结果必须正常，且服务器不残留活动任务
  const big = silentCase; // 当前实现很快，主要验证取消路径不击穿服务
  const [r1] = await Promise.all([
    fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'cancel-me', spec: big }),
    }).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ error: String(e) })),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const dr = await fetch(`${base}/api/jobs/cancel-me`, { method: 'DELETE' });
      return dr.json();
    })(),
  ]);
  // 快任务可能在 5ms 内已完成——两种结局都可接受，但后续健康检查必须 activeJobs=0
  expect(r1.status === 200 || r1.status === 409 || r1.error, '取消竞速不产生 5xx');
  r = await fetch(`${base}/healthz`);
  const h = await r.json();
  expect(h.activeJobs === 0, '取消/完成后无残留任务');

  // 7) 并发共享 / 取消隔离 / 取消重提（大规程，真实 HTTP 交错）
  console.log('\n[verify] === 并发与取消验收（相同规程大模型） ===');
  const health = async () => (await (await fetch(`${base}/healthz`)).json());
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const postSpec = (jobId, spec) => fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, spec }),
  }).then(async (x) => ({ status: x.status, json: await x.json() }));
  const observeWhile = async (inFlight) => {
    let maxJobs = 0;
    let maxComputations = 0;
    let done = false;
    inFlight.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      const hh = await health();
      maxJobs = Math.max(maxJobs, hh.activeJobs);
      maxComputations = Math.max(maxComputations, hh.activeComputations);
      await sleep(25);
    }
    return { maxJobs, maxComputations };
  };

  // 7a) 两个并发页面提交内容完全相同的规程：两者均成功且结果一致，
  //     且服务只执行一次实际复核
  const h0 = await health();
  const both = Promise.all([postSpec('par-a', BIG_SPEC), postSpec('par-b', BIG_SPEC)]);
  const observed = await observeWhile(both);
  const [pa, pb] = await both;
  expect(pa.status === 200, '并发：首个页面收到裁决（200）');
  expect(pb.status === 200, '并发：后一个页面也收到本次裁决（200，不再超时）');
  expect(pa.json.result?.diagnosable === false, '并发：大规程判为不可诊断');
  expect(JSON.stringify(pa.json.result) === JSON.stringify(pb.json.result),
    '并发：两者裁决内容一致');
  expect(observed.maxJobs === 2, `并发：计算期间观测到 2 个活动任务（实际 ${observed.maxJobs}）`);
  expect(observed.maxComputations === 1,
    `并发：在途相同规程只共享一次复核（实际 ${observed.maxComputations}）`);
  let hNow = await health();
  expect(hNow.computationsStarted - h0.computationsStarted === 1,
    '并发：服务只执行了一次实际复核（computationsStarted +1）');
  expect(hNow.activeJobs === 0 && hNow.activeComputations === 0,
    '并发：完成后健康接口无残留活动任务');
  const sharedResult = JSON.stringify(pa.json.result);

  // 7b) 取消其中一个并发页面：另一个继续完成，互不影响
  const keep = postSpec('keep-1', BIG_SPEC);
  const drop = postSpec('drop-1', BIG_SPEC);
  await sleep(150);
  const dr = await fetch(`${base}/api/jobs/drop-1`, { method: 'DELETE' });
  const dj = await dr.json();
  expect(dr.status === 200 && dj.cancelled === true && dj.jobId === 'drop-1',
    '取消：DELETE 响应确认取消（cancelled=true）');
  const [kept, dropped] = await Promise.all([keep, drop]);
  expect(dropped.status === 409 && /取消/.test(dropped.json.error ?? ''),
    `取消：被取消的提交收到 409（实际 ${dropped.status}）`);
  expect(kept.status === 200, '取消：另一并发请求不受影响，正常完成');
  expect(JSON.stringify(kept.json.result) === sharedResult,
    '取消：完成结果与并发组一致（判定确定）');
  hNow = await health();
  expect(hNow.activeJobs === 0 && hNow.activeComputations === 0,
    '取消：完成后健康接口无残留活动任务');

  // 7c) 取消后以原文本重新提交：启动并完成一次新的复核
  const stale = postSpec('re-1', BIG_SPEC);
  await sleep(150);
  await fetch(`${base}/api/jobs/re-1`, { method: 'DELETE' });
  const staleResp = await stale;
  expect(staleResp.status === 409, '重提：被取消的首次提交收到 409');
  const hMid = await health();
  expect(hMid.activeJobs === 0 && hMid.activeComputations === 0,
    '重提：取消后服务不遗留活动任务');
  const again = await postSpec('re-2', BIG_SPEC);
  expect(again.status === 200, '重提：相同文本重新提交正常完成（不再报已取消）');
  expect(JSON.stringify(again.json.result) === sharedResult,
    '重提：新复核结果与此前一致');
  hNow = await health();
  expect(hNow.computationsStarted - hMid.computationsStarted === 1,
    '重提：启动了一次新的实际复核（computationsStarted +1）');
  expect(hNow.activeJobs === 0 && hNow.activeComputations === 0,
    '重提：完成后健康接口无残留活动任务');

  cancelJob?.('not-a-job'); // 覆盖取消不存在任务的路径
  if (server) await new Promise((r) => server.close(r));
  console.log(failures === 0 ? '\n[verify] HTTP 冒烟全部通过' : `\n[verify] HTTP 冒烟失败 ${failures} 处`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  console.log('[verify] 1/4 构建检查（node --check 所有源文件）');
  const files = [
    'server.js', 'src/parser.mjs', 'src/diagnoser.mjs',
    'src/analyze.mjs', 'src/worker.mjs', 'public/app.js',
    'scripts/fuzz.mjs', 'scripts/verify.mjs', 'scripts/bigspec.mjs',
  ];
  for (const f of files) {
    const code = await run('node', ['--check', f]);
    if (code !== 0) process.exit(1);
  }

  console.log('\n[verify] 2/4 单元测试');
  if ((await run('node', ['--test', 'test/'])) !== 0) process.exit(1);

  console.log('\n[verify] 3/4 随机模型交叉验证（2000 例）');
  if ((await run('node', ['scripts/fuzz.mjs', '777', '2000'])) !== 0) process.exit(1);

  console.log('\n[verify] 4/4 HTTP 冒烟');
  if ((await smoke()) !== 0) process.exit(1);

  console.log('\n[verify] ✅ 全部检查通过，verify 正常退出（exit 0）');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] 异常退出:', err);
  process.exit(1);
});
