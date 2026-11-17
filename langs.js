// langs.js - the 6 languages and which translation models connect them.
// Every pack (a language other than English) = 2 models: LANG->English and English->LANG.
// Two non-English languages are connected through English (pivot): for example es -> en -> ar.

export const LANGS = {
  ar: { name: "العربية", rtl: true },
  en: { name: "English", rtl: false },
  es: { name: "Español", rtl: false },
  it: { name: "Italiano", rtl: false },
  fr: { name: "Français", rtl: false },
  de: { name: "Deutsch", rtl: false },
};
export const LANG_ORDER = ["ar", "en", "es", "it", "fr", "de"];

export function modelFor(src, tgt) {
  return `Xenova/opus-mt-${src}-${tgt}`;
}

// the model steps needed to go from src to tgt
export function stepsFor(src, tgt) {
  if (src === tgt) return [];
  if (src === "en" || tgt === "en") return [[src, tgt]];
  return [
    [src, "en"],
    ["en", tgt],
  ];
}

// the two models of one language pack
export function pairsForPack(code) {
  return code === "en" ? [] : [[code, "en"], ["en", code]];
}

// the language packs a translation needs (English never needs a pack)
export function packsNeeded(src, tgt) {
  const set = new Set();
  for (const [a, b] of stepsFor(src, tgt)) {
    if (a !== "en") set.add(a);
    if (b !== "en") set.add(b);
  }
  return [...set];
}

// Helsinki en-ar is a multi-target model and needs the target tag; the other models do not
export function prefixFor(src, tgt) {
  return src === "en" && tgt === "ar" ? ">>ara<< " : "";
}
