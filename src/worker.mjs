// worker.mjs — 在工作线程中执行判定，主线程可随时 terminate 取消
import { parentPort } from 'node:worker_threads';
import { analyze } from './analyze.mjs';

parentPort.on('message', (msg) => {
  if (msg?.type !== 'run') return;
  const computationId = String(msg.computationId ?? '');
  try {
    const result = analyze(msg.spec);
    parentPort.postMessage({ type: 'result', computationId, result });
  } catch (err) {
    parentPort.postMessage({
      type: 'error', computationId,
      error: { message: String(err?.message ?? err) },
    });
  }
});
