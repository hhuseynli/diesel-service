import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// The dev-mode badge sits over the tablet screens; nothing in it is needed day to day.
const nextConfig: NextConfig = { devIndicators: false };

export default withNextIntl(nextConfig);
