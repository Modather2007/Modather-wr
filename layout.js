// layout.js - pure logic (no DOM): text grouping, sentence splitting, clean-cut search, page planning.
// Everything here works with plain numbers so it can be tested outside the browser.

export const HAS_AR = /[\u0600-\u06FF]/;
export const HAS_WORDS = /\p{L}{3,}/u;
const PUA = /[\uE000-\uF8FF]/g;
const BULLET = /^\s*(?:[\uE000-\uF8FF\u2022\u25CF\u25CB\u25AA\u25A0\u25A1\u25E6\u2043\u27A2\u25BA\u00A7\u00D8\u00B7]\s*|[-\u2013\u2014*]\s+|\d+[.)]\s+|o\s+)/;
const STEP = /^\s*Step\s*\d+[.:]/i;
const SEP_ALL = /(\s+[\u00B7|]\s+|\s=\s)/;
const SEP_DOT = /(\s+[\u00B7|]\s+)/;

function isUpper(ch) {
  return !!ch && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

export function worthTranslating(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  const words = toks.filter((t) => t.replace(/[^\p{L}]/gu, "").length >= 3);
  return words.length >= 2 || (words.length === 1 && toks.length <= 8);
}

// ---------------------------------------------------------------- text -> segments -> paragraphs

// items: [{str, x, y, w, size}]  (points, y = baseline measured from the TOP of the page)
export function itemsToSegments(items, opts = {}) {
  const rtl = !!opts.rtl;
  const its = items
    .filter((i) => i.str && i.str.trim() !== "")
    .map((i) => ({ ...i }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  for (const it of its) {
    let line = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 8; k--) {
      const L = lines[k];
      if (Math.abs(it.y - L.y) <= 0.35 * Math.max(it.size, L.size)) {
        line = L;
        break;
      }
    }
    if (!line) {
      line = { y: it.y, size: it.size, items: [] };
      lines.push(line);
    }
    line.items.push(it);
  }

  const segs = [];
  for (const L of lines) {
    // reading order: left to right, or right to left for Arabic pages
    L.items.sort(rtl ? (a, b) => b.x + b.w - (a.x + a.w) : (a, b) => a.x - b.x);
    const lineSegs = [];
    for (const it of L.items) {
      const x0 = it.x;
      const x1 = it.x + it.w;
      const y0 = it.y - 0.85 * it.size;
      const y1 = it.y + 0.25 * it.size;
      const last = lineSegs[lineSegs.length - 1];
      const gapW = last ? (rtl ? last.x0 - x1 : x0 - last.x1) : 0;
      if (last && gapW <= Math.max(8, 1.2 * it.size)) {
        const needSpace = gapW > 0.15 * it.size && !/\s$/.test(last.text) && !/^\s/.test(it.str);
        last.text += (needSpace ? " " : "") + it.str;
        last.x0 = Math.min(last.x0, x0);
        last.x1 = Math.max(last.x1, x1);
        last.y0 = Math.min(last.y0, y0);
        last.y1 = Math.max(last.y1, y1);
        last.sizes.push(it.size);
      } else {
        lineSegs.push({ text: it.str, x0, y0, x1, y1, sizes: [it.size] });
      }
    }
    for (const g of lineSegs) {
      g.text = g.text.trim();
      g.size = g.sizes.reduce((a, b) => a + b, 0) / g.sizes.length;
      g.multi = lineSegs.length > 1;
      segs.push(g);
    }
  }
  return segs;
}

export function groupSegments(segsIn) {
  const segs = [...segsIn].sort((a, b) => Math.round(a.y0) - Math.round(b.y0) || a.x0 - b.x0);
  const paras = [];
  for (const g of segs) {
    let target = null;
    for (let k = paras.length - 1; k >= 0; k--) {
      const p = paras[k];
      const last = p.last;
      const gap = g.y0 - last.y1;
      const limit = (g.multi || last.multi ? 0.3 : 0.6) * g.size;
      if (gap < -0.6 * g.size || gap > limit) continue;
      if (Math.abs(g.x0 - last.x0) > 3 * g.size) continue;
      if (!(g.x0 < p.x1 && g.x1 > p.x0)) continue;
      target = p;
      break;
    }
    const startsNew =
      !target ||
      BULLET.test(g.text) ||
      STEP.test(g.text) ||
      (/[.!?\u061F]$/.test(target.last.text) && isUpper(g.text[0]));
    if (startsNew) {
      paras.push({ lines: [g.text], x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, sizes: [g.size], last: g });
    } else {
      target.lines.push(g.text);
      target.x0 = Math.min(target.x0, g.x0);
      target.y0 = Math.min(target.y0, g.y0);
      target.x1 = Math.max(target.x1, g.x1);
      target.y1 = Math.max(target.y1, g.y1);
      target.sizes.push(g.size);
      target.last = g;
    }
  }
  return paras;
}

export function finalizeParagraphs(raw) {
  const out = [];
  for (const p of raw) {
    let text = p.lines.join(" ").split(/\s+/).filter(Boolean).join(" ");
    text = text.replace(BULLET, "");
    text = text.replace(PUA, " ").split(/\s+/).filter(Boolean).join(" ");
    if (text.length < 2 || /^[^\p{L}]+$/u.test(text)) continue;
    if (!worthTranslating(text)) continue;
    out.push({
      text,
      x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1,
      size: p.sizes.reduce((a, b) => a + b, 0) / p.sizes.length,
    });
  }
  out.sort((a, b) => Math.round(a.y0) - Math.round(b.y0) || a.x0 - b.x0);
  return out;
}

export function paragraphsFromItems(items, opts = {}) {
  return finalizeParagraphs(groupSegments(itemsToSegments(items, opts)));
}

// ---------------------------------------------------------------- sentences / translation assembly

export function splitText(text) {
  // "A = B" and "A | B" are translated piece by piece (separators stay at odd positions)
  if (/\d\s*=|=\s*\d/.test(text)) return text.split(SEP_DOT);
  return text.split(SEP_ALL);
}

export function sentencesOf(piece) {
  return piece
    .replace(/([.!?\u061F])\s+/g, "$1\u0001")
    .split("\u0001")
    .map((s) => s.trim())
    .filter(Boolean);
}

// every sentence that really needs the translator
export function sentencesToTranslate(text) {
  const out = [];
  splitText(text).forEach((part, i) => {
    if (i % 2 === 1) return;
    for (const s of sentencesOf(part)) if (HAS_WORDS.test(s)) out.push(s);
  });
  return out;
}

// lookup(sentence) -> Arabic string or null.  Returns Arabic text (parts may stay English) or null.
export function assembleTranslation(text, lookup) {
  if (!HAS_WORDS.test(text)) return text;
  const out = [];
  let ok = 0;
  splitText(text).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(part.trim());
      return;
    }
    const pieces = [];
    let got = 0;
    for (const s of sentencesOf(part)) {
      if (!HAS_WORDS.test(s)) {
        pieces.push(s);
        continue;
      }
      const r = lookup(s);
      if (r) {
        got++;
        pieces.push(r);
      } else {
        pieces.push(s);
      }
    }
    if (got) ok++;
    out.push(pieces.join(" "));
  });
  return ok ? out.join(" ") : null;
}

// ---------------------------------------------------------------- word wrapping

// measure(text) -> width in px.  Returns an array of lines (logical order).
export function wrapText(text, measure, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (!cur || measure(test) <= maxWidth) cur = test;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- pixel analysis: where can we cut the page?

// data: RGBA bytes of the rendered page. A row is a safe place to cut when it has only a few long
// colour runs (plain background / card fill / borders) and looks the same as the rows around it.
export function makeAnalyzer(data, W, H, tol = 24) {
  const state = new Uint8Array(H); // 0 unknown, 1 clean, 2 not clean
  const dist = (i, j) =>
    Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);

  function isCleanRow(y) {
    if (state[y]) return state[y] === 1;
    let transitions = 0;
    const base = y * W * 4;
    for (let x = 1; x < W; x++) {
      const i = base + x * 4;
      if (dist(i, i - 4) > tol) {
        transitions++;
        if (transitions > 6) break;
      }
    }
    state[y] = transitions <= 6 ? 1 : 2;
    return state[y] === 1;
  }

  function similarRows(y1, y2) {
    const limit = Math.floor(W * 0.01);
    let diff = 0;
    const b1 = y1 * W * 4;
    const b2 = y2 * W * 4;
    for (let x = 0; x < W; x++) {
      if (dist(b1 + x * 4, b2 + x * 4) > tol) {
        diff++;
        if (diff > limit) return false;
      }
    }
    return true;
  }

  function findCut(y0, maxY) {
    const hi = Math.min(Math.floor(maxY), H - 4);
    for (let y = Math.max(2, Math.floor(y0)); y <= hi; y++) {
      if (isCleanRow(y) && similarRows(y, y - 2) && similarRows(y, y + 2)) return y;
    }
    return -1;
  }

  return { findCut, isCleanRow };
}

// ---------------------------------------------------------------- planning

// Arabic under each paragraph, inside the page.
// opts: {W,H,S,paras,arabic,analyzer,measureFor,arScale,arMin,arMax}
export function planInline(o) {
  const { W, H, S, paras, arabic, analyzer, measureFor } = o;
  const arScale = o.arScale ?? 0.9;
  const arMin = o.arMin ?? 11;
  const arMax = o.arMax ?? 40;
  const groups = new Map();

  paras.forEach((p, k) => {
    const ar = arabic[k];
    const fontPx = Math.max(arMin, Math.min(arMax, p.size * arScale)) * S;
    const boxW = Math.min(W - 16, Math.max((p.x1 - p.x0) * S, 0.45 * W));
    let x0 = Math.max(8, p.x0 * S);
    let x1 = x0 + boxW;
    if (x1 > W - 8) {
      x1 = W - 8;
      x0 = x1 - boxW;
    }
    const lines = wrapText(ar, measureFor(fontPx), boxW);
    const lineH = fontPx * 1.4;
    const h = Math.ceil(lines.length * lineH + fontPx * 0.6);

    const startY = p.y1 * S + 1;
    let cut = analyzer ? analyzer.findCut(Math.ceil(startY), startY + 0.35 * H) : -1;
    if (cut < 0) cut = Math.round(startY);
    cut = Math.min(H, Math.max(1, cut));

    if (!groups.has(cut)) groups.set(cut, []);
    groups.get(cut).push({ x0, x1, fontPx, lineH, lines, h });
  });

  const cuts = [...groups.keys()].sort((a, b) => a - b).map((y) => {
    const items = groups.get(y);
    return { y, items, gap: items.reduce((s, it) => s + it.h, 0) };
  });
  return { cuts, totalH: H + cuts.reduce((s, c) => s + c.gap, 0) };
}

// All the translation in one block under the page: English line, then its Arabic.
export function planPanel(o) {
  const { W, H, S, paras, arabic, measureFor } = o;
  const arPx = (o.arSize ?? 16) * S;
  const enPx = (o.enSize ?? 11) * S;
  const boxW = W - 40 * S;
  const mAr = measureFor(arPx);
  const mEn = measureFor(enPx);
  let extra = 24 * S;
  const items = paras.map((p, k) => {
    const enLines = wrapText(p.text, mEn, boxW);
    const arLines = wrapText(arabic[k], mAr, boxW);
    const h = Math.ceil(enLines.length * enPx * 1.35 + arLines.length * arPx * 1.4 + 10 * S);
    extra += h;
    return { enLines, arLines, h, enPx, arPx };
  });
  extra = Math.ceil(extra);
  return { items, extra, totalH: H + extra, boxW, margin: 20 * S };
}
