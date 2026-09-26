// diagnoser.mjs — 静默 DES 的故障可诊断性判定（verifier / twin-plant）
//
// 精确判定命题：
//   是否存在两条无限执行 πF（经过至少一条 F 迁移）与 πN（从不经过 F 迁移），
//   二者的可观察回执序列（剔除 SILENT 后的 ASCII 回执）逐元素完全相同。
// 存在 ⇒ 故障可被正常执行无限期伪装 ⇒ 不可诊断（NOT_DIAGNOSABLE）。
//
// verifier 状态 = (p, q, f)
//   p：故障副本（完整自动机）所在位置；q：正常副本（删除全部 F 迁移）所在位置
//   f=1：故障副本已经走过某条 F 迁移；f=0：尚未。
// 三类边（正常副本永不走 F）：
//   SYNC     两侧各走一条非静默、回执相同的迁移；故障副本取 F 时 f 置 1
//   F_SILENT 故障副本单独走一条 SILENT 迁移（F 时 f 置 1）
//   N_SILENT 正常副本单独走一条 SILENT 的 N 迁移，f 不变
//
// 不可诊断 ⇔ 从初态可达的某个 f=1 SCC 中，存在一条“合格闭环”：
// 闭环内既有移动故障副本的边、又有移动正常副本的边（因此闭环重复时
// 两侧都是无限执行；仅故障副本静默自环、正常侧停滞不算）。

export function buildVerifier(model) {
  const { init, transitions } = model;
  const out = new Map();
  for (const t of transitions) {
    if (!out.has(t.src)) out.set(t.src, []);
    out.get(t.src).push(t);
  }
  const from = (p) => out.get(p) ?? [];

  const states = new Map();
  const get = (p, q, f) => {
    const k = `${p} ${q} ${f}`;
    let s = states.get(k);
    if (!s) {
      s = { id: states.size, p, q, f, edges: [] };
      states.set(k, s);
    }
    return s;
  };

  let edgeSeq = 0;
  const addEdge = (s, ns, edge) => {
    s.edges.push({ seq: edgeSeq++, ...edge, to: ns });
    if (!ns.enqueued) { ns.enqueued = true; queue.push(ns); }
  };

  const start = get(init, init, 0);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const s = queue[head];
    const a = from(s.p);
    const b = from(s.q);

    // F_SILENT：故障副本单独静默（F 或 N）
    for (const x of a) {
      if (!x.silent) continue;
      const ns = get(x.dst, s.q, s.f | (x.faulty ? 1 : 0));
      addEdge(s, ns, { mode: 'F_SILENT', fTrans: x, nTrans: null, receipt: null });
    }

    // N_SILENT：正常副本单独静默（只能是 N）
    for (const y of b) {
      if (!y.silent || y.faulty) continue;
      const ns = get(s.p, y.dst, s.f);
      addEdge(s, ns, { mode: 'N_SILENT', fTrans: null, nTrans: y, receipt: null });
    }

    // SYNC：双侧非静默、回执相同；正常副本只能走 N
    for (const x of a) {
      if (x.silent) continue;
      for (const y of b) {
        if (y.silent || y.faulty || x.receipt !== y.receipt) continue;
        const ns = get(x.dst, y.dst, s.f | (x.faulty ? 1 : 0));
        addEdge(s, ns, { mode: 'SYNC', fTrans: x, nTrans: y, receipt: x.receipt });
      }
    }
  }

  return { states: [...states.values()], start };
}

// 迭代式 Tarjan SCC（显式栈，避免 verifier 状态数万时递归栈溢出）
export function tarjan(vs) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const compOf = new Map();
  const comps = [];

  for (const root of vs) {
    if (idx.has(root)) continue;
    // 栈帧：{ v, i }（i 为下一条待处理出边下标）
    const callStack = [{ v: root, i: 0 }];
    idx.set(root, index); low.set(root, index); index++;
    stack.push(root); onStack.add(root);

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const v = frame.v;
      if (frame.i < v.edges.length) {
        const w = v.edges[frame.i++].to;
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          callStack.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        // 出边处理完毕：若是某父帧的树子节点，向父帧传播 lowlink
        if (low.get(v) === idx.get(v)) {
          const cid = comps.length;
          const members = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            compOf.set(w, cid);
            members.push(w);
          } while (w !== v);

          const memberIds = new Set(members.map((m) => m.id));
          let movesF = false, movesN = false;
          for (const m of members) {
            for (const e of m.edges) {
              if (!memberIds.has(e.to.id)) continue;
              if (e.fTrans) movesF = true;
              if (e.nTrans) movesN = true;
            }
          }
          comps.push({ id: cid, members, movesF, movesN });
        }
        callStack.pop();
        const parent = callStack[callStack.length - 1];
        // 树子节点（仍在 Tarjan 栈上才传播；已单独成 SCC 的不传播）
        if (parent && onStack.has(v)) {
          low.set(parent.v, Math.min(low.get(parent.v), low.get(v)));
        }
      }
    }
  }
  return { compOf, comps };
}

function reachable(start) {
  const seen = new Set([start]);
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    for (const e of q[h].edges) {
      if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  return seen;
}

const edgeKey = (e) =>
  `${e.fTrans?.id ?? ''}|${e.nTrans?.id ?? ''}|${e.mode}`;
const recvCount = (edges) => edges.filter((e) => e.receipt !== null).length;
const pathKey = (edges) => edges.map(edgeKey).join(',');
const edgeWeight = (e) => (e.mode === 'SYNC' ? 1 : 0);

// 简易二叉堆，按 (cost, key) 排序
function heap() {
  const a = [];
  const less = (x, y) => x[0] - y[0] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p]) < 0) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < a.length && less(a[l], a[m]) < 0) m = l;
      if (r < a.length && less(a[r], a[m]) < 0) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  };
  return {
    push: (item) => { a.push(item); up(a.length - 1); },
    pop: () => { const t = a[0], l = a.pop(); if (a.length) { a[0] = l; down(0); } return t; },
    get size() { return a.length; },
  };
}

// 全目标 Dijkstra：返回每个可达节点的最优记录（cost 最小，平局路径标识键最小）
function dijkstraAll(start) {
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: start, pathKey: '' };
  best.set(start.id, startRec);
  h.push([0, start, '']);
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(node.id);
    if (!rec || rec.cost !== cost) continue; // 过期堆条目
    for (const e of node.edges) {
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(e.to.id);
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: e.to, pathKey: nkey };
        best.set(e.to.id, nr);
        h.push([ncost, e.to, nkey]);
      }
    }
  }
  return best;
}

function recToEdges(rec) {
  const edges = [];
  for (let r = rec; r.parent; r = r.parent.rec) edges.push(r.parent.edge);
  return edges.reverse();
}

// 初态到目标 verifier 状态的最短通路（静默权 0、同步权 1）
function shortestPath(allBest, start, goal) {
  if (start === goal) return [];
  const rec = allBest.get(goal.id);
  return rec ? recToEdges(rec) : null;
}

// 合格闭环：s 出发回到 s，只走 cid 分量内部边，且闭环中
// 至少一条移动故障副本的边、一条移动正常副本的边（mask=3）。
// 在增强空间 (verifier 状态, mask) 上做 Dijkstra，目标 (s,3)。
function qualifyingCycle(s, compOf, cid) {
  const startNode = { vs: s, mask: 0 };
  const keyOf = (n) => n.vs.id * 4 + n.mask;
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: startNode, pathKey: '' };
  best.set(keyOf(startNode), startRec);
  h.push([0, startNode, '']);
  let goalRec = null;
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(keyOf(node));
    if (!rec || rec.cost !== cost) continue;
    if (node.vs === s && node.mask === 3) { goalRec = rec; break; }
    for (const e of node.vs.edges) {
      if (compOf.get(e.to) !== cid) continue;
      const next = {
        vs: e.to,
        mask: node.mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0),
      };
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(keyOf(next));
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: next, pathKey: nkey };
        best.set(keyOf(next), nr);
        h.push([ncost, next, nkey]);
      }
    }
  }
  if (!goalRec) return null;
  return recToEdges(goalRec);
}

export function diagnose(model) {
  const v = buildVerifier(model);
  const { compOf, comps } = tarjan(v.states);
  const fromStart = reachable(v.start);

  // 合格歧义 SCC：可达、f=1、内部同时能移动两侧（含两侧无限执行的闭环）
  const ambiguous = v.states.filter((s) => {
    if (s.f !== 1 || !fromStart.has(s)) return false;
    const c = comps[compOf.get(s)];
    return c.movesF && c.movesN;
  });

  const checkedPairs = v.states
    .filter((s) => s.f === 1 && fromStart.has(s))
    .map((s) => {
      const c = comps[compOf.get(s)];
      let verdict;
      if (c.movesF && c.movesN) verdict = 'ambiguous';
      else if (!c.movesF && !c.movesN) verdict = 'acyclic';
      else if (!c.movesN) verdict = 'normal-side-stalls';
      else verdict = 'fault-side-stalls';
      return { p: s.p, q: s.q, movesF: c.movesF, movesN: c.movesN, verdict };
    })
    .sort((a, b) => a.p.localeCompare(b.p) || a.q.localeCompare(b.q));

  if (ambiguous.length === 0) {
    return {
      diagnosable: true,
      verifierStateCount: v.states.length,
      witness: null,
      checkedPairs,
    };
  }

  // 公共前缀只算一次（全目标最短路径）
  const allBest = dijkstraAll(v.start);

  // 按合格 SCC 分组。裁决先比前缀回执长度：每个 SCC 只需考察
  // “前缀最短”的入口（平局通常唯一），再在其上求最短合格闭环。
  const byComp = new Map();
  for (const s of ambiguous) {
    const cid = compOf.get(s);
    if (!byComp.has(cid)) byComp.set(cid, []);
    byComp.get(cid).push(s);
  }

  const candidates = [];
  for (const [cid, members] of byComp) {
    let minCost = Infinity;
    for (const s of members) {
      const c = allBest.get(s.id)?.cost ?? Infinity;
      if (c < minCost) minCost = c;
    }
    for (const s of members) {
      if ((allBest.get(s.id)?.cost ?? Infinity) !== minCost) continue;
      const prefix = shortestPath(allBest, v.start, s);
      const loop = qualifyingCycle(s, compOf, cid);
      if (prefix && loop) {
        candidates.push({ entry: { p: s.p, q: s.q }, prefix, loop });
      }
    }
  }
  candidates.sort((a, b) => {
    const d1 = recvCount(a.prefix) - recvCount(b.prefix);
    if (d1 !== 0) return d1;
    const d2 = recvCount(a.loop) - recvCount(b.loop);
    if (d2 !== 0) return d2;
    return `${pathKey(a.prefix)}#${pathKey(a.loop)}`.localeCompare(
      `${pathKey(b.prefix)}#${pathKey(b.loop)}`);
  });

  const win = candidates[0];
  return {
    diagnosable: false,
    verifierStateCount: v.states.length,
    witness: {
      entry: win.entry,
      prefix: win.prefix.map(edgeView),
      loop: win.loop.map(edgeView),
    },
    checkedPairs,
  };
}

function edgeView(e) {
  return {
    mode: e.mode,
    receipt: e.receipt,
    faultySide: {
      transId: e.fTrans?.id ?? null,
      from: e.fTrans ? e.fTrans.src : null,
      to: e.fTrans ? e.fTrans.dst : null,
      faulty: e.fTrans ? e.fTrans.faulty : false,
      silent: e.fTrans ? e.fTrans.silent : false,
    },
    normalSide: e.nTrans ? {
      transId: e.nTrans.id,
      from: e.nTrans.src,
      to: e.nTrans.dst,
      faulty: false,
      silent: e.nTrans.silent,
    } : null,
  };
}
