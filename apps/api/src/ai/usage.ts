import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Durable AMEX-only attempt log. No prompt, label or provider response is stored. */
export function postgresAiUsage(pool: pg.Pool) {
  return {
    async beginAmexAnalysis(householdId: string, _month: string): Promise<string | null> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        if (!owner.rowCount) throw new Error('unknown_household');
        const active = await client.query(
          `SELECT 1 FROM amex_ai_attempts WHERE household_id=$1 AND status='started'
           AND started_at > now() - interval '90 seconds' LIMIT 1`, [householdId],
        );
        const purpose = active.rowCount ? null : randomUUID();
        if (purpose) await client.query('INSERT INTO amex_ai_attempts(household_id,purpose) VALUES($1,$2)', [householdId, purpose]);
        await client.query('COMMIT');
        return purpose;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async amexAnalysisStatus(householdId: string) {
      const last = await pool.query<{ status: string; response: unknown | null; startedAt: Date }>(
        `SELECT status,response,started_at AS "startedAt" FROM amex_ai_attempts
         WHERE household_id=$1 ORDER BY started_at DESC LIMIT 1`, [householdId],
      );
      return { lastAttempt: last.rows[0] ?? null };
    },
    async failAmexAnalysis(householdId: string, purpose: string, _month: string, reason: string) {
      await pool.query(
        `UPDATE amex_ai_attempts SET status='failed',response=$3 WHERE household_id=$1 AND purpose=$2`,
        [householdId, purpose, JSON.stringify({ error: reason })],
      );
    },
    async finish(householdId: string, purpose: string, _month: string, response: unknown) {
      await pool.query(
        `UPDATE amex_ai_attempts SET status='completed',response=$3 WHERE household_id=$1 AND purpose=$2`,
        [householdId, purpose, JSON.stringify(response)],
      );
    },
  };
}
export type AiUsageStore = ReturnType<typeof postgresAiUsage>;
