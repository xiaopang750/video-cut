// 轻量 RTF -> 纯文本解析（够用即可：处理 \uN、\'hh、字体字符集、分组跳过），
// 以及把文字稿按 #pic#序号 标记切分成「页」。

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'expandedcolortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'headerl', 'headerr', 'footerl', 'footerr', 'headerf', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'filetbl', 'revtbl',
  'mmathPr', 'pgdsctbl', 'fldinst', 'txfieldtext', 'bkmkstart', 'bkmkend', 'field', 'nonshppict', 'shppict',
]);

const CHARSET_ENCODING = {
  0: 'windows-1252',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
};

const SYMBOL_WORDS = {
  emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•',
  emspace: ' ', enspace: ' ', qmspace: ' ',
};

// Node 的 TextDecoder('windows-1252') 实际按 latin1 解码（0x80-0x9F 会变成控制字符），这里自己补齐
const CP1252_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const cp1252 = {
  decode: (bytes) => Array.from(bytes, (b) => CP1252_HIGH[b] || String.fromCharCode(b)).join(''),
};

function decoderFor(charset, ansiCpg) {
  let enc = CHARSET_ENCODING[charset];
  if (!enc && ansiCpg) enc = ansiCpg === 936 ? 'gbk' : ansiCpg === 950 ? 'big5' : `windows-${ansiCpg}`;
  if (!enc || enc === 'windows-1252') return cp1252;
  try {
    return new TextDecoder(enc);
  } catch {
    return cp1252;
  }
}

export function rtfToText(input) {
  const s = typeof input === 'string' ? input : Buffer.from(input).toString('latin1');
  if (!s.startsWith('{\\rtf')) return Buffer.from(s, 'latin1').toString('utf8');

  const ansiCpg = Number((s.match(/\\ansicpg(\d+)/) || [])[1]) || 0;
  const fontCharset = {};
  const fontTable = s.match(/\{\\fonttbl([\s\S]*?)\}\s*(?:\{\\colortbl|\{\\\*|\\)/);
  if (fontTable) {
    for (const m of fontTable[1].matchAll(/\\f(\d+)[^;{}]*?\\fcharset(\d+)/g)) fontCharset[m[1]] = Number(m[2]);
  }

  let out = '';
  let bytes = [];
  let state = { skip: false, uc: 1, charset: 0 };
  const stack = [];
  let ucSkip = 0;
  let groupStart = false;

  const flush = () => {
    if (!bytes.length) return;
    if (!state.skip) out += decoderFor(state.charset, ansiCpg).decode(Uint8Array.from(bytes));
    bytes = [];
  };
  const emit = (text) => {
    flush();
    if (!state.skip) out += text;
  };

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '{') {
      flush();
      stack.push(state);
      state = { ...state };
      groupStart = true;
      i++;
      continue;
    }
    if (c === '}') {
      flush();
      state = stack.pop() || state;
      groupStart = false;
      ucSkip = 0;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = s[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (ucSkip > 0) ucSkip--;
        else emit(next);
        i += 2;
        groupStart = false;
        continue;
      }
      if (next === "'") {
        const hex = s.slice(i + 2, i + 4);
        i += 4;
        groupStart = false;
        if (ucSkip > 0) {
          ucSkip--;
          continue;
        }
        if (!state.skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (next === '\n' || next === '\r') {
        emit('\n');
        i += 2;
        groupStart = false;
        continue;
      }
      if (next === '*') {
        state.skip = true;
        i += 2;
        continue;
      }
      if (next === '~') {
        emit(' ');
        i += 2;
        continue;
      }
      if (next === '-' || next === '_') {
        if (next === '_') emit('-');
        i += 2;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i + 1, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      i += 1 + m[0].length;
      const word = m[1];
      const param = m[2] !== undefined ? Number(m[2]) : null;
      const wasGroupStart = groupStart;
      groupStart = false;

      if (wasGroupStart && SKIP_DESTINATIONS.has(word)) {
        state.skip = true;
        continue;
      }
      switch (word) {
        case 'par':
        case 'line':
        case 'sect':
        case 'page':
          emit('\n');
          break;
        case 'tab':
          emit('\t');
          break;
        case 'uc':
          state.uc = param ?? 1;
          break;
        case 'u': {
          let code = param ?? 0;
          if (code < 0) code += 65536;
          emit(String.fromCharCode(code));
          ucSkip = state.uc;
          break;
        }
        case 'f':
          flush();
          state.charset = fontCharset[param] ?? 0;
          break;
        case 'bin':
          i += param || 0;
          break;
        default:
          if (SYMBOL_WORDS[word]) emit(SYMBOL_WORDS[word]);
      }
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    groupStart = false;
    if (ucSkip > 0) {
      ucSkip--;
      i++;
      continue;
    }
    if (!state.skip) {
      flush();
      out += c;
    }
    i++;
  }
  flush();
  // RTF 源文件用 latin1 读入，普通字符若是 UTF-8 多字节（少见）这里不处理
  return out
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

// 支持纯编号或图片文件名，例如：
// #pic#4313、#pic#IMG_4399_2.JPG、#pic#4399_2、#_4313、#img_4313（行内结尾也可）
const MARK_LINE = /^\s*#\s*(?:pic|img|image|p)?\s*[#_\-:：]?\s*([^#\r\n]*\d[^#\r\n]*)\s*$/i;
const MARK_TAIL = /^(.*?\S)\s*#\s*(?:pic|img|image)?\s*[#_]\s*([^#\r\n]*\d[^#\r\n]*)\s*$/i;

function toBlocks(lines) {
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

export function parseScript(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const raw = [];
  let cur = [];
  for (const line of lines) {
    const m = line.match(MARK_LINE);
    if (m) {
      raw.push({ imageNo: m[1].trim(), lines: cur });
      cur = [];
      continue;
    }
    const t = line.match(MARK_TAIL);
    if (t) {
      cur.push(t[1]);
      raw.push({ imageNo: t[2].trim(), lines: cur });
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) raw.push({ imageNo: null, lines: cur });
  return raw.map((r) => ({ imageNo: r.imageNo, blocks: toBlocks(r.lines) })).filter((r) => r.blocks.length || r.imageNo);
}
