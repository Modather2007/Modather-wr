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

// equations, formulas and OCR noise are not sentences: translating them only produces garbage
export function isMathy(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  const alpha = text.replace(/[^\p{L}]/gu, "").length;
  const sym = (text.match(/[=+\-\u2212\u00D7\u00F7^\/<>\u2264\u2265\u2248\u2211\u222B\u221A\u03C0\u2192\u21D2\u2194()\[\]{}|0-9]/g) || []).length;
  const words = toks.filter((t) => /^[("'\u201C]?\p{L}{3,}[.,:;!?)"'\u201D]*$/u.test(t)).length;
  if (words === 0) return true;
  if (words < 3 && sym > alpha * 0.6) return true;
  return false;
}

export function worthTranslating(text) {
  if (isMathy(text)) return false;
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
    text = stripJunk(text.replace(PUA, " "));
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
    // the outer 7% on each side is ignored: page frames and borders (even double ones) must not hide a clean row
    const xa = Math.max(1, Math.floor(W * 0.07));
    const xb = Math.floor(W * 0.93);
    for (let x = xa; x < xb; x++) {
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
    const mf = measureFor(fontPx);
    const lines = wrapText(ar, mf, boxW);
    // the box is only as wide as the text needs (or as the English line above), so neighbours can sit side by side
    const used = Math.max(...lines.map((s) => mf(s)), 0);
    const finalW = Math.min(boxW, Math.max(used + 4, (p.x1 - p.x0) * S));
    let x0 = Math.max(8, p.x0 * S);
    let x1 = x0 + finalW;
    if (x1 > W - 8) {
      x1 = W - 8;
      x0 = x1 - finalW;
    }
    const lineH = fontPx * 1.4;
    const h = Math.ceil(lines.length * lineH + fontPx * 0.6);

    // like Modather.py: cut right under the paragraph. Pictures and formula blocks that cross the cut push it below them
    // (a formula next to the text is never cut in half); other text lines that would be sliced push it a little.
    const orig = Math.round(p.y1 * S + 1);
    const push = (c, list) => {
      for (let rounds = 0, moved = true; moved && rounds < 300; rounds++) {
        moved = false;
        for (const r of list) {
          if (r.y0 < c - 2 && r.y1 > c + 2) {
            c = Math.ceil(r.y1 + 1);
            moved = true;
          }
        }
      }
      return c;
    };
    let cut = push(orig, o.obstacles || []);
    if (cut - orig > 0.35 * H) cut = orig;
    const soft = push(cut, o.softObstacles || []);
    if (soft - cut <= 2.5 * p.size * S) cut = soft;
    if (analyzer) {
      // then the nearest row with nothing on it (frames and borders are ignored by the analyzer)
      const win = Math.min(0.2 * H, Math.max(40, 6 * p.size * S));
      const c = analyzer.findCut(cut, cut + win);
      if (c >= 0) cut = c;
    }
    cut = Math.min(H, Math.max(1, cut));

    if (!groups.has(cut)) groups.set(cut, []);
    groups.get(cut).push({ x0, x1, fontPx, lineH, lines, h });
  });

  // inside one gap, translations that sit side by side (a) | b) ) stay side by side; the ones that overlap stack
  const cuts = [...groups.keys()].sort((a, b) => a - b).map((y) => {
    const items = groups.get(y).sort((a, b) => a.x0 - b.x0);
    const placed = [];
    for (const it of items) {
      let dy = 0;
      for (const q of placed) if (it.x0 < q.x1 - 2 && it.x1 > q.x0 + 2) dy = Math.max(dy, q.dy + q.h);
      it.dy = dy;
      placed.push(it);
    }
    return { y, items, gap: Math.max(...items.map((it) => it.dy + it.h)) };
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

// The 1-pixel row that is stretched into the new gap. Marks that exist only on this row (tops of tall letters, bits of
// formulas) become background; long vertical lines (page frame, card edges: also present in the rows `up` / `down`) stay.
// row/up/down: RGBA bytes of one pixel row each. Returns RGBA bytes.
export function cleanRowData(row, up, down, W) {
  const dist = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  const votes = new Map();
  for (let x = 0; x < W; x += 3) {
    const k = (row[x * 4] >> 4) + "," + (row[x * 4 + 1] >> 4) + "," + (row[x * 4 + 2] >> 4);
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  let best = "15,15,15";
  let n = 0;
  for (const [k, v] of votes) if (v > n) ((best = k), (n = v));
  const bg = best.split(",").map((v) => (+v << 4) + 8);
  const out = new Uint8ClampedArray(W * 4);
  for (let x = 0; x < W; x++) {
    const i = x * 4;
    const isBg = Math.abs(row[i] - bg[0]) + Math.abs(row[i + 1] - bg[1]) + Math.abs(row[i + 2] - bg[2]) <= 40;
    const keep = isBg || dist(row, up, i) <= 40 || dist(row, down, i) <= 40;
    out[i] = keep ? row[i] : bg[0];
    out[i + 1] = keep ? row[i + 1] : bg[1];
    out[i + 2] = keep ? row[i + 2] : bg[2];
    out[i + 3] = 255;
  }
  return out;
}

// Boxes (in points, y from the top) of the pictures a pdf.js page draws. `ops` = {fn, args} from page.getOperatorList(),
// OPS = pdfjs.OPS, toView(x, y) = viewport conversion. Tiny pictures and page-size backgrounds are ignored.
export function imageBoxes(fn, args, OPS, toView, pageW, pageH) {
  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter((v) => v !== undefined));
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i];
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.transform) ctm = mul(args[i], ctm);
    else if (f === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[i] && args[i][0]) ctm = mul(args[i][0], ctm);
    } else if (f === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (IMG.has(f)) {
      const xs = [];
      const ys = [];
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [px, py] = toView(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]);
        xs.push(px);
        ys.push(py);
      }
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      if (w < 6 || h < 6) continue; // dots, thin lines
      if (h >= 0.7 * pageH || w * h >= 0.7 * pageW * pageH) continue; // page background / scan
      out.push(r);
    }
  }
  return out;
}

// stray symbols from formulas (braces, brackets) must not reach the translator
export function stripJunk(text) {
  return text
    .split(/\s+/)
    .filter((t) => t && !/[{}\[\]|~\\]/.test(t) && (/[\p{L}\p{N}]/u.test(t) || /^[.,;:!?()'"\u2019\u201C\u201D=+\-\u2212\u2013\u2014\u00D7\u00F7<>\/*%]+$/.test(t)))
    .join(" ");
}

// Obstacles built from the text of the page (points, y from the top):
//  hard = blocks of formulas (a system of equations is several lines, but it is ONE thing): never cut inside them
//  soft = every text segment: avoid slicing a line in half
export function obstaclesFromSegments(segs) {
  const soft = segs.map((g) => ({ y0: g.y0, y1: g.y1 }));
  const isMath = (g) => isMathy(g.text);
  const prose = segs.filter((g) => !isMath(g));
  const math = segs.filter(isMath).sort((a, b) => a.y0 - b.y0);
  const xOver = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const hard = [];
  let cur = null;
  for (const g of math) {
    let join = false;
    if (cur) {
      const gap = g.y0 - cur.y1;
      const sz = Math.max(g.size, cur.size);
      if (gap <= 0.9 * sz) join = true;
      else if (gap <= 4.5 * sz && xOver(cur, g) > 0.3 * Math.min(cur.x1 - cur.x0, g.x1 - g.x0)) {
        // a system of equations can have empty rows inside; it stays one block unless real text stands between its lines
        const lo = Math.min(cur.x0, g.x0);
        const hi = Math.max(cur.x1, g.x1);
        join = !prose.some((p) => p.y0 < g.y0 && p.y1 > cur.y1 && Math.min(p.x1, hi) - Math.max(p.x0, lo) > 0);
      }
    }
    if (join) {
      cur.y1 = Math.max(cur.y1, g.y1);
      cur.x0 = Math.min(cur.x0, g.x0);
      cur.x1 = Math.max(cur.x1, g.x1);
      cur.size = Math.max(cur.size, g.size);
      cur.n++;
    } else {
      if (cur) hard.push(cur);
      cur = { y0: g.y0, y1: g.y1, x0: g.x0, x1: g.x1, size: g.size, n: 1 };
    }
  }
  if (cur) hard.push(cur);
  return { hard: hard.filter((r) => r.n >= 2), soft };
}

// How much "ink" on the page is NOT under any text of the text layer (a picture with writing inside, a pasted slide...).
// data: RGBA of the rendered page, rects: [{x0,y0,x1,y1}] in pixels. Returns a ratio of the page area (page frames ignored).
export function uncoveredInk(data, W, H, rects, pad = 3) {
  const cov = new Uint8Array(W * H);
  for (const r of rects) {
    const xa = Math.max(0, Math.floor(r.x0 - pad));
    const xb = Math.min(W - 1, Math.ceil(r.x1 + pad));
    const ya = Math.max(0, Math.floor(r.y0 - pad));
    const yb = Math.min(H - 1, Math.ceil(r.y1 + pad));
    for (let y = ya; y <= yb; y++) cov.fill(1, y * W + xa, y * W + xb + 1);
  }
  const xa = Math.floor(W * 0.07);
  const xb = Math.floor(W * 0.93);
  let ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = xa; x < xb; x++) {
      const i = y * W + x;
      if (cov[i]) continue;
      const p = i * 4;
      if (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 < 140) ink++;
    }
  }
  return ink / (W * H * 0.86);
}
