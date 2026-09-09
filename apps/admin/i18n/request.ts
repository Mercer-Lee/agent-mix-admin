import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, LOCALE_COOKIE, locales, type AppLocale } from "./config";

async function loadMessages(locale: AppLocale) {
  const [common, agents, models, audit, chat] = await Promise.all([
    import(`../messages/${locale}/common.json`),
    import(`../messages/${locale}/agents.json`),
    import(`../messages/${locale}/models.json`),
    import(`../messages/${locale}/audit.json`),
    import(`../messages/${locale}/chat.json`),
  ]);
  return {
    ...common.default,
    agents: agents.default,
    models: models.default,
    audit: audit.default,
    chat: chat.default,
  };
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get(LOCALE_COOKIE)?.value;
  const locale = locales.includes(requested as AppLocale) ? (requested as AppLocale) : defaultLocale;

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
