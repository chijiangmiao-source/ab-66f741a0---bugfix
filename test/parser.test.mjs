// test/parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';

test('合法规程解析', () => {
  const m = parseSpec(`
# 注释行
loc A
loc B
init A
trans t1 A B F SILENT
trans t2 B A N ack.42
`);
  assert.deepEqual(m.errors, []);
  assert.equal(m.init, 'A');
  assert.deepEqual(m.locations.sort(), ['A', 'B']);
  assert.equal(m.transitions.length, 2);
  assert.equal(m.transitions[0].faulty, true);
  assert.equal(m.transitions[0].silent, true);
  assert.equal(m.transitions[0].receipt, null);
  assert.equal(m.transitions[1].receipt, 'ack.42');
});

test('悬空目标定位到具体行列', () => {
  const m = parseSpec(`
loc A
init A
trans t1 A ZZ N ok
`);
  const e = m.errors.find((x) => x.message.includes('悬空目标'));
  assert.ok(e);
  assert.equal(e.line, 4);
  // 该行：trans(1-5) t1(7-8) A(10) ZZ(12)
  const line = 'trans t1 A ZZ N ok';
  assert.equal(line.slice(e.column - 1, e.column - 1 + e.length), 'ZZ');
});

test('悬空源同样定位', () => {
  const m = parseSpec(`
loc A
init A
trans t9 QX A N ok
`);
  const e = m.errors.find((x) => x.message.includes('悬空源'));
  assert.ok(e);
  const line = 'trans t9 QX A N ok';
  assert.equal(line.slice(e.column - 1, e.column - 1 + e.length), 'QX');
});

test('重复迁移标识定位', () => {
  const m = parseSpec(`
loc A
loc B
init A
trans dup A B N a
trans dup B A N b
`);
  const e = m.errors.find((x) => x.message.includes('重复'));
  assert.ok(e);
  assert.equal(e.line, 6);
});

test('非法回执（非 ASCII / 含空白）定位', () => {
  const m = parseSpec(`
loc A
loc B
init A
trans t1 A B N ack-中
`);
  assert.ok(m.errors.some((e) => e.message.includes('回执') && e.line === 5));

  const m2 = parseSpec('loc A\nloc B\ninit A\ntrans t1 A B N "a b"\n');
  assert.ok(m2.errors.some((e) => e.line === 4));
});

test('SILENT 为静默标记；小写 silent 是普通回执（区分大小写）', () => {
  const ok = parseSpec('loc A\nloc B\ninit A\ntrans t1 A B F SILENT\n');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.transitions[0].silent, true);
  assert.equal(ok.transitions[0].receipt, null);
  const lower = parseSpec('loc A\nloc B\ninit A\ntrans t1 A B N silent\n');
  assert.deepEqual(lower.errors, []);
  assert.equal(lower.transitions[0].silent, false);
  assert.equal(lower.transitions[0].receipt, 'silent');
});

test('缺少 / 重复 init 与位置重名', () => {
  assert.ok(parseSpec('loc A\ntrans t1 A A N a\n').errors.some((e) => e.message.includes('init')));
  const dup = parseSpec('loc A\nloc A\ninit A\n');
  assert.ok(dup.errors.some((e) => e.message.includes('重复声明')));
  const twicer = parseSpec('loc A\ninit A\ninit A\n');
  assert.ok(twicer.errors.some((e) => e.message.includes('初始位置只能声明一次')));
});

test('未知声明与字段数错误', () => {
  const m = parseSpec('loc A\ninit A\nedge t1 A A N a\n');
  assert.ok(m.errors.some((e) => e.message.includes('未知声明')));
  const m2 = parseSpec('loc A\ninit A\ntrans t1 A A N\n');
  assert.ok(m2.errors.some((e) => e.message.includes('trans')));
});

test('故障类型字段非法', () => {
  const m = parseSpec('loc A\nloc B\ninit A\ntrans t1 A B X a\n');
  assert.ok(m.errors.some((e) => e.message.includes('N（正常）或 F')));
});
