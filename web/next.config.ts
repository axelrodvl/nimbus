import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    agentFeedback: true,
    inlineCss: true,
    useOffline: true,
  },
  images: {
    // Обложки из Cover Art Archive (редиректит на archive.org).
    remotePatterns: [
      { hostname: 'coverartarchive.org', protocol: 'https' },
      { hostname: '**.archive.org', protocol: 'https' },
    ],
  },
  partialPrefetching: true,
  reactCompiler: true,
  typedRoutes: true,
};

export default nextConfig;
