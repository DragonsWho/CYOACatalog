// Глобальная преференция языка игры (мультиязычность, гибрид-модель).
// Базовый слой — localStorage: работает и для анонимов, без изменений схемы.
// См. wiki/components/multilang-variants-spec.md §3.
//
// Резолв языка на странице игры: URL `?lang=` → эта преференция → язык оригинала.
// Пишем сюда ТОЛЬКО по явному клику пользователя в переключателе (приход по чужой
// шаренной ссылке `?lang=ko` показывает корейский, но НЕ перетирает выбор гостя).

const PREF_KEY = 'pref_lang';

export function getPrefLang(): string | null {
  try {
    return localStorage.getItem(PREF_KEY) || null;
  } catch {
    return null; // приватный режим / заблокированный storage
  }
}

export function setPrefLang(lang: string): void {
  try {
    localStorage.setItem(PREF_KEY, lang);
  } catch {
    /* no-op */
  }
}

// Родные названия для пилюль переключателя. Фолбэк — код в верхнем регистре.
const LANG_NAMES: Record<string, string> = {
  en: 'English', ko: '한국어', ja: '日本語', zh: '中文', ru: 'Русский',
  es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português',
  it: 'Italiano', pl: 'Polski', uk: 'Українська', tr: 'Türkçe',
};

export function langLabel(code: string): string {
  return LANG_NAMES[code] || code.toUpperCase();
}
