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
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'react-is': join(process.cwd(), 'node_modules/react-is'),
    };
    return config;
  },
};

export default nextConfig;
