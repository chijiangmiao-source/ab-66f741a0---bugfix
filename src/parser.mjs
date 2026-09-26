// parser.mjs — 规程文本解析与错误定位
//
// 文本格式（每行一条；# 起始为注释；空行忽略）：
//   loc 位置名
//   init 初始位置
//   trans 迁移标识 源位置 目标位置 N|F 回执或 SILENT
//
// 回执为可打印 ASCII（0x20–0x7E）且不含空白；静默迁移写 SILENT。
// 同一行内字段以空白分隔。错误均携带行号与字段范围，供页面定位。

export const SILENT = 'SILENT';

const isReceiptToken = (s) =>
  typeof s === 'string' &&
  s.length > 0 &&
  [...s].every((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0x20 && c <= 0x7e && !(c === 0x20 || c === 0x09);
  });

export function parseSpec(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const errors = [];
  const locations = new Set();
  const order = { loc: [], trans: [] };
  const initDecl = [];
  const transitions = [];
  const seenIds = new Set();

  const push = (line, column, length, message) =>
    errors.push({ line, column, length, message });

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    // 记录去注释前的列位置：去掉行首空白
    const stripped = raw.replace(/\s+$/, '');
    if (stripped.trim() === '' || stripped.trim().startsWith('#')) return;
    const indent = stripped.match(/^\s*/)[0].length;
    const body = stripped.slice(indent);
    const head = body.split(/\s+/, 1)[0];
    const headColumn = indent + 1;
    const fields = body.split(/\s+/);

    if (head === 'loc') {
      const spans = tokenSpans(stripped, indent);
      if (fields.length !== 2) {
        push(lineNo, headColumn, head.length, 'loc 需要恰好 1 个位置名');
        return;
      }
      const name = fields[1];
      const column = spans[1].column;
      if (locations.has(name)) {
        push(lineNo, column, name.length, `位置 ${name} 重复声明`);
        return;
      }
      locations.add(name);
      order.loc.push({ line: lineNo, column, length: name.length, name });
      return;
    }

    if (head === 'init') {
      const spans = tokenSpans(stripped, indent);
      if (fields.length !== 2) {
        push(lineNo, headColumn, head.length, 'init 需要恰好 1 个位置名');
        return;
      }
      const name = fields[1];
      initDecl.push({
        line: lineNo,
        column: spans[1].column,
        length: name.length,
        name,
      });
      return;
    }

    if (head === 'trans') {
      if (fields.length !== 6) {
        push(lineNo, headColumn, head.length,
          'trans 需要 5 个字段：标识 源 目标 N|F 回执或SILENT');
        return;
      }
      const [, id, src, dst, kind, receipt] = fields;
      // 用空白切分并记录每个 token 的真实列（1-based）
      const spans = tokenSpans(stripped, indent);
      if (seenIds.has(id)) {
        push(lineNo, spans[1].column, id.length, `迁移标识 ${id} 重复`);
        return;
      }
      if (kind !== 'N' && kind !== 'F') {
        push(lineNo, spans[4].column, kind.length, "类型只能是 N（正常）或 F（故障）");
        return;
      }
      if (receipt !== SILENT && !isReceiptToken(receipt)) {
        push(lineNo, spans[5].column, receipt.length,
          '回执必须为非空可打印 ASCII（不含空白），或写 SILENT 表示静默');
        return;
      }
      seenIds.add(id);
      order.trans.push({ id, line: lineNo, spans });
      transitions.push({
        id, src, dst,
        faulty: kind === 'F',
        silent: receipt === SILENT,
        receipt: receipt === SILENT ? null : receipt,
        line: lineNo,
      });
      return;
    }

    push(lineNo, headColumn, Math.max(head.length, 1),
      `未知声明 ${head}（只允许 loc / init / trans）`);
  });

  // 结构性校验：初始位置
  if (initDecl.length === 0) {
    push(0, 0, 0, '缺少 init 初始位置声明');
  } else if (initDecl.length > 1) {
    initDecl.slice(1).forEach((d) =>
      push(d.line, d.column, d.length, '初始位置只能声明一次'));
  }
  const init = initDecl[0]?.name ?? null;
  if (init != null && !locations.has(init)) {
    const d = initDecl[0];
    push(d.line, d.column, d.length, `初始位置 ${init} 未用 loc 声明`);
  }

  // 悬空源 / 悬空目标
  transitions.forEach((t) => {
    const span = order.trans.find((o) => o.id === t.id).spans;
    if (!locations.has(t.src)) {
      push(t.line, span[2].column, t.src.length, `悬空源位置：${t.src} 未声明`);
    }
    if (!locations.has(t.dst)) {
      push(t.line, span[3].column, t.dst.length, `悬空目标位置：${t.dst} 未声明`);
    }
  });

  return {
    errors: dedupeErrors(errors),
    locations: [...locations],
    init: locations.has(init) ? init : null,
    transitions,
  };
}

function tokenSpans(line, start = 0) {
  const re = /\S+/g;
  re.lastIndex = start;
  const spans = [];
  let m;
  while ((m = re.exec(line))) {
    spans.push({ column: m.index + 1, length: m[0].length });
  }
  return spans;
}

function dedupeErrors(errors) {
  const seen = new Set();
  const out = [];
  for (const e of errors) {
    const key = `${e.line}:${e.column}:${e.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  out.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  return out;
}
