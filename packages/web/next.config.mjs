/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Next's standalone trace copies only the CJS half of @swc/helpers under pnpm, while its own
  // `require-hook` loads `@swc/helpers/esm/_interop_require_default.js` at runtime — so the
  // production image starts, fails MODULE_NOT_FOUND and crash-loops. MEASURED in the published
  // v0.1.0 web image: the package was present with `cjs/` and `package.json` and no `esm/`.
  // Never caught before because nothing ran the production stage: compose-boot builds
  // `target: deps` and the dev stack bind-mounts the full node_modules.
  outputFileTracingIncludes: {
    '/**': ['../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**'],
  },
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  },
};

export default nextConfig;
