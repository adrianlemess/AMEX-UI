import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { createPool } from './db/pool.js';

const origin = 'http://127.0.0.1:5173';

it.skipIf(!process.env.TEST_DATABASE_URL)('signs up isolated accounts and imports synthetic AMEX data for only its owner', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const app = await createApp(pool, { origin, production: false, maxRequestUsdCents: 10 });
  const credentials = (label: string) => ({ username: `${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`, password: 'synthetic-password-only-12345' });
  const signup = async (account: { username: string; password: string }) => {
    const response = await app.inject({ method: 'POST', url: '/api/signup',
      headers: { origin, 'content-type': 'application/json' }, payload: account });
    expect(response.statusCode).toBe(201);
    return { cookie: String(response.headers['set-cookie']).split(';')[0], csrf: response.json<{ csrfToken: string }>().csrfToken };
  };
  try {
    const ownerCredentials = credentials('owner');
    const owner = await signup(ownerCredentials);
    const friend = await signup(credentials('friend'));
    expect((await app.inject({ url: '/api/session', headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ username: ownerCredentials.username, csrfToken: owner.csrf });
    const duplicate = await app.inject({ method: 'POST', url: '/api/signup',
      headers: { origin, 'content-type': 'application/json' }, payload: ownerCredentials });
    expect(duplicate.statusCode).toBe(409);
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin, 'content-type': 'application/json' }, payload: ownerCredentials });
    expect(login.statusCode).toBe(200);
    const card = await app.inject({ method: 'POST', url: '/api/amex/cards',
      headers: { origin, cookie: owner.cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf },
      payload: { label: 'Primary', last4: '1014' } });
    expect(card.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/amex/cards',
      headers: { origin, cookie: owner.cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf },
      payload: { label: 'Secondary', last4: '2004' } });
    expect(second.statusCode).toBe(201);
    const cardId = card.json<{ id: string }>().id;
    expect((await app.inject({ method: 'PUT', url: `/api/amex/cards/${cardId}`,
      headers: { origin, cookie: friend.cookie, 'content-type': 'application/json', 'x-csrf-token': friend.csrf },
      payload: { label: 'Not mine' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/amex/cards/${cardId}`,
      headers: { origin, cookie: owner.cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf },
      payload: { label: 'My card' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/amex/cards', headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ cards: [{ id: cardId, label: 'My card', last4: '1014' }, { label: 'Secondary', last4: '2004' }] });
    expect((await app.inject({ url: '/api/amex/cards', headers: { cookie: friend.cookie } })).json()).toEqual({ cards: [] });
    const csv = [
      'Datum,Beschreibung,Karteninhaber,Konto #,Betrag,Weitere Details,Erscheint auf Ihrer Abrechnung als,Adresse,Stadt,PLZ,Land,Betreff,Kategorie',
      '08/09/2026,SYNTHETIC BOOKSHOP,Synthetic,-01014,"12,34",,SYNTHETIC BOOKSHOP,,,,DE,synthetic-test-ref,Other',
      '09/09/2026,SYNTHETIC CAFE,Synthetic,-02004,"7,00",,SYNTHETIC CAFE,,,,DE,synthetic-test-ref-two,Other',
    ].join('\n');
    const headers = { origin, cookie: owner.cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf };
    const preview = await app.inject({ method: 'POST', url: '/api/amex/activity/preview', headers, payload: { csv } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ cardLast4s: ['1014', '2004'] });
    const commit = await app.inject({ method: 'POST', url: '/api/amex/activity/commit', headers,
      payload: { csv, hash: preview.json<{ hash: string }>().hash } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ added: 2 });
    expect((await app.inject({ url: '/api/amex/cycles', headers: { cookie: owner.cookie } })).json())
      .toEqual({ cycles: ['2026-09'] });
    expect((await app.inject({ url: '/api/amex/cycles', headers: { cookie: friend.cookie } })).json())
      .toEqual({ cycles: [] });
    const selected = 'from=2026-09-07&through=2026-10-06';
    expect((await app.inject({ url: `/api/amex/transactions?${selected}`, headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ total: 2, totalCents: 1934 });
    expect((await app.inject({ url: `/api/amex/transactions?${selected}&cardLast4=1014`, headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ total: 1, totalCents: 1234 });
    expect((await app.inject({ url: `/api/amex/transactions?${selected}&cardLast4=2004`, headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ total: 1, totalCents: 700 });
    expect((await app.inject({ url: `/api/amex/analytics?${selected}&cardLast4=1014`, headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ totalCents: 1234, transactionCount: 1 });
    expect((await app.inject({ url: `/api/amex/analytics?${selected}&cardLast4=2004`, headers: { cookie: owner.cookie } })).json())
      .toMatchObject({ totalCents: 700, transactionCount: 1 });
    expect((await app.inject({ url: `/api/amex/transactions?${selected}&cardLast4=1014`, headers: { cookie: friend.cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/amex/transactions?${selected}`, headers: { cookie: friend.cookie } })).json())
      .toMatchObject({ total: 0, totalCents: 0 });
    expect((await app.inject({ method: 'POST', url: '/api/amex/merchants/retry-classification',
      headers: { origin, cookie: friend.cookie, 'content-type': 'application/json', 'x-csrf-token': friend.csrf },
      payload: {} })).statusCode).toBe(503);
  } finally { await app.close(); await pool.end(); }
});
