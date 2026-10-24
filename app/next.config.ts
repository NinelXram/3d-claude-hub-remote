import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["three"],
  // Opening the dev server as http://127.0.0.1:<port> (the world server prints that form) needs this for hot reload.
  // Also tunnels (VS Code dev tunnels, Codespaces), which reach the dev server through the world server's proxy.
  allowedDevOrigins: ["127.0.0.1", "**.devtunnels.ms", "**.app.github.dev"],
};

export default nextConfig;
