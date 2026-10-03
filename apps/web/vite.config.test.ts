import { afterEach, expect, it, vi } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import config from './vite.config';

afterEach(() => vi.unstubAllEnvs());

it('uses the root environment for both the web port and API proxy on any OS', () => {
  vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1:5174');
  vi.stubEnv('API_PORT', '3002');
  const resolve = config as (env: ConfigEnv) => UserConfig;
  const settings = resolve({ command: 'serve', mode: 'development', isPreview: false, isSsrBuild: false });
  expect(settings.server?.port).toBe(5174);
  expect(settings.server?.proxy?.['/api']).toBe('http://127.0.0.1:3002');
  expect(settings.server?.strictPort).toBe(true);
});
