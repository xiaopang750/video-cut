const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|heic|heif)$/i;

function cleanName(value) {
  const name = String(value ?? '')
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  return (name.split(/[\\/]/).pop() || '').toLocaleLowerCase('en-US');
}

function parts(value) {
  const full = cleanName(value);
  const stem = full.replace(IMAGE_EXT_RE, '');
  const noPrefix = stem.replace(/^(?:img|image|pic)[ _-]*/i, '');
  // macOS / 相机会给同一张图追加 _2、-2 之类的重复序号。
  // 精确匹配已经在前面尝试过，所以这里只作为较弱的 fallback。
  const withoutCopySuffix = noPrefix.replace(/^(.+?)[_-]\d+$/, '$1');
  return { full, stem, noPrefix, withoutCopySuffix };
}

export function lastImageNumber(value) {
  return (parts(value).stem.match(/(\d+)(?!.*\d)/) || [])[1] || null;
}

export function imageReferenceOrdinal(reference) {
  const value = parts(reference).noPrefix;
  return /^\d+$/.test(value) ? Number(value) : null;
}

// 按强到弱匹配：完整文件名 -> 不含后缀 -> 不含 IMG_ 前缀 ->
// 不含 _2 这类重复序号 -> 兼容旧逻辑（文件名最后一段数字）。
export function findImageByReference(reference, images, getName = (item) => item) {
  if (reference == null || !Array.isArray(images) || !images.length) return null;
  const wanted = parts(reference);
  if (!wanted.stem) return null;

  const candidates = images.map((item) => ({ item, ...parts(getName(item)) }));
  const match = (key) => candidates.find((candidate) => candidate[key] && candidate[key] === wanted[key])?.item || null;
  const wantedLastNumber = lastImageNumber(wanted.stem);

  return (
    match('full') ||
    match('stem') ||
    match('noPrefix') ||
    match('withoutCopySuffix') ||
    (wantedLastNumber && candidates.find((candidate) => lastImageNumber(candidate.stem) === wantedLastNumber)?.item) ||
    null
  );
}
