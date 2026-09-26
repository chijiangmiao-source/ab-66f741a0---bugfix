// scripts/bigspec.mjs — 确定性生成“较大规程”：计算耗时足够（约 1s 量级），
// 供并发共享、取消竞速、取消重提等验收用例在结果返回前可靠地交错执行。
// 同一参数生成内容完全相同的文本；判定结果确定（不可诊断）。
export function genSpec(n = 240, deg = 3) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`loc L${i}`);
  lines.push('init L0');
  let id = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < deg; k++) {
      const dst = `L${(i * (7 + k * 6) + 1 + k * 2) % n}`;
      const kind = (i % 11 === 0 && k === 0) ? 'F' : 'N';
      const rec = ((i + k) % 5 === 0) ? 'SILENT' : `r${(i + k) % 3}`;
      lines.push(`trans t${id++} L${i} ${dst} ${kind} ${rec}`);
    }
  }
  return lines.join('\n');
}

export const BIG_SPEC = genSpec();
