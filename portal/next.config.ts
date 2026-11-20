import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The default package contracts are read from portal/contracts at runtime.
  outputFileTracingIncludes: { "/**": ["./contracts/**"] },
};
export default nextConfig;
