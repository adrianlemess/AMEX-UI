import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.url(),
  WEB_ORIGIN: z.url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEEPSEEK_API_KEY: z.string().min(20).optional(),
  AI_MAX_REQUEST_USD_CENTS: z.coerce.number().int().min(1).max(100).default(10),
});
export function readConfig(env: NodeJS.ProcessEnv) {
  const value = configSchema.parse(env);
  if (value.NODE_ENV === 'production' && !value.WEB_ORIGIN.startsWith('https://'))
    throw new Error('Production WEB_ORIGIN must use HTTPS');
  return value;
}
