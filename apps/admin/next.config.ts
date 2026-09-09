import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const serverUrl = process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101";
    return [{ source: "/api/:path*", destination: `${serverUrl}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
