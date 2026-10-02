import './load-env.js';
import { readConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';

const config = readConfig(process.env);
const pool = createPool(config.DATABASE_URL);
try {
  await pool.query('SELECT version FROM amex_schema_version LIMIT 1');
  const app = await createApp(pool, {
    origin: config.WEB_ORIGIN,
    production: config.NODE_ENV === 'production',
    deepSeekKey: config.DEEPSEEK_API_KEY,
    maxRequestUsdCents: config.AI_MAX_REQUEST_USD_CENTS,
  });
  app.addHook('onClose', async () => { await pool.end(); });
  await app.listen({ host: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port: config.API_PORT });
  console.log(`AMEX API ready on port ${config.API_PORT}`);
} catch (error) {
  await pool.end();
  console.error('AMEX API could not start. Check PostgreSQL, DATABASE_URL and npm run db:migrate.');
  process.exitCode = 1;
}
