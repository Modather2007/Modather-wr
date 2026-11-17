// worker.js - runs the translation models inside the browser (no server needed).
// Models are downloaded once and kept in the browser cache, so they work offline afterwards.
// Any pair goes through English: fr -> en -> it. Models used: Xenova/opus-mt-{from}-{to}
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

env.allowLocalModels = false;
env.useBrowserCache = true;

const HAS_AR = /[\u0600-\u06FF]/;
const loaded = new Map(); // "en-ar" -> Promise<translator>  (small LRU, newest last)

const post = (msg) => self.postMessage(msg);

// tries the usual quantized model first, then a lighter mirror, then the full-precision one
async function buildTranslator(key) {
  const progress_callback = (x) => post({ type: "progress", p: x });
  const tries = [
    ["Xenova/opus-mt-" + key, { dtype: "q8" }],
    ["OptimaMT/" + key, { dtype: "q8", session_options: { extra: { session: { disable_quant_qdq: "1" } } } }],
    ["Xenova/opus-mt-" + key, { dtype: "fp32" }],
  ];
  let last = null;
  for (const [id, opts] of tries) {
    try {
      return await pipeline("translation", id, { ...opts, progress_callback });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(key + ": " + String((last && last.message) || last));
}

function load(a, b) {
  const key = a + "-" + b;
  if (loaded.has(key)) {
    const p = loaded.get(key);
    loaded.delete(key);
    loaded.set(key, p); // refresh position
    return p;
  }
  const p = buildTranslator(key).catch((err) => {
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

function route(src, tgt) {
  if (src === tgt) return [];
  if (src === "en") return [["en", tgt]];
  if (tgt === "en") return [[src, "en"]];
  return [[src, "en"], ["en", tgt]];
}

async function runStep(a, b, text) {
  const t = await load(a, b);
  const input = a === "en" && b === "ar" ? ">>ara<< " + text : text;
  const r = await t(input, { max_new_tokens: 256 });
  const s = ((r && r[0] && r[0].translation_text) || "").replace(/^\s*>>ara<<\s*/, "").trim();
  if (!s) return null;
  if (b === "ar" && !HAS_AR.test(s)) return null;
  return s;
}

// ---- speech: one small VITS voice model per language (downloaded once, then cached for offline use)
const TTS_ISO = { ar: "ara", en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita" };
const voices = new Map(); // lang -> Promise<synthesizer>

function loadVoice(lang) {
  if (!TTS_ISO[lang]) return Promise.reject(new Error("لغة غير مدعومة للنطق"));
  if (!voices.has(lang)) {
    const p = pipeline("text-to-speech", "Xenova/mms-tts-" + TTS_ISO[lang], {
      dtype: "q8",
      progress_callback: (x) => post({ type: "progress", p: x }),
    }).catch((err) => {
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
    await load(msg.pair[0], msg.pair[1]);
    post({ type: "ready", id: msg.id });
    return;
  }
  if (msg.type === "translate") {
    const steps = route(msg.src, msg.tgt);
    const out = [];
    for (let i = 0; i < msg.texts.length; i++) {
      let cur = msg.texts[i];
      try {
        for (const [a, b] of steps) {
          cur = await runStep(a, b, cur);
          if (!cur) break;
        }
      } catch (err) {
        if (!loaded.size) throw err;
        cur = null;
      }
      out.push(steps.length ? cur : msg.texts[i]);
      if (i % 3 === 2) post({ type: "tick", id: msg.id, done: i + 1, total: msg.texts.length });
    }
    post({ type: "result", id: msg.id, out });
  }
}
