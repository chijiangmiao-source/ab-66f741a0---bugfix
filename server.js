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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 活动判定任务：jobId -> { shared, finished, timer, resolve, reject }
const jobs = new Map();
// 进行中的复核计算：spec -> shared。内容相同的在途提交共享同一次实际复核，
// 每个提交仍按自己的 jobId 获得裁决；任一等待者取消/超时只摘除自身，
// 最后一个等待者离开时才终止 worker，不留孤儿计算。
const sharedRuns = new Map();
let computationSeq = 0;
let computationsStarted = 0; // 累计启动的实际复核次数（/healthz 可观测）

function forgetSharedRun(shared) {
  if (sharedRuns.get(shared.spec) === shared) sharedRuns.delete(shared.spec);
}

// 结束一次共享复核：摘除登记并终止 worker（幂等）
function finishSharedRun(shared) {
  if (shared.finished) return;
  shared.finished = true;
  forgetSharedRun(shared);
  shared.worker.terminate();
}

// 结算单个任务：从 jobs 与所属共享复核中摘除并落地结果；
// 该复核已无任何等待者时立即终止，不遗留活动任务
function settleJob(rec, err, result) {
  if (rec.finished) return;
  rec.finished = true;
  clearTimeout(rec.timer);
  jobs.delete(rec.jobId);
  const { shared } = rec;
  shared.members.delete(rec.jobId);
  if (err) rec.reject(err); else rec.resolve(result);
  if (!shared.finished && shared.members.size === 0) finishSharedRun(shared);
}

// 复核失败（worker 错误/异常退出）：所有等待者一并结算
function failSharedRun(shared, err) {
  const members = [...shared.members.values()];
  finishSharedRun(shared);
  for (const rec of members) settleJob(rec, err);
}

function startSharedRun(spec) {
  const worker = new Worker(join(__dirname, 'src', 'worker.mjs'));
  const shared = {
    spec,
    worker,
    computationId: `c${++computationSeq}`,
    finished: false,
    members: new Map(), // jobId -> rec（共享本次复核的全部提交）
  };
  sharedRuns.set(spec, shared);
  computationsStarted++;
  worker.on('message', (msg) => {
    // 过期/陌生回执一律丢弃
    if (shared.finished || msg?.computationId !== shared.computationId) return;
    const err = msg.type === 'result'
      ? null
      : new Error(msg.error?.message ?? '判定失败');
    const members = [...shared.members.values()];
    finishSharedRun(shared);
    // 同一次实际复核的裁决派发给共享它的每一个提交
    for (const rec of members) settleJob(rec, err, msg.result);
  });
  worker.on('error', (err) => failSharedRun(shared, err));
  worker.on('exit', (code) => {
    if (!shared.finished) {
      failSharedRun(shared, new Error(`判定线程异常退出（code ${code}）`));
    }
  });
  worker.postMessage({ type: 'run', computationId: shared.computationId, spec });
  return shared;
}

function joinSharedRun(jobId, shared, resolve, reject) {
  const rec = { jobId, shared, finished: false, resolve, reject, timer: null };
  rec.timer = setTimeout(() => {
    settleJob(rec, Object.assign(new Error('计算超时（30s），任务已取消'), { statusCode: 409 }));
  }, 30_000);
  jobs.set(jobId, rec);
  shared.members.set(jobId, rec);
}

function runJob(jobId, spec, { useWorker = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!useWorker) {
      try { resolve(analyze(spec)); } catch (e) { reject(e); }
      return;
    }
    // 内容相同的在途复核：直接共享其计算，不重复启动 worker
    let shared = sharedRuns.get(spec);
    if (!shared || shared.finished) shared = startSharedRun(spec);
    joinSharedRun(jobId, shared, resolve, reject);
  });
}

function cancelJob(jobId) {
  const rec = jobs.get(jobId);
  if (!rec || rec.finished) return false;
  // 只摘除本任务；其余等待者继续共享复核，最后离开者才终止 worker
  settleJob(rec, Object.assign(new Error('任务已被新规程取代或取消'), { statusCode: 409 }));
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
