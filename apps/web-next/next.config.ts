import { NextConfig } from "next";

const nextConfig = {
  images: { unoptimized: true },
  ...(process.env.STATIC_EXPORT === "1"
    ? { output: "export" as const, trailingSlash: true }
    : {
        async rewrites() {
          const api = (process.env.EAS_API_ORIGIN || "http://127.0.0.1:8000").replace(/\/+$/, "");
          return [
            { source: "/v1/:path*", destination: `${api}/v1/:path*` },
          ];
        },
      }),
  turbopack: {
    root: __dirname,
  },
} as NextConfig;

export default nextConfig;
