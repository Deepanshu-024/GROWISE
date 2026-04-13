import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: false,
  serverExternalPackages: ['web-tree-sitter', 'tree-sitter-wasms'],
};

export default nextConfig;
