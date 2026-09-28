import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.BRICKHOUSE_SELF_HOST === "1" ? "standalone" : undefined,
};

export default nextConfig;
