import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { amexCategoryDefaults } from '../amex/classification.js';
import { equalHash, hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';
import type { AuthStore, SessionRecord } from './store.js';

const sessionSeconds = 7 * 24 * 60 * 60;
const credentials = z.object({ username: z.string().regex(/^[a-z][a-z0-9_]{2,29}$/), password: z.string().min(12).max(256) }).strict();
export type SessionAccessor = {
  requireSession(request: FastifyRequest, reply: FastifyReply): Promise<{ record: SessionRecord; tokenHash: string } | null>;
};

export async function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool, store: AuthStore, origin: string, production: boolean): Promise<SessionAccessor> {
  const cookieName = production ? '__Host-amex' : 'amex_session';
  const dummyHash = await hashPassword('not-a-real-user-password');
  const localAlias = !production && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)
    ? origin.replace(/^(http:\/\/)(127\.0\.0\.1|localhost)(:\d+)$/, (_whole, scheme: string, host: string, port: string) =>
        `${scheme}${host === 'localhost' ? '127.0.0.1' : 'localhost'}${port}`)
    : null;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (request.headers.origin !== origin && request.headers.origin !== localAlias)
      return reply.code(403).send({ error: 'forbidden' });
    if (request.method !== 'DELETE' && request.url !== '/api/logout' &&
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return reply.code(415).send({ error: 'unsupported_media_type' });
  });

  async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    const tokenHash = hashToken(token);
    const record = await store.findSession(tokenHash);
    if (!record) {
      reply.clearCookie(cookieName, { path: '/' });
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    return { record, tokenHash };
  }
  async function issueSession(reply: FastifyReply, user: { id: string; username: string }) {
    const token = newToken();
    const csrfToken = hashToken(`csrf:${token}`);
    await store.saveSession(hashToken(token), user.id, hashToken(csrfToken), new Date(Date.now() + sessionSeconds * 1000));
    reply.setCookie(cookieName, token, {
      path: '/', httpOnly: true, secure: production, sameSite: 'strict', maxAge: sessionSeconds,
    });
    return { username: user.username, csrfToken };
  }

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' });
    const username = parsed.data.username;
    const passwordHash = await hashPassword(parsed.data.password);
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      const household = await client.query<{ id: string }>('INSERT INTO households DEFAULT VALUES RETURNING id');
      const householdId = household.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        'INSERT INTO users(household_id,username,password_hash) VALUES($1,$2,$3) RETURNING id',
        [householdId, username, passwordHash],
      );
      userId = user.rows[0]!.id;
      for (const name of amexCategoryDefaults)
        await client.query('INSERT INTO amex_spending_categories(household_id,name,source) VALUES($1,$2,\'user\')', [householdId, name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        return reply.code(409).send({ error: 'username_already_registered' });
      throw error;
    } finally { client.release(); }
    return reply.code(201).send(await issueSession(reply, { id: userId, username }));
  });
  app.post('/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' });
    const user = await store.findByUsername(parsed.data.username);
    const valid = await verifyPassword(user?.passwordHash ?? dummyHash, parsed.data.password);
    if (!user || !valid) return reply.code(401).send({ error: 'invalid_credentials' });
    return issueSession(reply, user);
  });
  app.get('/api/session', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return { username: session.record.username, csrfToken: hashToken(`csrf:${request.cookies[cookieName]!}`) };
  });
  app.post('/api/logout', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const submitted = request.headers['x-csrf-token'];
    if (typeof submitted !== 'string' || !equalHash(hashToken(submitted), session.record.csrfHash))
      return reply.code(403).send({ error: 'forbidden' });
    await store.deleteSession(session.tokenHash, session.record.userId);
    reply.clearCookie(cookieName, { path: '/' });
    return reply.code(204).send();
  });
  return { requireSession };
}
