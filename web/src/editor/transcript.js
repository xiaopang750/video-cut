// 把识别出的词按句子分组（同一份 words 数组只算一次）。
// 断句依据：句末标点；或者和下一个词之间有明显停顿（识别结果有时整段不带标点）。
const END_RE = /[.!?。！？…]["”’')）]*$/;
const cache = new WeakMap();

// 按字母数粗估这个词读多久
function spokenDur(w) {
  const letters = w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
  return /[一-鿿]/.test(w.text) ? 0.28 : 0.12 + 0.07 * letters;
}

export function sentencesOf(words) {
  if (!words?.length) return [];
  if (cache.has(words)) return cache.get(words);
  const out = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const pause = next ? next.t0 - (w.t0 + spokenDur(w)) : 0;
    // 长停顿一定断；中等停顿只在已经积累了几个词时才断（避免把列举人名时的停顿切碎）
    const end = !next || END_RE.test(w.text) || pause > 0.8 || (pause > 0.45 && i - i0 + 1 >= 5) || i - i0 >= 16;
    if (end) {
      out.push({ index: out.length, i0, i1: i, t0: words[i0].t0, t1: w.t1 });
      i0 = i + 1;
    }
  }
  cache.set(words, out);
  return out;
}

export function sentenceText(words, s) {
  return words
    .slice(s.i0, s.i1 + 1)
    .map((w) => w.text)
    .join(' ');
}
