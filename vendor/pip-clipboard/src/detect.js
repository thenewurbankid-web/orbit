// Heuristic detection: is a text snippet code (and which language), or prose (and which
// natural language)? No model, no network; cheap enough to run on every paste.

const LANG_RULES = [
  { lang: 'json', test: (t) => /^\s*[[{]/.test(t) && isJson(t), weight: 10 },
  { lang: 'html', re: [/<(!doctype|html|head|body|div|span|p|a|ul|li|script|style|section|img)\b[^>]*>/i, /<\/[a-z]+>/i], weight: 3 },
  { lang: 'css', re: [/^\s*[.#@]?[\w-][^{\n]*\{\s*[a-z-]+\s*:[^;{}]+;/m, /(^|[\s{;])(color|margin|padding|display|font-size|background|border)\s*:[^;{}]+;/], weight: 2 },
  { lang: 'python', re: [/^\s*def \w+\(.*\):\s*$/m, /^\s*(from [\w.]+ )?import \w+/m, /^\s*class \w+(\(.*\))?:\s*$/m, /\bself\b/, /^\s*(elif|except|with .* as \w+:)/m, /print\(/, /:\s*\n\s{2,}\S/] },
  { lang: 'typescript', re: [/\binterface \w+\s*\{/, /:\s*(string|number|boolean|void|unknown|any)\b/, /\btype \w+\s*=/, /\bimport .* from ['"]/, /<\w+>\(/, /\bas const\b/] },
  { lang: 'javascript', re: [/\b(const|let|var) \w+\s*=/, /=>\s*[{(]?/, /\bfunction\s*\w*\s*\(/, /\b(console|document|window)\./, /\brequire\(['"]/, /\bimport .* from ['"]/, /\bexport (default|const|function)/, /===|!==/] },
  { lang: 'go', re: [/^package \w+/m, /\bfunc (\(\w+ \*?\w+\) )?\w+\(/, /:=/, /\bfmt\./, /^import \(/m] },
  { lang: 'rust', re: [/\bfn \w+\(/, /\blet mut\b/, /\bimpl\b/, /::\w+/, /\bpub (fn|struct|enum)\b/, /println!\(/, /&str\b/] },
  { lang: 'java', re: [/\bpublic (static )?(class|void|int|String)\b/, /System\.out\.println/, /\bprivate final\b/, /@Override/] },
  { lang: 'c', re: [/#include\s*[<"]/, /\bint main\s*\(/, /\bprintf\(/, /->\w+/, /\bstd::/] },
  { lang: 'ruby', re: [/^\s*def \w+[^:]*$/m, /^\s*end\s*$/m, /\bputs\b/, /\.each do \|/, /\battr_accessor\b/] },
  { lang: 'php', re: [/<\?php/, /\$\w+\s*=/, /->\w+\(/, /\becho\b/] },
  { lang: 'sql', re: [/\bSELECT\b[\s\S]+\bFROM\b/i, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE)\b/i, /\bWHERE\b/i, /\bJOIN\b/i] },
  { lang: 'shell', re: [/^\s*\$ \w+/m, /^#!\/(usr\/)?bin\/(env )?(ba|z)?sh/m, /\b(sudo|apt-get|brew|npm|pnpm|yarn|git|cd|ls|grep|curl|export|echo)\b [-\w./]/m, /\|\s*(grep|awk|sed|xargs)\b/, /&&\s*\w+/] },
  { lang: 'yaml', re: [/^\s*[\w-]+:\s+\S/m, /^\s*-\s+[\w-]+:\s/m, /^---\s*$/m] },
  { lang: 'markdown', re: [/^#{1,6} \S/m, /^\s*[-*] \S/m, /\[[^\]]+\]\([^)]+\)/, /^```/m] },
];

function isJson(t) {
  const s = t.trim();
  if (s.length < 2 || s.length > 500000) return false;
  try { const v = JSON.parse(s); return v !== null && typeof v === 'object'; } catch { return false; }
}

const CODE_LINE_HINTS = [
  /[;{}]\s*$/, /^\s*(\/\/|#(?!\s*$)|--|\/\*|\*)/, /^\s{2,}\S/, /^\t+\S/, /^\s*(function|return|const|let|var|def|class|import|export|public|private|static|fn|func|package|interface|type)\b.*[({=:;]/, /\b(if|for|while|switch|catch)\s*\(/, /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/,
  /[=!<>]=|=>|->|::|&&|\|\|/, /\w+\([^)]*\)\s*[;{:]?\s*$/, /^\s*[)\]}]+[;,]?\s*$/, /^\s*<\/?[a-z][^>]*>\s*$/i,
];

/** Returns { isCode, language, score }. */
export function detectCode(text) {
  if (typeof text !== 'string') return { isCode: false, language: '', score: 0 };
  const t = text.slice(0, 20000);
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { isCode: false, language: '', score: 0 };

  if (isJson(t)) return { isCode: true, language: 'json', score: 1 };

  let hits = 0;
  for (const line of lines.slice(0, 200)) if (CODE_LINE_HINTS.some((re) => re.test(line))) hits++;
  const lineRatio = hits / Math.min(lines.length, 200);
  const symbols = (t.match(/[{}()[\];=<>:$#|&*]/g) || []).length / Math.max(1, t.length);
  const words = t.split(/\s+/).filter(Boolean);
  const avgWord = words.reduce((a, w) => a + w.length, 0) / Math.max(1, words.length);
  const proseLike = /[.!?]["')\]]?\s+[A-Z]/.test(t) && symbols < 0.03;

  let score = lineRatio * 0.6 + Math.min(symbols * 8, 0.4);
  if (proseLike) score -= 0.3;
  if (lines.length === 1 && symbols < 0.05) score -= 0.25;
  if (avgWord > 12 && symbols < 0.02) score -= 0.2;

  const language = guessCodeLanguage(t);
  if (language && language !== 'markdown' && language !== 'yaml') score += 0.15;
  const isCode = score >= 0.45;
  return { isCode, language: isCode ? language || 'code' : '', score: Math.round(score * 100) / 100 };
}

export function guessCodeLanguage(text) {
  let best = '';
  let bestScore = 0;
  for (const rule of LANG_RULES) {
    let s = 0;
    if (rule.test) s = rule.test(text) ? rule.weight : 0;
    else s = rule.re.reduce((a, re) => a + (re.test(text) ? 1 : 0), 0) * (rule.weight || 1);
    if (s > bestScore) { bestScore = s; best = rule.lang; }
  }
  // TypeScript is a superset of JavaScript: only call it TS on TS-only signals.
  if (best === 'javascript' || best === 'typescript') {
    const ts = /\binterface \w+|:\s*(string|number|boolean|void)\b|\btype \w+\s*=|\bas const\b/.test(text);
    best = ts ? 'typescript' : 'javascript';
  }
  return bestScore >= 1 ? best : '';
}

// ---- natural language ---------------------------------------------------

const SCRIPTS = [
  ['ja', /[぀-ヿ]/g], ['ko', /[가-힯]/g], ['zh', /[一-鿿]/g], ['ru', /[Ѐ-ӿ]/g],
  ['ar', /[؀-ۿ]/g], ['he', /[֐-׿]/g], ['hi', /[ऀ-ॿ]/g], ['el', /[Ͱ-Ͽ]/g],
  ['th', /[฀-๿]/g], ['te', /[ఀ-౿]/g], ['ta', /[஀-௿]/g],
];

const STOPWORDS = {
  en: ['the', 'and', 'is', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'you', 'this', 'are', 'was', 'on', 'be'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'se', 'del', 'las', 'por', 'un', 'una', 'para', 'es', 'con'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'du', 'que', 'pour', 'dans', 'pas', 'sur', 'avec'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'von', 'sich', 'auf', 'ich', 'auch'],
  pt: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'não', 'uma', 'os', 'no', 'se'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'un', 'non', 'in', 'sono', 'mi', 'si', 'ho', 'lo', 'ma', 'della'],
  nl: ['de', 'het', 'een', 'van', 'en', 'is', 'dat', 'op', 'te', 'niet', 'zijn', 'voor', 'met', 'ik', 'je', 'die'],
};

/** Best-effort natural language code (ISO 639-1) or '' when unsure. */
export function detectLanguage(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const sample = text.slice(0, 5000);
  const letters = (sample.match(/\p{L}/gu) || []).length || 1;
  for (const [code, re] of SCRIPTS) {
    const c = (sample.match(re) || []).length;
    if (c / letters > 0.3) return code === 'zh' && /[぀-ヿ]/.test(sample) ? 'ja' : code;
  }
  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 3) return '';
  let best = '';
  let bestScore = 0;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const s = words.reduce((a, w) => a + (set.has(w) ? 1 : 0), 0);
    if (s > bestScore) { bestScore = s; best = code; }
  }
  return bestScore / words.length >= 0.08 ? best : '';
}

export const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi',
  el: 'Greek', th: 'Thai', te: 'Telugu', ta: 'Tamil',
};

// ---- light syntax highlighting -------------------------------------------

const KEYWORDS = {
  javascript: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch true false type var',
  rust: 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void volatile while',
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define nullptr class public private namespace using template std',
  ruby: 'alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require',
  php: 'abstract and array as break case catch class const continue declare default do echo else elseif empty extends false final for foreach function global if implements include interface isset new null or private protected public require return static switch throw true try use var while',
  sql: 'select from where and or not insert into values update set delete create table drop alter index join left right inner outer on group by order having limit offset as distinct null is in like between union all case when then else end primary key foreign references',
  shell: 'if then else elif fi for while do done case esac function in export local return echo cd ls grep sed awk sudo git npm curl',
  css: 'important media supports keyframes from to',
  json: 'true false null',
};
KEYWORDS.typescript = `${KEYWORDS.javascript} interface type enum implements private public protected readonly declare namespace abstract as keyof never unknown any string number boolean`;

const COMMENT_STYLE = {
  python: ['#'], ruby: ['#'], shell: ['#'], yaml: ['#'], sql: ['--', '/*'], css: ['/*'], html: ['<!--'], json: [],
};

/**
 * Tokenise code into [{ t: 'kw'|'str'|'com'|'num'|'txt', v }]. Pure, so the UI can render
 * each token with textContent; never produces markup.
 */
export function highlightTokens(code, language = '') {
  const lang = language || 'javascript';
  const kw = new Set((KEYWORDS[lang] || KEYWORDS.javascript).split(' '));
  const ci = lang === 'sql';
  const comments = COMMENT_STYLE[lang] || ['//', '/*'];
  const tokens = [];
  const push = (t, v) => {
    const last = tokens[tokens.length - 1];
    if (last && last.t === t && t === 'txt') last.v += v; else tokens.push({ t, v });
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const rest2 = code.slice(i, i + 4);
    let matched = false;
    for (const c of comments) {
      if (rest2.startsWith(c)) {
        let end;
        if (c === '/*') { end = code.indexOf('*/', i + 2); end = end === -1 ? n : end + 2; }
        else if (c === '<!--') { end = code.indexOf('-->', i + 4); end = end === -1 ? n : end + 3; }
        else { end = code.indexOf('\n', i); end = end === -1 ? n : end; }
        push('com', code.slice(i, end));
        i = end; matched = true; break;
      }
    }
    if (matched) continue;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && code[j] !== ch && !(code[j] === '\n' && ch !== '`')) { if (code[j] === '\\') j++; j++; }
      push('str', code.slice(i, Math.min(j + 1, n)));
      i = Math.min(j + 1, n);
      continue;
    }
    if (/[0-9]/.test(ch) && !/[\w$]/.test(code[i - 1] || '')) {
      const m = /^(0x[0-9a-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(code.slice(i, i + 40));
      if (m) { push('num', m[0]); i += m[0].length; continue; }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 80));
      const word = m[0];
      push(kw.has(ci ? word.toLowerCase() : word) ? 'kw' : 'txt', word);
      i += word.length;
      continue;
    }
    push('txt', ch);
    i++;
  }
  return tokens;
}
