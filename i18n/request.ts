import { getRequestConfig } from "next-intl/server";

// One locale for now (spec 00, section 2). Russian is added as another
// messages file, without code changes in components.
export default getRequestConfig(async () => {
  const locale = "az";
  return {
    locale,
    timeZone: "Asia/Baku",
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
