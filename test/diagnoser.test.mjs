// test/diagnoser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';
import { diagnose, buildVerifier, tarjan } from '../src/diagnoser.mjs';

function analyze(text) {
  const m = parseSpec(text);
  assert.deepEqual(m.errors, [], `规程应无解析错误: ${JSON.stringify(m.errors)}`);
  return diagnose(m);
}

// 静默双环：故障迁移本身静默（无回执），随后故障侧与正常侧在各自环上
// 产生完全相同的可观察序列 'a','a',... ⇒ 不可诊断
const SILENT_DOUBLE_LOOP = `
loc 0
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

test('静默双环：静默故障被正常执行无限伪装 ⇒ 不可诊断', () => {
  const r = analyze(SILENT_DOUBLE_LOOP);
  assert.equal(r.diagnosable, false);
  assert.ok(r.witness, '应给出证据');
  // 公共前缀：静默故障不产生回执 ⇒ 前缀回执长度为 0
  const prefixRecv = r.witness.prefix.filter((e) => e.receipt !== null);
  assert.deepEqual(prefixRecv, []);
  // 闭环内每一步两侧迁移逐步对应，且闭环可观察回执为 a
  const loopReceipts = r.witness.loop.map((e) => e.receipt).filter((x) => x !== null);
  assert.ok(loopReceipts.length >= 1);
  assert.ok(loopReceipts.every((x) => x === 'a'));
  // 闭环中两侧都必须移动（都是无限执行）
  assert.ok(r.witness.loop.some((e) => e.faultySide.transId));
  assert.ok(r.witness.loop.some((e) => e.normalSide));
  // 前缀包含那条 F 静默迁移
  assert.ok(r.witness.prefix.some(
    (e) => e.faultySide.transId === 'f1' && e.faultySide.faulty && e.faultySide.silent));
});

test('证据闭环确实回到入口且可重复（在 verifier 上逐步校验）', () => {
  const m = parseSpec(SILENT_DOUBLE_LOOP);
  const v = buildVerifier(m);
  const r = diagnose(m);
  const byKey = new Map(v.states.map((s) => [`${s.p} ${s.q} ${s.f}`, s]));
  // 沿 prefix 从初态走到 entry
  let cur = v.start;
  for (const step of r.witness.prefix) {
    const e = cur.edges.find((x) =>
      (x.fTrans?.id ?? null) === step.faultySide.transId &&
      (x.nTrans?.id ?? null) === (step.normalSide?.transId ?? null) &&
      x.mode === step.mode);
    assert.ok(e, '前缀每一步都应是真实边');
    cur = e.to;
  }
  assert.equal(cur.p, r.witness.entry.p);
  assert.equal(cur.q, r.witness.entry.q);
  // 沿 loop 走一圈必须回到同一 verifier 状态
  for (const step of r.witness.loop) {
    const e = cur.edges.find((x) =>
      (x.fTrans?.id ?? null) === step.faultySide.transId &&
      (x.nTrans?.id ?? null) === (step.normalSide?.transId ?? null) &&
      x.mode === step.mode);
    assert.ok(e, '闭环每一步都应是真实边');
    cur = e.to;
  }
  assert.equal(cur.p, r.witness.entry.p);
  assert.equal(cur.q, r.witness.entry.q);
});

// 可诊断回执：故障后回执 a 正常侧只能走一次（2 为汇点），无法成环 ⇒ 可诊断
const DIAGNOSABLE_RECEIPT = `
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;

test('可诊断回执：正常侧无法无限复制 ⇒ 可诊断', () => {
  const r = analyze(DIAGNOSABLE_RECEIPT);
  assert.equal(r.diagnosable, true);
  assert.equal(r.witness, null);
  // 已检查的诊断对摘要中包含故障后的混淆对 (1,2)，但它不能无限停留
  const pair = r.checkedPairs.find((x) => x.p === '1' && x.q === '2');
  assert.ok(pair);
  assert.notEqual(pair.verdict, 'ambiguous');
});

// 防误报：故障侧静默故障 + 静默自环，正常侧完全停滞。
// 不存在“正常的无限执行”，朴素 SCC 判定会误报；本算法必须判可诊断。
const FAULT_ONLY_SILENT_LOOP = `
loc 0
loc 1
init 0
trans f1 0 1 F SILENT
trans f2 1 1 N SILENT
`;

test('故障侧独自静默空转不得伪装（正常侧停滞）⇒ 可诊断', () => {
  const r = analyze(FAULT_ONLY_SILENT_LOOP);
  assert.equal(r.diagnosable, true);
});

// 正常侧静默迁移是必要的：N 的匹配路径以一条静默 N 迁移开始，
// 之后两侧在回执 a 上无限同步。缺少 N_SILENT 会漏判。
const N_SILENT_REQUIRED = `
loc 0
loc 1
loc 2
loc 3
loc 4
init 0
trans f1 0 1 F SILENT
trans fa 1 2 N a
trans floop 2 2 N a
trans ne 0 3 N SILENT
trans na 3 4 N a
trans nloop 4 4 N a
`;

test('正常侧静默 N 迁移参与的无限伪装 ⇒ 不可诊断', () => {
  const r = analyze(N_SILENT_REQUIRED);
  assert.equal(r.diagnosable, false);
  assert.ok(r.witness.loop.some((e) => e.normalSide?.transId));
});

test('有限回放陷阱：只有有限混淆前缀、无无限混淆环 ⇒ 可诊断', () => {
  const r = analyze(DIAGNOSABLE_RECEIPT);
  assert.equal(r.diagnosable, true);
});

test('无故障迁移的系统 ⇒ 可诊断', () => {
  const r = analyze(`
loc 0
init 0
trans a 0 0 N x
`);
  assert.equal(r.diagnosable, true);
  assert.equal(r.checkedPairs.length, 0);
});

test('可观察故障 + 同回执双环：经典 twin-plant 反例 ⇒ 不可诊断', () => {
  const r = analyze(`
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F a
trans f2 1 1 N b
trans n1 0 2 N a
trans n2 2 2 N b
`);
  assert.equal(r.diagnosable, false);
  // 前缀回执长度恰为故障回执 a（长度 1）
  assert.equal(r.witness.prefix.filter((e) => e.receipt !== null).length, 1);
});

test('裁决稳定性：同一规程两次计算给出相同证据', () => {
  const a = analyze(SILENT_DOUBLE_LOOP);
  const b = analyze(SILENT_DOUBLE_LOOP);
  const sig = (w) => JSON.stringify({
    prefix: w.prefix.map((e) => [e.mode, e.faultySide.transId, e.normalSide?.transId ?? null]),
    loop: w.loop.map((e) => [e.mode, e.faultySide.transId, e.normalSide?.transId ?? null]),
  });
  assert.equal(sig(a.witness), sig(b.witness));
});

test('SCC 标记：单侧环不被当作双侧环', () => {
  const m = parseSpec(FAULT_ONLY_SILENT_LOOP);
  const v = buildVerifier(m);
  const { comps } = tarjan(v.states);
  for (const c of comps) {
    if (c.movesF && c.movesN) {
      // 任何同时移动两侧的非平凡 SCC 都不应出现在该例
      assert.fail('不应存在双侧移动的环');
    }
  }
});
