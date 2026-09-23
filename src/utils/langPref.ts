// Global game-language preference (hybrid multilang). localStorage only: works for anons, no schema
// change. See wiki/components/multilang-variants-spec.md §3. Resolution on game page: URL `?lang=`
// → this pref → original language. Written ONLY on explicit switcher click (arriving via a shared
// `?lang=ko` link shows Korean but does NOT overwrite the visitor's choice).

const PREF_KEY = 'pref_lang';

export function getPrefLang(): string | null {
  try {
    return localStorage.getItem(PREF_KEY) || null;
  } catch {
    return null;  // private mode / blocked storage
  }
}

export function setPrefLang(lang: string): void {
  try {
    localStorage.setItem(PREF_KEY, lang);
  } catch {
  }
}

// Native names for switcher pills; fallback = uppercase code.
const LANG_NAMES: Record<string, string> = {
  en: 'English', ko: '한국어', ja: '日本語', zh: '中文', ru: 'Русский',
  es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português',
  it: 'Italiano', pl: 'Polski', uk: 'Українська', tr: 'Türkçe',
};

export function langLabel(code: string): string {
  return LANG_NAMES[code] || code.toUpperCase();
}
