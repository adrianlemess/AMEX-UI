import type pg from 'pg';

export interface Account {
  id: string;
  householdId: string;
  username: string;
  passwordHash: string;
}

export interface SessionRecord {
  userId: string;
  householdId: string;
  username: string;
  csrfHash: string;
}

export interface AuthStore {
  findByUsername(username: string): Promise<Account | null>;
  saveSession(tokenHash: string, userId: string, csrfHash: string, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string, userId: string): Promise<void>;
}

export function postgresAuthStore(pool: pg.Pool): AuthStore {
  return {
    async findByUsername(username) {
      const { rows } = await pool.query<{
        id: string;
        household_id: string;
        username: string;
        password_hash: string;
      }>('SELECT id, household_id, username, password_hash FROM users WHERE username = $1', [username]);
      const user = rows[0];
      return user
        ? { id: user.id, householdId: user.household_id, username: user.username, passwordHash: user.password_hash }
        : null;
    },
    async saveSession(tokenHash, userId, csrfHash, expiresAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM sessions WHERE expires_at <= now()');
        await client.query(
          'INSERT INTO sessions(token_hash, user_id, csrf_hash, expires_at) VALUES ($1, $2, $3, $4)',
          [tokenHash, userId, csrfHash, expiresAt],
        );
        await client.query("INSERT INTO auth_events(user_id, event_type) VALUES ($1, 'login')", [userId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async findSession(tokenHash) {
      const { rows } = await pool.query<{
        user_id: string;
        household_id: string;
        username: string;
        csrf_hash: string;
      }>(
        `SELECT s.user_id, u.household_id, u.username, s.csrf_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash],
      );
      const row = rows[0];
      return row
        ? { userId: row.user_id, householdId: row.household_id, username: row.username, csrfHash: row.csrf_hash }
        : null;
    },
    async deleteSession(tokenHash, userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM sessions WHERE token_hash = $1 AND user_id = $2', [
          tokenHash,
          userId,
        ]);
        await client.query("INSERT INTO auth_events(user_id, event_type) VALUES ($1, 'logout')", [userId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
