import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  experimental: {
    serverActions: {
      allowedOrigins: [
        'staging-billchaser.motts.com.au',
        'billchaser.motts.com.au'
      ]
    }
  },
  webpack(config: {
    resolve: { extensionAlias?: Record<string, string[]> };
  }) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs']
    };
    return config;
  }
};

export default nextConfig;
