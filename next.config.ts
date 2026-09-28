import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { NextConfig } from 'next';

// .env.local must win over stale shell placeholders from test builds
function loadLocalEnvOverrides() {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = value;
  }
}
loadLocalEnvOverrides();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // The webpack dev server grew past 6-13 GB: `npm run dev` uses Turbopack, and run_dev.py
  // restarts the server if it still crosses its memory ceiling. These webpack options only
  // matter for `npm run dev:webpack` and production builds.
  // staleTimes: reuse already-visited pages from the client router cache instead of a server
  // round-trip (auth + RSC) on every section switch; page data is fetched client-side anyway.
  experimental: {
    webpackMemoryOptimizations: true,
    staleTimes: { dynamic: 300, static: 600 },
    // Antivirus HTTPS scanning re-signs Google Fonts with a Windows-only root. Accepted by
    // Next's config schema but missing from its TypeScript types.
    ...({ turbopackUseSystemTlsCerts: true } as object),
  },
  // Keep compiled routes: disposing them made every section switch recompile for 6-7 s.
  onDemandEntries: { maxInactiveAge: 60 * 60_000, pagesBufferLength: 10 },
  logging: {
    incomingRequests: { ignore: [/\/login/] },
  },
  async redirects() {
    return [{ source: '/compte/:id', destination: '/ibkr/compte/:id', permanent: true }];
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'react-is': join(process.cwd(), 'node_modules/react-is'),
    };
    return config;
  },
};

export default nextConfig;
