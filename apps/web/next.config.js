/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,

  // Docker / deploy esetén kényelmes (kisebb image, egyszerűbb futtatás)
  output: "standalone",

  // Monorepo/workspace csomagok (pl. @careloop/shared) transpile
  transpilePackages: ["@careloop/shared"],

  // Ha később külső képeket használsz (pl. Azure Blob), add hozzá a domain-t.
  images: {
    remotePatterns: [
      // példa: https://<account>.blob.core.windows.net/...
      // { protocol: "https", hostname: "**.blob.core.windows.net" }
    ],
  },

  // Build során NE nyeljük el a hibákat (hackathonon is megéri)
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },

  // Egységes API útvonal: a frontend /api/* hívásait proxyzza a backend felé.
  // Lokálban pl. API_PROXY_TARGET="http://localhost:4000"
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    if (!target) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${target.replace(/\/$/, "")}/:path*`,
      },
    ];
  },

  // Security headerek (jó benyomás a zsűrinek + best practice)
  async headers() {
    const isProd = process.env.NODE_ENV === "production";

    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value:
          "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      // HSTS csak prodon (különben localhoston szívás)
      ...(isProd
        ? [
            {
              key: "Strict-Transport-Security",
              value: "max-age=31536000; includeSubDomains; preload",
            },
          ]
        : []),
    ];

    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
