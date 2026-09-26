// analyze.mjs — 解析 + 判定 + 视图模型
import { parseSpec } from './parser.mjs';
import { diagnose } from './diagnoser.mjs';

export function analyze(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const result = diagnose(model);

  if (result.diagnosable) {
    return {
      ok: true,
      diagnosable: true,
      stats: {
        locations: model.locations.length,
        transitions: model.transitions.length,
        faultyTransitions: model.transitions.filter((t) => t.faulty).length,
        verifierStates: result.verifierStateCount,
      },
      checkedPairs: result.checkedPairs,
    };
  }

  const w = result.witness;
  const obsOf = (steps) =>
    steps.map((s) => s.receipt).filter((r) => r !== null);
  const prefixObs = obsOf(w.prefix);
  const loopObs = obsOf(w.loop);

  // 校验两侧可观察序列逐元素相同（理论上构造保证，此处再断言式核验）
  const seqF = [];
  const seqN = [];
  for (const s of [...w.prefix, ...w.loop]) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  const identical = seqF.join('') === seqN.join('');

  return {
    ok: true,
    diagnosable: false,
    stats: {
      locations: model.locations.length,
      transitions: model.transitions.length,
      faultyTransitions: model.transitions.filter((t) => t.faulty).length,
      verifierStates: result.verifierStateCount,
    },
    witness: {
      entry: w.entry,
      prefix: w.prefix,
      loop: w.loop,
      prefixObservable: prefixObs,
      loopObservable: loopObs,
      prefixReceiptLength: prefixObs.length,
      loopReceiptLength: loopObs.length,
      faultySideObservable: seqF,
      normalSideObservable: seqN,
      sequencesIdentical: identical,
    },
    checkedPairs: result.checkedPairs,
  };
}
