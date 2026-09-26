// scripts/fuzz.mjs — 随机模型交叉验证
// 参照判据（与 diagnose() 的 SCC 扫描独立实现）：
//   在增强图 H 上工作，节点 = (verifier 状态 s, 双侧移动掩码 mask)。
//   不可诊断 ⇔ 存在从初态可达的节点 h=(s,3) 且 s.f=1，
//   并且 h 能经非空路径回到自身（即存在 mask 累积为 3 的闭合游走）。
import { parseSpec } from '../src/parser.mjs';
import { diagnose, buildVerifier, tarjan } from '../src/diagnoser.mjs';

// 独立 Kosaraju SCC，仅用于核对 tarjan 的同分量等价关系
function kosarajuComponents(vs) {
  const mark = new Set();
  const order = [];
  const dfs1 = (s) => {
    const st = [s];
    const it = new Map();
    mark.add(s);
    while (st.length) {
      const u = st[st.length - 1];
      let i = it.get(u) ?? 0;
      while (i < u.edges.length && mark.has(u.edges[i].to)) i++;
      if (i < u.edges.length) {
        const w = u.edges[i].to;
        it.set(u, i + 1);
        mark.add(w); st.push(w);
      } else {
        order.push(u); st.pop();
      }
    }
  };
  for (const s of vs) if (!mark.has(s)) dfs1(s);
  const pred = new Map(vs.map((s) => [s, []]));
  for (const s of vs) for (const e of s.edges) pred.get(e.to).push(s);
  const comp = new Map();
  let cid = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const root = order[k];
    if (comp.has(root)) continue;
    const st = [root];
    comp.set(root, cid);
    while (st.length) {
      const u = st.pop();
      for (const w of pred.get(u)) {
        if (!comp.has(w)) { comp.set(w, cid); st.push(w); }
      }
    }
    cid++;
  }
  return comp;
}

let sccChecks = 0;
function assertSccAgree(model) {
  const v = buildVerifier(model);
  const { compOf } = tarjan(v.states);
  const ref = kosarajuComponents(v.states);
  for (const a of v.states) {
    for (const b of v.states) {
      const sameT = compOf.get(a) === compOf.get(b);
      const sameK = ref.get(a) === ref.get(b);
      if (sameT !== sameK) {
        throw new Error(`SCC 划分分歧: states ${a.id} ${b.id}`);
      }
    }
  }
  sccChecks++;
}

function reference(model) {
  const v = buildVerifier(model);
  // 可达 verifier 状态
  const reach = new Set([v.start]);
  const q0 = [v.start];
  while (q0.length) {
    const s = q0.shift();
    for (const e of s.edges) if (!reach.has(e.to)) { reach.add(e.to); q0.push(e.to); }
  }
  const nk = (s, mask) => `${s.id}:${mask}`;
  const succMask = (s, mask) => s.edges.map((e) => ({
    to: e.to,
    mask: mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0),
  }));
  // 对每个可达 f=1 状态 s：在增强图上找从 (s,0) 出发、非空回到某个
  // (s',3)（s'=s）的闭合游走——掩码必须在【闭环内部】累积到 3，
  // 前缀中发生过的双侧移动不算。
  for (const s of v.states) {
    if (s.f !== 1 || !reach.has(s)) continue;
    const depth = new Map([[nk(s, 0), 0]]);
    const q = [{ s, mask: 0, d: 0 }];
    while (q.length) {
      const n = q.shift();
      for (const m of succMask(n.s, n.mask)) {
        if (m.to === s && m.mask === 3) return true;
        const k = nk(m.to, m.mask);
        if (!depth.has(k)) { depth.set(k, n.d + 1); q.push({ s: m.to, mask: m.mask, d: n.d + 1 }); }
      }
    }
  }
  return false;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomModel(rand, n) {
  const locs = Array.from({ length: n }, (_, i) => `L${i}`);
  const lines = [`init ${locs[0]}`, ...locs.map((l) => `loc ${l}`)];
  let id = 0;
  for (const src of locs) {
    const deg = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < deg; k++) {
      const dst = locs[Math.floor(rand() * n)];
      const kind = rand() < 0.28 ? 'F' : 'N';
      const rec = rand() < 0.3
        ? 'SILENT'
        : ['a', 'b', 'c'][Math.floor(rand() * 3)];
      lines.push(`trans t${id++} ${src} ${dst} ${kind} ${rec}`);
    }
  }
  return lines.join('\n');
}

let seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 3000);
let mismatches = 0;
let nonDiag = 0;
for (let i = 0; i < count; i++) {
  const rand = rng(seed++);
  const n = 2 + Math.floor(rand() * 4);
  const text = randomModel(rand, n);
  const model = parseSpec(text);
  if (model.errors.length) continue;
  assertSccAgree(model);
  const got = !diagnose(model).diagnosable;
  const want = reference(model);
  if (got) nonDiag++;
  if (got !== want) {
    mismatches++;
    if (mismatches <= 5) {
      console.log('MISMATCH seed=', seed - 1, 'got(不可诊断)=', got, 'want=', want);
      console.log(text);
      console.log('---');
    }
  }
}
console.log(`fuzz: ${count} models (${nonDiag} non-diagnosable), ${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
