import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const serverUrl = process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101";
    return [{ source: "/api/:path*", destination: `${serverUrl}/api/:path*` }];
  },
};

export default nextConfig;
