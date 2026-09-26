// server.mjs — 故障闭环审计页 HTTP 服务
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { analyze } from './src/analyze.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
// 单个提交等待复核结果的最长时限（超时摘除，不影响共享复核上的其他等待者）
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30_000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 活动判定任务：jobId -> { shared, timer, finished, resolve, reject }
const jobs = new Map();
// 进行中的共享复核：spec -> { worker, members, finished, computationId }
// 内容完全相同的并发提交共享同一次实际复核，裁决广播给全部等待者
const sharedRuns = new Map();
let computationsStarted = 0; // 累计实际执行的复核次数（共享去重后），健康接口可观测
let runSeq = 0;

function forgetSharedRun(shared) {
  if (sharedRuns.get(shared.spec) === shared) sharedRuns.delete(shared.spec);
}

// 从共享复核上摘除任务（完成/取消/超时共用）
function detachJob(rec) {
  rec.finished = true;
  clearTimeout(rec.timer);
  jobs.delete(rec.jobId);
  rec.shared.members.delete(rec.jobId);
}

// 共享复核已无任何等待者：终止 worker 并摘除，不留孤儿计算
function reapSharedRun(shared) {
  if (shared.finished || shared.members.size > 0) return;
  shared.finished = true;
  forgetSharedRun(shared);
  shared.worker.terminate();
}

// 复核出结果（或异常）：广播给所有仍挂接的任务，随后终止 worker 并摘除
function settleSharedRun(shared, msg) {
  if (shared.finished) return;
  shared.finished = true;
  forgetSharedRun(shared);
  shared.worker.terminate();
  for (const jobId of [...shared.members]) {
    const rec = jobs.get(jobId);
    if (!rec || rec.finished) continue;
    detachJob(rec);
    if (msg.type === 'result') rec.resolve(msg.result);
    else rec.reject(new Error(msg.error?.message ?? '判定失败'));
  }
}

// 把一次提交挂接到共享复核上：独立超时，迟到即摘除，不影响其他等待者
function attachJob(jobId, shared) {
  return new Promise((resolve, reject) => {
    const rec = { jobId, shared, finished: false, resolve, reject, timer: null };
    rec.timer = setTimeout(() => {
      if (rec.finished) return;
      detachJob(rec);
      rec.reject(Object.assign(new Error(`计算超时（${Math.round(JOB_TIMEOUT_MS / 1000)}s），任务已取消`), { statusCode: 409 }));
      reapSharedRun(shared); // 最后一个等待者超时后才终止底层计算
    }, JOB_TIMEOUT_MS);
    jobs.set(jobId, rec);
    shared.members.add(jobId);
  });
}

function runJob(jobId, spec, { useWorker = true } = {}) {
  if (!useWorker) {
    return Promise.resolve().then(() => analyze(spec));
  }
  let shared = sharedRuns.get(spec);
  if (!shared || shared.finished) {
    const worker = new Worker(join(__dirname, 'src', 'worker.mjs'));
    shared = {
      spec, worker, finished: false,
      members: new Set(), computationId: `c${++runSeq}`,
    };
    sharedRuns.set(spec, shared);
    computationsStarted += 1;
    // 一次共享复核只投递一次 run；匹配回执即本次复核的裁决，广播给全部等待者
    worker.on('message', (msg) => {
      if (msg?.computationId !== shared.computationId) return; // 陌生回执一律丢弃
      settleSharedRun(shared, msg);
    });
    worker.on('error', (err) => {
      settleSharedRun(shared, { type: 'error', error: { message: String(err?.message ?? err) } });
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        settleSharedRun(shared, { type: 'error', error: { message: `判定线程异常退出（code ${code}）` } });
      }
    });
    worker.postMessage({ type: 'run', jobId, computationId: shared.computationId, spec });
  }
  return attachJob(jobId, shared);
}

function cancelJob(jobId) {
  const rec = jobs.get(jobId);
  if (!rec || rec.finished) return false;
  const { shared } = rec;
  detachJob(rec);
  // 只取消本任务的等待；共享复核上仍有其他等待者时计算照常继续
  reapSharedRun(shared);
  rec.reject(Object.assign(new Error('任务已被新规程取代或取消'), { statusCode: 409 }));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'local'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        activeJobs: jobs.size,
        activeComputations: sharedRuns.size,
        computationsStarted,
        uptime: Math.round(process.uptime()),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const jobId = String(body?.jobId ?? '');
      const spec = String(body?.spec ?? '');
      const supersedes = body?.supersedes ? String(body.supersedes) : null;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
        return sendJson(res, 400, { error: '非法 jobId' });
      }
      // 同号任务也先作废，避免孤儿 worker；新规程取代旧任务同样终止
      cancelJob(jobId);
      if (supersedes) cancelJob(supersedes);
      const result = await runJob(jobId, spec);
      return sendJson(res, 200, { jobId, result });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
      const cancelled = cancelJob(jobId);
      return sendJson(res, 200, { jobId, cancelled });
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    sendJson(res, err.statusCode ?? 500, { error: String(err.message ?? err) });
  }
});

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('非法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// 供 verify 冒烟使用的命名导出
export { server, runJob, cancelJob };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`故障闭环审计页监听 http://${HOST}:${PORT}（健康检查 /healthz）`);
  });
}
