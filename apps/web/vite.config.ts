import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { resolve } from 'node:path';

// npm workspaces runs the web scripts from apps/web, regardless of host OS.
const projectRoot = resolve(process.cwd(), '../..');

export default defineConfig(({ mode }) => {
  // Read only the non-secret settings from the root .env. The API uses that same file.
  const { WEB_ORIGIN } = loadEnv(mode, projectRoot, 'WEB_');
  const { API_PORT } = loadEnv(mode, projectRoot, 'API_');
  const origin = new URL(WEB_ORIGIN || 'http://127.0.0.1:5173');
  const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${API_PORT || 3001}` },
    },
    test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
  };
});
