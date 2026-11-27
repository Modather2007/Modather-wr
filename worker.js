// worker.js - runs the translation models inside the browser (no server needed).
// Models are downloaded once and kept in the browser cache, so they work offline afterwards.
// Two engines:
//   "fast" = Helsinki opus-mt pairs (small, ~150 MB per direction). Any pair goes through English.
//   "best" = NLLB-200 distilled 600M (one big model, direct between all 6 languages, better quality).
// v20: sentences are translated in BATCHES (3-5x faster) and the output length is capped per input
//      (a short sentence can no longer run on for 256 tokens).
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

env.allowLocalModels = false;
env.useBrowserCache = true;
// several CPU threads when the page is cross-origin isolated (the service worker turns that on); otherwise 1
try {
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency) || 2)) : 1;
} catch (e) {}

const HAS_AR = /[\u0600-\u06FF]/;
// model files: the official host first (so files already cached keep working offline), a mirror second
const HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];
async function withHosts(fn) {
  let last = null;
  for (const h of HOSTS) {
    env.remoteHost = h;
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  env.remoteHost = HOSTS[0];
  throw last;
}
const loaded = new Map(); // "en-ar" -> Promise<translator>  (small LRU, newest last)
const post = (msg) => self.postMessage(msg);

const NLLB_ID = "Xenova/nllb-200-distilled-600M";
const NLLB = { ar: "arb_Arab", en: "eng_Latn", es: "spa_Latn", it: "ita_Latn", fr: "fra_Latn", de: "deu_Latn" };

// tries the usual quantized model first, then a lighter mirror, then the full-precision one
async function buildTranslator(key) {
  const progress_callback = (x) => post({ type: "progress", p: x });
  const tries = [
    ["Xenova/opus-mt-" + key, { dtype: "q8" }],
    ["OptimaMT/" + key, { dtype: "q8", session_options: { extra: { session: { disable_quant_qdq: "1" } } } }],
    ["Xenova/opus-mt-" + key, { dtype: "fp32" }],
  ];
  let last = null;
  const got = await withHosts(async () => {
    for (const [id, opts] of tries) {
      try {
        return await pipeline("translation", id, { ...opts, progress_callback });
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }).catch(() => null);
  if (got) return got;
  throw new Error(key + ": " + String((last && last.message) || last));
}

function remember(key, build) {
  if (loaded.has(key)) {
    const p = loaded.get(key);
    loaded.delete(key);
    loaded.set(key, p); // refresh position
    return p;
  }
  const p = build().catch((err) => {
    loaded.delete(key);
    throw err;
  });
  loaded.set(key, p);
  while (loaded.size > 3) {
    const oldest = loaded.keys().next().value;
    const op = loaded.get(oldest);
    loaded.delete(oldest);
    op.then((t) => t.dispose && t.dispose()).catch(() => {});
  }
  return p;
}

const load = (a, b) => remember(a + "-" + b, () => buildTranslator(a + "-" + b));
const loadBest = () =>
  remember("nllb", () =>
    withHosts(() => pipeline("translation", NLLB_ID, { dtype: "q8", progress_callback: (x) => post({ type: "progress", p: x }) }))
  );

function route(src, tgt) {
  if (src === tgt) return [];
  if (src === "en") return [["en", tgt]];
  if (tgt === "en") return [[src, "en"]];
  return [[src, "en"], ["en", tgt]];
}

// ---- batching: sort by length so a batch has similar sentences, cap the output length by the input length
const MAX_BATCH = 8;
const MAX_CHARS = 1400;
function makeBatches(texts) {
  const idx = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const i of idx) {
    const n = texts[i].length;
    if (cur.length && (cur.length >= MAX_BATCH || chars + n > MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
const capFor = (texts) => Math.min(400, Math.ceil(Math.max(...texts.map((t) => t.length)) / 2) + 24);

function clean(r, tgt) {
  const s = ((r && r.translation_text) || "").replace(/^\s*>>ara<<\s*/, "").trim();
  if (!s) return null;
  if (tgt === "ar" && !HAS_AR.test(s)) return null;
  return s;
}

// texts -> array of translations (null where a sentence failed)
async function runBatches(translator, texts, tgt, extra, onTick) {
  const beams = texts.length <= 3 ? 4 : 2;
  const out = new Array(texts.length).fill(null);
  let done = 0;
  for (const group of makeBatches(texts)) {
    const inputs = group.map((i) => texts[i]);
    // a few words typed by hand: wider search (more accurate, still instant); whole files: 2 beams (fast)
    const opts = { max_new_tokens: capFor(inputs), num_beams: beams, ...extra };
    let res = null;
    try {
      res = await translator(inputs, opts);
    } catch (err) {
      res = null;
    }
    if (res && res.length === group.length) {
      group.forEach((i, k) => (out[i] = clean(res[k], tgt)));
    } else {
      // the batch failed (memory?): do the sentences one by one so nothing is lost
      for (const i of group) {
        try {
          const r = await translator(texts[i], { ...opts, max_new_tokens: capFor([texts[i]]) });
          out[i] = clean(r && r[0], tgt);
        } catch (err) {
          out[i] = null;
        }
      }
    }
    done += group.length;
    onTick && onTick(done);
  }
  return out;
}

async function translateAll(msg) {
  const texts = msg.texts;
  const tick = (d, scale = 1, base = 0) => post({ type: "tick", id: msg.id, done: Math.round(base + d * scale), total: texts.length });
  if (msg.src === msg.tgt) return texts.slice();

  if (msg.engine === "best") {
    const t = await loadBest();
    return runBatches(t, texts, msg.tgt, { src_lang: NLLB[msg.src], tgt_lang: NLLB[msg.tgt] }, (d) => tick(d));
  }

  const steps = route(msg.src, msg.tgt);
  let cur = texts.slice();
  let alive = cur.map((_, i) => i); // sentences still in play (a failed one drops out)
  const res = new Array(texts.length).fill(null);
  for (let s = 0; s < steps.length; s++) {
    const [a, b] = steps[s];
    const t = await load(a, b);
    const inp = alive.map((i) => (a === "en" && b === "ar" ? ">>ara<< " + cur[i] : cur[i]));
    const last = s === steps.length - 1;
    const out = await runBatches(t, inp, b, {}, (d) => tick(d, last ? 1 : 0.5, last && steps.length > 1 ? texts.length * 0.5 : 0));
    const next = [];
    alive.forEach((i, k) => {
      if (out[k]) {
        cur[i] = out[k];
        next.push(i);
      }
    });
    alive = next;
  }
  for (const i of alive) res[i] = cur[i];
  return res;
}

// ---- speech: one small VITS voice model per language (downloaded once, then cached for offline use)
const TTS_ISO = { ar: "ara", en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita" };
const voices = new Map(); // lang -> Promise<synthesizer>

function loadVoice(lang) {
  if (!TTS_ISO[lang]) return Promise.reject(new Error("لغة غير مدعومة للنطق"));
  if (!voices.has(lang)) {
    const p = withHosts(() => pipeline("text-to-speech", "Xenova/mms-tts-" + TTS_ISO[lang], {
      dtype: "q8",
      progress_callback: (x) => post({ type: "progress", p: x }),
    })).catch((err) => {
      voices.delete(lang);
      throw err;
    });
    voices.set(lang, p);
  }
  return voices.get(lang);
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  queue = queue
    .then(() => handle(msg))
    .catch((err) => post({ type: "error", id: msg.id, error: String((err && err.message) || err) }));
};

async function handle(msg) {
  if (msg.type === "tts-init") {
    await loadVoice(msg.lang);
    post({ type: "ready", id: msg.id });
    return;
  }
  if (msg.type === "tts") {
    const synth = await loadVoice(msg.lang);
    const text = msg.lang === "ar" ? msg.text : msg.text.toLowerCase();
    const r = await synth(text);
    const audio = r.audio;
    self.postMessage({ type: "result", id: msg.id, out: { audio, rate: r.sampling_rate } }, [audio.buffer]);
    return;
  }
  if (msg.type === "init") {
    if (msg.engine === "best") await loadBest();
    else await load(msg.pair[0], msg.pair[1]);
    post({ type: "ready", id: msg.id });
    return;
  }
  if (msg.type === "translate") {
    const out = await translateAll(msg);
    post({ type: "result", id: msg.id, out });
  }
}
