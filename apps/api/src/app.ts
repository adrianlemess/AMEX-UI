import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import { postgresAmexActivity } from './amex/store.js';
import { registerAmexRoutes } from './amex/routes.js';
import { postgresAuthStore } from './auth/store.js';
import { registerAuthRoutes } from './auth/routes.js';
import { deepSeekService } from './ai/deepseek.js';
import { postgresAiUsage } from './ai/usage.js';

export async function createApp(pool: pg.Pool, options: {
  origin: string;
  production: boolean;
  deepSeekKey?: string;
  maxRequestUsdCents: number;
}): Promise<FastifyInstance> {
  const app = fastify({ logger: false, bodyLimit: 1_100_000 });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = await registerAuthRoutes(app, pool, postgresAuthStore(pool), options.origin, options.production);
  registerAmexRoutes(app, postgresAmexActivity(pool), auth,
    options.deepSeekKey ? deepSeekService(options.deepSeekKey, options.maxRequestUsdCents) : undefined,
    postgresAiUsage(pool));
  return app;
}
