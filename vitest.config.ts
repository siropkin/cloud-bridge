import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // These override .dev.vars (a test asserts it): fake secrets and a short arm timeout.
        bindings: {
          GITHUB_CLIENT_ID: 'test-client-id',
          GITHUB_CLIENT_SECRET: 'test-client-secret',
          COOKIE_ENCRYPTION_KEY: 'test-cookie-key-0123456789abcdef0123456789abcdef',
          ARM_CALL_TIMEOUT_MS: '500',
          MCP_RESOURCE: 'http://localhost:8787/mcp',
        },
      },
    }),
  ],
});
