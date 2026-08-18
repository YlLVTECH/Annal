type TranslateParams = Record<string, string | number>;

let currentLocale = (localStorage.getItem("notebook:locale") as string | null) ?? "zh-CN";
let currentMessages: Record<string, string> = {};

async function loadMessages(locale: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`/src/i18n/${locale}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${locale}`);
    const data = (await res.json()) as Record<string, string>;
    return data;
  } catch {
    return {};
  }
}

export async function initI18n() {
  currentMessages = await loadMessages(currentLocale);
  document.documentElement.lang = currentLocale;
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: string, params?: TranslateParams): string {
  let text = currentMessages[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

export async function setLocale(locale: string) {
  if (locale === currentLocale) return;
  currentLocale = locale;
  localStorage.setItem("notebook:locale", locale);
  currentMessages = await loadMessages(locale);
  document.documentElement.lang = locale;
}

export function getAvailableLocales(): Array<{ value: string; label: string }> {
  return [
    { value: "zh-CN", label: "简体中文" },
    { value: "en-US", label: "English" },
  ];
}

export function applyI18nToDocument() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n") || "";
    const argsAttr = el.getAttribute("data-i18n-args");
    const args: TranslateParams = argsAttr ? (JSON.parse(argsAttr) as TranslateParams) : {};
    el.textContent = t(key, args);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title") || "";
    el.title = t(key);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder") || "";
    el.setAttribute("placeholder", t(key));
  });
}

