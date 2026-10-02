import type pg from 'pg';
import { createHash } from 'node:crypto';
import {
  activityKind,
  dashboard,
  needsReview,
  validCategoryName,
  type Activity,
  type AmbiguousActivity,
  type Category,
  type CategorizedActivity,
} from './activity.js';
import { resolveMerchant, type MerchantAlias, validMerchantName } from './normalization.js';
import { amexCategoryDefaults } from './classification.js';
import { detectRecurring, evaluateAmexRules, previousAmexRange, type AmexAlertRule, type AmexFilters } from './analytics.js';

export function postgresAmexActivity(pool: pg.Pool) {
  const merchantHash = (name: string) => createHash('sha256').update(name).digest('hex');
  return {
    async cards(householdId: string) {
      const result = await pool.query<{ id: string; label: string; last_four: string }>(
        'SELECT id,label,last_four FROM amex_cards WHERE household_id=$1 ORDER BY created_at,id', [householdId],
      );
      return result.rows.map((row) => ({ id: row.id, label: row.label, last4: row.last_four }));
    },
    async addCard(householdId: string, label: string, last4: string) {
      const result = await pool.query<{ id: string }>(
        'INSERT INTO amex_cards(household_id,label,last_four) VALUES($1,$2,$3) ON CONFLICT(household_id,last_four) DO NOTHING RETURNING id',
        [householdId, label, last4],
      );
      return result.rows[0]?.id ?? null;
    },
    async renameCard(householdId: string, id: string, label: string) {
      const result = await pool.query(
        'UPDATE amex_cards SET label=$3 WHERE household_id=$1 AND id=$2', [householdId, id, label],
      );
      return Boolean(result.rowCount);
    },
    async automaticClassificationCandidates(householdId: string, candidates: string[]) {
      if (!candidates.length) return [];
      const blocked = await pool.query<{ merchant_hash: string }>(
        `SELECT merchant_hash FROM amex_classification_attempts
         WHERE household_id=$1 AND merchant_hash=ANY($2::char(64)[])
           AND (status='review' OR last_attempt > now() - interval '24 hours')`,
        [householdId, candidates.map(merchantHash)],
      );
      const excluded = new Set(blocked.rows.map((row) => row.merchant_hash));
      return candidates.filter((name) => !excluded.has(merchantHash(name)));
    },
    async recordClassificationBatch(
      householdId: string,
      candidates: string[],
      accepted: string[],
      failed: boolean,
    ) {
      const known = new Set(accepted);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const merchant of candidates) {
          const hash = merchantHash(merchant);
          if (known.has(merchant) && !failed)
            await client.query(
              `DELETE FROM amex_classification_attempts WHERE household_id=$1 AND merchant_hash=$2`,
              [householdId, hash],
            );
          else
            await client.query(
              `INSERT INTO amex_classification_attempts(household_id,merchant_hash,status)
             VALUES($1,$2,$3) ON CONFLICT(household_id,merchant_hash)
             DO UPDATE SET status=EXCLUDED.status,attempts=amex_classification_attempts.attempts+1,last_attempt=now()`,
              [householdId, hash, failed ? 'failed' : 'review'],
            );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async commit(
      householdId: string,
      activities: Activity[],
      source?: {
        filename: string;
        hash: string;
        invalidCount: number;
        ambiguousRows?: AmbiguousActivity[];
        from?: string | null;
        through?: string | null;
      },
    ) {
      if (source?.ambiguousRows?.length && !(await this.importReviewReady()))
        throw new Error('amex_review_migration_required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const aliasResult = await client.query<{
          merchant_id: string;
          name: string;
          pattern: string;
          match_type: 'exact' | 'prefix';
          source: 'user' | 'ai' | 'rule';
        }>(
          `SELECT a.merchant_id,m.name,a.pattern,a.match_type,a.source
             FROM amex_merchant_aliases a JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
             WHERE a.household_id=$1`,
          [householdId],
        );
        const aliases: MerchantAlias[] = aliasResult.rows.map((alias) => ({
          merchantId: alias.merchant_id,
          name: alias.name,
          pattern: alias.pattern,
          matchType: alias.match_type,
          source: alias.source,
        }));
        const importId = source
          ? (
              await client.query<{ id: string }>(
                `INSERT INTO amex_imports(household_id,filename,file_hash,transaction_count,imported_count,duplicate_count,invalid_count,from_date,through_date)
             VALUES($1,$2,$3,$4,0,0,$5,$6,$7) RETURNING id`,
                [
                  householdId,
                  source.filename.slice(0, 200),
                  source.hash,
                   activities.length + source.invalidCount + (source.ambiguousRows?.length ?? 0),
                  source.invalidCount,
                  source.from ?? activities.map((row) => row.date).sort()[0] ?? null,
                  source.through ??
                    activities
                      .map((row) => row.date)
                      .sort()
                      .at(-1) ??
                    null,
                ],
              )
            ).rows[0]!.id
          : null;
        let reviewCount = 0;
        if (importId && source?.ambiguousRows?.length) {
          for (const row of source.ambiguousRows) {
            const saved = await client.query(
              `INSERT INTO amex_import_review_rows(household_id,import_id,file_hash,record_number,activity_date,description,amount_cents,source_category,card_last_four)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(household_id,file_hash,record_number) DO NOTHING`,
              [householdId, importId, source.hash, row.record, row.date, row.description, row.amountCents, row.sourceCategory, row.cardLast4],
            );
            reviewCount += saved.rowCount ?? 0;
          }
          await client.query(`UPDATE amex_imports SET review_count=$3 WHERE household_id=$1 AND id=$2`, [householdId, importId, reviewCount]);
        }
        for (const name of amexCategoryDefaults)
          await client.query(
            `INSERT INTO amex_spending_categories(household_id,name,source) VALUES($1,$2,'user')
           ON CONFLICT(household_id,name) DO NOTHING`,
            [householdId, name],
          );
        let added = 0;
        for (const row of activities) {
          const existing = await client.query<{ fingerprint: string }>(
            'SELECT fingerprint FROM amex_activity WHERE household_id=$1 AND reference=$2',
            [householdId, row.reference],
          );
          if (existing.rows[0]) {
            if (existing.rows[0].fingerprint !== row.fingerprint) throw new Error('amex_reference_conflict');
            continue;
          }
          const normalized = resolveMerchant(row.description, aliases);
          let merchantId = normalized.merchantId;
          let merchant = normalized.name;
          if (!merchantId) {
            const saved = await client.query<{ id: string; name: string }>(
              `SELECT id,name FROM amex_merchants WHERE household_id=$1 AND lower(name)=lower($2) LIMIT 1`,
              [householdId, merchant],
            );
            if (saved.rows[0]) {
              merchantId = saved.rows[0].id;
              merchant = saved.rows[0].name;
            } else {
              const created = await client.query<{ id: string }>(
                `INSERT INTO amex_merchants(household_id,name) VALUES($1,$2) RETURNING id`,
                [householdId, merchant],
              );
              merchantId = created.rows[0]!.id;
            }
          }
          const result = await client.query(
            `INSERT INTO amex_activity(household_id,reference,activity_date,description,merchant,amount_cents,source_category,fingerprint,merchant_id,import_id,currency,merchant_source,merchant_review,card_last_four)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'EUR',$11,$12,$13) ON CONFLICT DO NOTHING RETURNING fingerprint`,
            [
              householdId,
              row.reference,
              row.date,
              row.description,
              merchant,
              row.amountCents,
              row.sourceCategory,
              row.fingerprint,
              merchantId,
              importId,
              normalized.source,
              normalized.source === 'rule' && merchant.toUpperCase() === row.description.trim().toUpperCase(),
              row.cardLast4 ?? null,
            ],
          );
          if (result.rowCount) added++;
          else {
            const concurrent = await client.query<{ fingerprint: string }>(
              'SELECT fingerprint FROM amex_activity WHERE household_id=$1 AND reference=$2',
              [householdId, row.reference],
            );
            if (concurrent.rows[0]?.fingerprint !== row.fingerprint)
              throw new Error('amex_reference_conflict');
          }
        }
        if (importId)
          await client.query(
            `UPDATE amex_imports SET imported_count=$3,duplicate_count=$4 WHERE household_id=$1 AND id=$2`,
            [householdId, importId, added, activities.length - added],
          );
        await client.query('COMMIT');
        return added;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async list(householdId: string, scope?: { from?: string; through?: string; before?: string; merchants?: string[]; references?: string[]; cardLast4?: string }): Promise<
      Array<
        CategorizedActivity & {
          merchantId: string | null;
          categoryOverride: string | null;
          merchantSource: 'rule' | 'ai' | 'user';
          merchantConfidence: number | null;
          merchantReview: boolean;
        }
      >
    > {
      const result = await pool.query<{
        reference: string;
        activity_date: string;
        description: string;
        merchant: string;
        amount_cents: string;
        source_category: string;
        fingerprint: string;
        category: string | null;
        category_source: 'user' | 'ai' | null;
        merchant_id: string | null;
        category_override: string | null;
        merchant_source: 'rule' | 'ai' | 'user';
        merchant_confidence: string | null;
        merchant_review: boolean;
        card_last_four: string | null;
      }>(
        `SELECT a.reference,a.activity_date::text,a.description,coalesce(m.name,a.merchant) AS merchant,a.amount_cents::text,
          a.source_category,a.fingerprint,a.merchant_id,a.category_override,a.merchant_source,a.card_last_four,
          a.merchant_confidence::text,a.merchant_review,c.category,c.source AS category_source
         FROM amex_activity a LEFT JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
         LEFT JOIN LATERAL (
           SELECT category,source FROM amex_merchant_categories c
           WHERE c.household_id=a.household_id AND (
             c.merchant=coalesce(m.name,a.merchant) OR
             (c.merchant LIKE 'family:%' AND starts_with(coalesce(m.name,a.merchant),substring(c.merchant from 8)))
           )
           ORDER BY (c.source='user') DESC,(c.merchant=coalesce(m.name,a.merchant)) DESC,length(c.merchant) DESC
           LIMIT 1
         ) c ON true
          WHERE a.household_id=$1
            AND ($2::date IS NULL OR a.activity_date >= $2)
            AND ($3::date IS NULL OR a.activity_date <= $3)
            AND ($4::date IS NULL OR a.activity_date < $4)
            AND ($5::text[] IS NULL OR coalesce(m.name,a.merchant)=ANY($5))
            AND ($6::text[] IS NULL OR a.reference=ANY($6))
            AND ($7::char(4) IS NULL OR a.card_last_four=$7)
          ORDER BY a.activity_date DESC,a.reference`,
        [householdId, scope?.from ?? null, scope?.through ?? null, scope?.before ?? null, scope?.merchants ?? null, scope?.references ?? null, scope?.cardLast4 ?? null],
      );
      return result.rows.map((r) => ({
        reference: r.reference,
        date: r.activity_date,
        description: r.description,
        merchant: r.merchant,
        amountCents: Number(r.amount_cents),
        sourceCategory: r.source_category,
        fingerprint: r.fingerprint,
        cardLast4: r.card_last_four,
        merchantId: r.merchant_id,
        categoryOverride: r.category_override,
        merchantSource: r.merchant_source,
        merchantConfidence: r.merchant_confidence === null ? null : Number(r.merchant_confidence),
        merchantReview: r.merchant_review,
        category: r.category_override ?? r.category ?? needsReview,
        categorySource: r.category_override
          ? 'user'
          : r.category_source === 'user'
            ? 'user'
            : r.category_source === 'ai'
              ? 'ai'
              : 'unreviewed',
      }));
    },
    async analyticsRows(householdId: string, filter: AmexFilters) {
      const previous = previousAmexRange(filter.from, filter.through);
      const from = previous.from < filter.from ? previous.from : filter.from;
      const windowRows = await this.list(householdId, { from, through: filter.through, cardLast4: filter.cardLast4 });
      const names = [...new Set(windowRows.map((row) => row.merchant))];
      if (!names.length) return windowRows;
      const history = await this.list(householdId, { before: from, merchants: names, cardLast4: filter.cardLast4 });
      return [...windowRows, ...history];
    },
    async identities(householdId: string, references: string[]) {
      if (!references.length) return [];
      const found = await pool.query<{ reference: string; fingerprint: string }>(
        `SELECT reference,fingerprint FROM amex_activity WHERE household_id=$1 AND reference=ANY($2::text[])`,
        [householdId, references],
      );
      return found.rows;
    },
    async pendingMerchantCount(householdId: string) {
      const result = await pool.query<{ pending: string }>(
        `SELECT count(DISTINCT coalesce(m.name,a.merchant))::text AS pending
         FROM amex_activity a
         LEFT JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
         LEFT JOIN LATERAL (
           SELECT source FROM amex_merchant_categories c WHERE c.household_id=a.household_id AND (
             c.merchant=coalesce(m.name,a.merchant) OR
             (c.merchant LIKE 'family:%' AND starts_with(coalesce(m.name,a.merchant),substring(c.merchant from 8)))
           ) ORDER BY (c.source='user') DESC,(c.merchant=coalesce(m.name,a.merchant)) DESC,length(c.merchant) DESC LIMIT 1
         ) c ON true
         WHERE a.household_id=$1 AND a.amount_cents>=0 AND a.category_override IS NULL AND c.source IS NULL`,
        [householdId],
      );
      return Number(result.rows[0]?.pending ?? 0);
    },
    async pageTransactions(householdId: string, filter: AmexFilters, page: number, size: number,
      sort: 'date' | 'amount' | 'merchant', direction: 'asc' | 'desc') {
      // Only candidate merchants observed in the selected window need recurrence history.
       const recurrence = await pool.query<{
        reference: string; activity_date: string; description: string; merchant: string;
        amount_cents: string; merchant_id: string | null;
      }>(
        `SELECT a.reference,a.activity_date::text,a.description,coalesce(m.name,a.merchant) AS merchant,
                a.amount_cents::text,a.merchant_id
         FROM amex_activity a LEFT JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
          WHERE a.household_id=$1 AND a.amount_cents>=0 AND a.activity_date <= $3::date
            AND ($4::char(4) IS NULL OR a.card_last_four=$4)
           AND coalesce(m.name,a.merchant) IN (
             SELECT DISTINCT coalesce(current_merchant.name,current_row.merchant)
             FROM amex_activity current_row
             LEFT JOIN amex_merchants current_merchant ON current_merchant.household_id=current_row.household_id
               AND current_merchant.id=current_row.merchant_id
              WHERE current_row.household_id=$1 AND current_row.amount_cents>=0
                AND ($4::char(4) IS NULL OR current_row.card_last_four=$4)
               AND current_row.activity_date BETWEEN $2::date AND $3::date
           )
          ORDER BY a.activity_date`, [householdId, filter.from, filter.through, filter.cardLast4 ?? null],
      );
      const recurring = new Set(detectRecurring(recurrence.rows.map((row) => ({
        reference: row.reference, date: row.activity_date, description: row.description,
        merchant: row.merchant, merchantId: row.merchant_id, amountCents: Number(row.amount_cents),
        sourceCategory: '', fingerprint: '', category: '', categorySource: 'unreviewed' as const,
      }))).flatMap((candidate) => candidate.references));
      const values: unknown[] = [householdId, filter.from, filter.through, filter.merchant ?? null,
        filter.category ?? null, filter.minCents ?? null, filter.maxCents ?? null,
         filter.search?.trim().replace(/[\\%_]/g, '\\$&') || null, filter.recurring ?? null, [...recurring], filter.cardLast4 ?? null];
      const source = `FROM amex_activity a
        LEFT JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
        LEFT JOIN LATERAL (
          SELECT category,source FROM amex_merchant_categories c WHERE c.household_id=a.household_id AND (
            c.merchant=coalesce(m.name,a.merchant) OR
            (c.merchant LIKE 'family:%' AND starts_with(coalesce(m.name,a.merchant),substring(c.merchant from 8)))
          ) ORDER BY (c.source='user') DESC,(c.merchant=coalesce(m.name,a.merchant)) DESC,length(c.merchant) DESC LIMIT 1
        ) c ON true
        WHERE a.household_id=$1 AND a.activity_date BETWEEN $2::date AND $3::date
          AND NOT (a.amount_cents < 0 AND (a.description ~* '^ZAHLUNG/.*ERHALTEN[[:space:]]+BESTEN[[:space:]]+DANK' OR a.description ~* '^PAYMENT (RECEIVED|THANK YOU)'))
          AND ($4::text IS NULL OR coalesce(m.name,a.merchant)=$4)
          AND ($5::text IS NULL OR (coalesce(a.category_override,c.category,'Needs review')=$5
            AND ($5 <> 'Needs review' OR a.amount_cents>=0)))
          AND ($6::bigint IS NULL OR a.amount_cents >= $6)
          AND ($7::bigint IS NULL OR a.amount_cents <= $7)
          AND ($8::text IS NULL OR coalesce(m.name,a.merchant) ILIKE '%' || $8 || '%' ESCAPE '\\'
            OR a.description ILIKE '%' || $8 || '%' ESCAPE '\\')
           AND ($9::boolean IS NULL OR (a.reference=ANY($10::text[]))=$9)
           AND ($11::char(4) IS NULL OR a.card_last_four=$11)`;
      const count = await pool.query<{ total: string; total_cents: string }>(`SELECT count(*)::text AS total, coalesce(sum(greatest(a.amount_cents,0)),0)::text AS total_cents ${source}`, values);
      const sortColumn = { date: 'a.activity_date', amount: 'a.amount_cents', merchant: 'coalesce(m.name,a.merchant)' }[sort];
      const result = await pool.query<{
        reference: string; activity_date: string; description: string; merchant: string;
        amount_cents: string; source_category: string; fingerprint: string; merchant_id: string | null;
        merchant_source: 'rule' | 'user' | 'ai'; merchant_confidence: string | null;
        merchant_review: boolean; category_override: string | null;
         category: string | null; category_source: 'user' | 'ai' | null; card_last_four: string | null;
      }>(`SELECT a.reference,a.activity_date::text,a.description,coalesce(m.name,a.merchant) AS merchant,
          a.amount_cents::text,a.source_category,a.fingerprint,a.merchant_id,a.merchant_source,
           a.merchant_confidence::text,a.merchant_review,a.category_override,c.category,c.source AS category_source,a.card_last_four
          ${source} ORDER BY ${sortColumn} ${direction === 'asc' ? 'ASC' : 'DESC'},a.reference ${direction === 'asc' ? 'ASC' : 'DESC'}
           LIMIT $12 OFFSET $13`, [...values, size, (page - 1) * size]);
      return { total: Number(count.rows[0]?.total ?? 0), totalCents: Number(count.rows[0]?.total_cents ?? 0), page, size, rows: result.rows.map((row) => ({
        reference: row.reference, date: row.activity_date, description: row.description,
        merchant: row.merchant, merchantId: row.merchant_id, amountCents: Number(row.amount_cents),
         sourceCategory: row.source_category, fingerprint: row.fingerprint, cardLast4: row.card_last_four,
        merchantSource: row.merchant_source,
        merchantConfidence: row.merchant_confidence === null ? null : Number(row.merchant_confidence),
        merchantReview: row.merchant_review, categoryOverride: row.category_override,
        category: row.category_override ?? row.category ?? needsReview,
        categorySource: row.category_override ? 'user' : row.category_source ?? 'unreviewed',
        recurring: recurring.has(row.reference), kind: activityKind({ description: row.description, amountCents: Number(row.amount_cents) }),
      })) };
    },
    async categories(householdId: string): Promise<string[]> {
      const ready = await this.ready();
      const result = ready
        ? await pool.query<{ category: string }>(
            `SELECT name AS category FROM amex_spending_categories WHERE household_id=$1 ORDER BY name`,
            [householdId],
          )
        : await pool.query<{ category: string }>(
            `SELECT DISTINCT category FROM amex_merchant_categories WHERE household_id=$1 AND category <> $2 ORDER BY category`,
            [householdId, needsReview],
          );
      return result.rows.map((row) => row.category);
    },
    async ready(): Promise<boolean> {
      const result = await pool.query<{ ready: boolean }>(
        `SELECT to_regclass('amex_spending_categories') IS NOT NULL AS ready`,
      );
      return result.rows[0]?.ready ?? false;
    },
    async categorize(householdId: string, merchant: string, category: Category, source: 'user' | 'ai') {
      if (category !== needsReview && !validCategoryName(category)) throw new Error('invalid_category');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        if (
          source === 'user' &&
          category !== needsReview &&
          !(await this.categories(householdId)).includes(category)
        )
          throw new Error('unknown_category');
        const exists = await client.query(
          'SELECT 1 FROM amex_activity WHERE household_id=$1 AND merchant=$2 LIMIT 1',
          [householdId, merchant],
        );
        if (!exists.rowCount) {
          await client.query('COMMIT');
          return false;
        }
        const previous = await client.query<{ category: string }>(
          `SELECT category FROM amex_merchant_categories WHERE household_id=$1 AND merchant=$2`,
          [householdId, merchant],
        );
        await client.query(
          `INSERT INTO amex_merchant_categories(household_id,merchant,category,source) VALUES($1,$2,$3,$4)
         ON CONFLICT(household_id,merchant) DO UPDATE SET category=EXCLUDED.category,source=EXCLUDED.source,updated_at=now()
         WHERE amex_merchant_categories.source <> 'user' OR EXCLUDED.source = 'user'`,
          [householdId, merchant, category, source],
        );
        if (source === 'user')
          await client.query(
            `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           SELECT $1,'merchant_category',$2,$3,$4,count(*) FROM amex_activity WHERE household_id=$1 AND merchant=$2`,
            [householdId, merchant, previous.rows[0]?.category ?? null, category],
          );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async setTransactionCategory(householdId: string, reference: string, category: string | null) {
      if (
        category !== null &&
        category !== needsReview &&
        !(await this.categories(householdId)).includes(category)
      )
        throw new Error('unknown_category');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const original = await client.query<{ category_override: string | null }>(
          `SELECT category_override FROM amex_activity WHERE household_id=$1 AND reference=$2 FOR UPDATE`,
          [householdId, reference],
        );
        if (!original.rows[0]) {
          await client.query('COMMIT');
          return false;
        }
        await client.query(
          `UPDATE amex_activity SET category_override=$3 WHERE household_id=$1 AND reference=$2`,
          [householdId, reference, category],
        );
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'transaction_category',$2,$3,$4,1)`,
          [householdId, reference, original.rows[0].category_override, category],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async createCategory(householdId: string, name: string) {
      if (!validCategoryName(name)) throw new Error('invalid_category');
      await pool.query(
        `INSERT INTO amex_spending_categories(household_id,name,source) VALUES($1,$2,'user') ON CONFLICT(household_id,name) DO NOTHING`,
        [householdId, name],
      );
    },
    async merchants(householdId: string) {
      const [merchantResult, aliasResult] = await Promise.all([
        pool.query<{ id: string; name: string }>(
          `SELECT m.id,m.name FROM amex_merchants m WHERE m.household_id=$1
           AND EXISTS (SELECT 1 FROM amex_activity a WHERE a.household_id=m.household_id
             AND a.merchant_id=m.id AND a.amount_cents>=0) ORDER BY m.name`,
          [householdId],
        ),
        pool.query<{
          id: string;
          merchant_id: string;
          pattern: string;
          match_type: 'exact' | 'prefix';
          source: string;
        }>(
          `SELECT id,merchant_id,pattern,match_type,source FROM amex_merchant_aliases WHERE household_id=$1 ORDER BY pattern`,
          [householdId],
        ),
      ]);
      return merchantResult.rows.map((merchant) => ({
        ...merchant,
        aliases: aliasResult.rows
          .filter((alias) => alias.merchant_id === merchant.id)
          .map((alias) => ({
            id: alias.id,
            pattern: alias.pattern,
            matchType: alias.match_type,
            source: alias.source,
          })),
      }));
    },
    async availableMerchantNames(householdId: string) {
      const result = await pool.query<{ name: string }>(
        `SELECT DISTINCT coalesce(m.name,a.merchant) AS name FROM amex_activity a
         LEFT JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id
         WHERE a.household_id=$1 AND a.amount_cents>=0 ORDER BY name`, [householdId],
      );
      return result.rows.map((row) => row.name);
    },
    async availableCycles(householdId: string, cardLast4?: string) {
      const result = await pool.query<{ key: string }>(
        `SELECT DISTINCT to_char(activity_date - interval '6 days', 'YYYY-MM') AS key
          FROM amex_activity WHERE household_id=$1 AND amount_cents>=0
            AND ($2::char(4) IS NULL OR card_last_four=$2) ORDER BY key DESC`,
         [householdId, cardLast4 ?? null],
      );
      return result.rows.map((row) => row.key);
    },
    async recurringReviewReady() {
      const result = await pool.query<{ ready: boolean }>(
        `SELECT to_regclass('amex_recurring_reviews') IS NOT NULL AS ready`,
      );
      return Boolean(result.rows[0]?.ready);
    },
    async importReviewReady() {
      const result = await pool.query<{ ready: boolean }>(
        `SELECT to_regclass('amex_import_review_rows') IS NOT NULL AS ready`,
      );
      return Boolean(result.rows[0]?.ready);
    },
    async importReviews(householdId: string) {
      if (!(await this.importReviewReady())) return [];
      const result = await pool.query<{
        id: string; record_number: number; activity_date: string; description: string;
        amount_cents: string; source_category: string; filename: string; possible_duplicates: string;
      }>(
        `SELECT r.id,r.record_number,r.activity_date::text,r.description,r.amount_cents::text,r.source_category,i.filename,
          (SELECT count(*)::text FROM amex_activity a WHERE a.household_id=r.household_id AND a.activity_date=r.activity_date
            AND a.description=r.description AND a.amount_cents=r.amount_cents) AS possible_duplicates
         FROM amex_import_review_rows r JOIN amex_imports i ON i.household_id=r.household_id AND i.id=r.import_id
         WHERE r.household_id=$1 AND r.status='pending' ORDER BY r.activity_date DESC,r.record_number LIMIT 200`,
        [householdId],
      );
      return result.rows.map((row) => ({ id: row.id, record: row.record_number, date: row.activity_date,
        description: row.description, amountCents: Number(row.amount_cents), sourceCategory: row.source_category,
        filename: row.filename, possibleDuplicates: Number(row.possible_duplicates) }));
    },
    async resolveImportReview(householdId: string, id: string, decision: 'distinct' | 'dismissed') {
      if (!(await this.importReviewReady())) throw new Error('amex_review_migration_required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const result = await client.query<{
          import_id: string; file_hash: string; record_number: number; activity_date: string;
          description: string; amount_cents: string; source_category: string; card_last_four: string | null;
        }>(
          `SELECT import_id,file_hash,record_number,activity_date::text,description,amount_cents::text,source_category,card_last_four
           FROM amex_import_review_rows WHERE household_id=$1 AND id=$2 AND status='pending' FOR UPDATE`,
          [householdId, id],
        );
        const row = result.rows[0];
        if (!row) { await client.query('ROLLBACK'); return false; }
        let reference: string | null = null;
        if (decision === 'distinct') {
          reference = `review:${createHash('sha256').update(`${row.file_hash}:${row.record_number}`).digest('hex')}`;
          const aliasResult = await client.query<{
            merchant_id: string; name: string; pattern: string; match_type: 'exact' | 'prefix';
            source: 'user' | 'ai' | 'rule';
          }>(`SELECT a.merchant_id,m.name,a.pattern,a.match_type,a.source FROM amex_merchant_aliases a
             JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id WHERE a.household_id=$1`, [householdId]);
          const normalized = resolveMerchant(row.description, aliasResult.rows.map((alias) => ({
            merchantId: alias.merchant_id, name: alias.name, pattern: alias.pattern,
            matchType: alias.match_type, source: alias.source,
          })));
          let merchantId = normalized.merchantId;
          let merchant = normalized.name;
          if (!merchantId) {
            const existing = await client.query<{ id: string; name: string }>(
              `SELECT id,name FROM amex_merchants WHERE household_id=$1 AND lower(name)=lower($2) LIMIT 1`, [householdId, merchant],
            );
            const saved = existing.rows[0] ?? (await client.query<{ id: string; name: string }>(
              `INSERT INTO amex_merchants(household_id,name) VALUES($1,$2) RETURNING id,name`, [householdId, merchant],
            )).rows[0]!;
            merchantId = saved.id;
            merchant = saved.name;
          }
          const fingerprint = createHash('sha256').update(JSON.stringify([
             reference, row.activity_date, Number(row.amount_cents), row.description, row.card_last_four, 'EUR',
          ])).digest('hex');
          await client.query(
            `INSERT INTO amex_activity(household_id,reference,activity_date,description,merchant,amount_cents,source_category,
               fingerprint,merchant_id,import_id,currency,merchant_source,merchant_review,card_last_four)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'EUR',$11,$12,$13)`,
            [householdId, reference, row.activity_date, row.description, merchant, row.amount_cents,
              row.source_category, fingerprint, merchantId, row.import_id, normalized.source,
               normalized.source === 'rule' && merchant.toUpperCase() === row.description.trim().toUpperCase(), row.card_last_four],
          );
          await client.query(`UPDATE amex_imports SET imported_count=imported_count+1 WHERE household_id=$1 AND id=$2`,
            [householdId, row.import_id]);
        }
        await client.query(
          `UPDATE amex_import_review_rows SET status=$3,resolved_reference=$4,reviewed_at=now() WHERE household_id=$1 AND id=$2`,
          [householdId, id, decision, reference],
        );
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'import_review',$2,'pending',$3,$4)`, [householdId, id, decision, decision === 'distinct' ? 1 : 0],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async recurringReviews(householdId: string) {
      if (!(await this.recurringReviewReady())) return [];
      const result = await pool.query<{ merchant_id: string; status: 'confirmed' | 'dismissed' }>(
        `SELECT merchant_id,status FROM amex_recurring_reviews WHERE household_id=$1`, [householdId],
      );
      return result.rows.map((item) => ({ merchantId: item.merchant_id, status: item.status }));
    },
    async setRecurringReview(householdId: string, merchantId: string, status: 'confirmed' | 'dismissed') {
      if (!(await this.recurringReviewReady())) throw new Error('amex_review_migration_required');
      if (!detectRecurring(await this.list(householdId)).some((item) => item.merchantId === merchantId)) return false;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const candidate = await client.query(
          `SELECT 1 FROM amex_merchants WHERE household_id=$1 AND id=$2`, [householdId, merchantId],
        );
        if (!candidate.rowCount) { await client.query('ROLLBACK'); return false; }
        const previous = await client.query<{ status: string }>(
          `SELECT status FROM amex_recurring_reviews WHERE household_id=$1 AND merchant_id=$2`,
          [householdId, merchantId],
        );
        await client.query(
          `INSERT INTO amex_recurring_reviews(household_id,merchant_id,status) VALUES($1,$2,$3)
           ON CONFLICT(household_id,merchant_id) DO UPDATE SET status=EXCLUDED.status,reviewed_at=now()`,
          [householdId, merchantId, status],
        );
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'recurring_review',$2,$3,$4,0)`,
          [householdId, merchantId, previous.rows[0]?.status ?? null, status],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async changes(householdId: string) {
      const result = await pool.query<{
        action: string;
        entity_key: string;
        previous_value: string | null;
        next_value: string | null;
        affected_rows: number;
        changed_at: string;
      }>(
        `SELECT action,entity_key,previous_value,next_value,affected_rows,changed_at::text
         FROM amex_change_log WHERE household_id=$1 ORDER BY changed_at DESC LIMIT 50`,
        [householdId],
      );
      return result.rows.map((row) => ({
        action: row.action,
        entity: row.entity_key,
        previous: row.previous_value,
        next: row.next_value,
        affectedRows: row.affected_rows,
        changedAt: row.changed_at,
      }));
    },
    async renameMerchant(householdId: string, id: string, name: string) {
      if (!validMerchantName(name)) throw new Error('invalid_merchant');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const old = await client.query<{ name: string }>(
          `SELECT name FROM amex_merchants WHERE household_id=$1 AND id=$2 FOR UPDATE`,
          [householdId, id],
        );
        if (!old.rows[0]) throw new Error('merchant_not_found');
        await client.query(`UPDATE amex_merchants SET name=$3 WHERE household_id=$1 AND id=$2`, [
          householdId,
          id,
          name,
        ]);
        const changed = await client.query(
          `UPDATE amex_activity SET merchant=$3,merchant_source='user',merchant_review=false,merchant_confidence=NULL WHERE household_id=$1 AND merchant_id=$2`,
          [householdId, id, name],
        );
        await client.query(
          `INSERT INTO amex_merchant_aliases(household_id,merchant_id,pattern,match_type,source)
           VALUES($1,$2,$3,'exact','user') ON CONFLICT(household_id,pattern,match_type)
           DO UPDATE SET merchant_id=EXCLUDED.merchant_id,source='user'`,
          [householdId, id, old.rows[0].name],
        );
        await client.query(
          `UPDATE amex_merchant_categories SET merchant=$3,source='user' WHERE household_id=$1 AND merchant=$2`,
          [householdId, old.rows[0].name, name],
        );
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'merchant_rename',$2,$3,$4,$5)`,
          [householdId, id, old.rows[0].name, name, changed.rowCount ?? 0],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async addAlias(householdId: string, merchantId: string, pattern: string, matchType: 'exact' | 'prefix') {
      const trimmed = pattern.trim();
      if (!trimmed || trimmed.length > 300 || (matchType === 'prefix' && trimmed.length < 5))
        throw new Error('invalid_alias');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const target = await client.query<{ name: string }>(
          `SELECT name FROM amex_merchants WHERE household_id=$1 AND id=$2`,
          [householdId, merchantId],
        );
        if (!target.rows[0]) throw new Error('merchant_not_found');
        await client.query(
          `INSERT INTO amex_merchant_aliases(household_id,merchant_id,pattern,match_type,source)
           VALUES($1,$2,$3,$4,'user') ON CONFLICT(household_id,pattern,match_type)
           DO UPDATE SET merchant_id=EXCLUDED.merchant_id,source='user'`,
          [householdId, merchantId, trimmed, matchType],
        );
        const aliasRows = await client.query<{
          merchant_id: string;
          name: string;
          pattern: string;
          match_type: 'exact' | 'prefix';
          source: 'user' | 'ai' | 'rule';
        }>(
          `SELECT a.merchant_id,m.name,a.pattern,a.match_type,a.source FROM amex_merchant_aliases a
           JOIN amex_merchants m ON m.household_id=a.household_id AND m.id=a.merchant_id WHERE a.household_id=$1`,
          [householdId],
        );
        const aliases = aliasRows.rows.map((alias) => ({
          merchantId: alias.merchant_id,
          name: alias.name,
          pattern: alias.pattern,
          matchType: alias.match_type,
          source: alias.source,
        }));
        const rows = await client.query<{ reference: string; description: string }>(
          `SELECT reference,description FROM amex_activity WHERE household_id=$1`,
          [householdId],
        );
        let affected = 0;
        for (const row of rows.rows) {
          const found = resolveMerchant(row.description, aliases);
          if (found.merchantId !== merchantId) continue;
          await client.query(
            `UPDATE amex_activity SET merchant_id=$3,merchant=$4,merchant_source='user',merchant_review=false,merchant_confidence=NULL WHERE household_id=$1 AND reference=$2`,
            [householdId, row.reference, merchantId, target.rows[0].name],
          );
          affected++;
        }
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'merchant_alias',$2,$3,$4,$5)`,
          [householdId, merchantId, `${matchType}:${trimmed}`, target.rows[0].name, affected],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async mergeMerchants(householdId: string, sourceId: string, targetId: string) {
      if (sourceId === targetId) throw new Error('same_merchant');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const sources = await client.query<{ id: string; name: string }>(
          `SELECT id,name FROM amex_merchants WHERE household_id=$1 AND id IN ($2,$3) FOR UPDATE`,
          [householdId, sourceId, targetId],
        );
        const from = sources.rows.find((row) => row.id === sourceId);
        const to = sources.rows.find((row) => row.id === targetId);
        if (!from || !to) throw new Error('merchant_not_found');
        const changed = await client.query(
          `UPDATE amex_activity SET merchant_id=$3,merchant=$4,merchant_source='user',merchant_review=false,merchant_confidence=NULL WHERE household_id=$1 AND merchant_id=$2`,
          [householdId, sourceId, targetId, to.name],
        );
        await client.query(
          `UPDATE amex_merchant_aliases SET merchant_id=$3 WHERE household_id=$1 AND merchant_id=$2`,
          [householdId, sourceId, targetId],
        );
        await client.query(
          `UPDATE amex_alert_rules SET merchant_id=$3 WHERE household_id=$1 AND merchant_id=$2`,
          [householdId, sourceId, targetId],
        );
        if (await this.recurringReviewReady()) {
          await client.query(
            `INSERT INTO amex_recurring_reviews(household_id,merchant_id,status)
             SELECT household_id,$3,status FROM amex_recurring_reviews WHERE household_id=$1 AND merchant_id=$2
             ON CONFLICT(household_id,merchant_id) DO NOTHING`,
            [householdId, sourceId, targetId],
          );
          await client.query(`DELETE FROM amex_recurring_reviews WHERE household_id=$1 AND merchant_id=$2`, [householdId, sourceId]);
        }
        const sourceCategory = await client.query<{ category: string; source: string }>(
          `SELECT category,source FROM amex_merchant_categories WHERE household_id=$1 AND merchant=$2`,
          [householdId, from.name],
        );
        if (sourceCategory.rows[0])
          await client.query(
            `INSERT INTO amex_merchant_categories(household_id,merchant,category,source)
           VALUES($1,$2,$3,$4) ON CONFLICT(household_id,merchant)
           DO UPDATE SET category=EXCLUDED.category,source=EXCLUDED.source,updated_at=now()
           WHERE amex_merchant_categories.source <> 'user' AND EXCLUDED.source='user'`,
            [householdId, to.name, sourceCategory.rows[0].category, sourceCategory.rows[0].source],
          );
        await client.query(`DELETE FROM amex_merchant_categories WHERE household_id=$1 AND merchant=$2`, [
          householdId,
          from.name,
        ]);
        await client.query(
          `INSERT INTO amex_merchant_aliases(household_id,merchant_id,pattern,match_type,source)
           VALUES($1,$2,$3,'exact','user') ON CONFLICT(household_id,pattern,match_type) DO NOTHING`,
          [householdId, targetId, from.name],
        );
        await client.query(`DELETE FROM amex_merchants WHERE household_id=$1 AND id=$2`, [
          householdId,
          sourceId,
        ]);
        await client.query(
          `INSERT INTO amex_change_log(household_id,action,entity_key,previous_value,next_value,affected_rows)
           VALUES($1,'merchant_merge',$2,$3,$4,$5)`,
          [householdId, targetId, from.name, to.name, changed.rowCount ?? 0],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async imports(householdId: string) {
      const result = await pool.query<{
        id: string;
        filename: string;
        mapping_version: string;
        imported_at: string;
        transaction_count: number;
        review_count: number;
        imported_count: number;
        duplicate_count: number;
        invalid_count: number;
        from_date: string | null;
        through_date: string | null;
      }>(
         `SELECT i.id,i.filename,coalesce(to_jsonb(i)->>'mapping_version','legacy-unknown') AS mapping_version,coalesce((to_jsonb(i)->>'review_count')::integer,0) AS review_count,i.imported_at::text,i.transaction_count,i.imported_count,i.duplicate_count,i.invalid_count,
                i.from_date::text,i.through_date::text
         FROM amex_imports i WHERE i.household_id=$1 ORDER BY i.imported_at DESC`,
        [householdId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        mappingVersion: row.mapping_version,
        importedAt: row.imported_at,
        count: row.transaction_count,
        reviewCount: row.review_count,
        added: row.imported_count,
        duplicates: row.duplicate_count,
        invalid: row.invalid_count,
        from: row.from_date,
        through: row.through_date,
      }));
    },
    async alertRules(householdId: string) {
      const result = await pool.query<{
        id: string;
        type: AmexAlertRule['type'];
        merchant: string | null;
        merchant_id: string | null;
        category: string | null;
        threshold_cents: string;
        enabled: boolean;
      }>(
        `SELECT r.id,r.type,r.merchant_id,m.name AS merchant,r.category,r.threshold_cents::text,r.enabled
         FROM amex_alert_rules r LEFT JOIN amex_merchants m ON m.household_id=r.household_id AND m.id=r.merchant_id
         WHERE r.household_id=$1 ORDER BY r.created_at DESC`,
        [householdId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        merchantId: row.merchant_id,
        merchant: row.merchant,
        category: row.category,
        thresholdCents: Number(row.threshold_cents),
        enabled: row.enabled,
      }));
    },
    async saveAlertRule(
      householdId: string,
      input: {
        type: AmexAlertRule['type'];
        merchantId?: string;
        category?: string;
        thresholdCents: number;
        enabled: boolean;
      },
    ) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO amex_alert_rules(household_id,type,merchant_id,category,threshold_cents,enabled)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          householdId,
          input.type,
          input.merchantId ?? null,
          input.category ?? null,
          input.thresholdCents,
          input.enabled,
        ],
      );
      return result.rows[0]?.id ?? null;
    },
    async updateAlertRule(
      householdId: string,
      id: string,
      input: {
        type: AmexAlertRule['type'];
        merchantId?: string;
        category?: string;
        thresholdCents: number;
        enabled: boolean;
      },
    ) {
      const result = await pool.query(
        `UPDATE amex_alert_rules SET type=$3,merchant_id=$4,category=$5,threshold_cents=$6,enabled=$7
         WHERE household_id=$1 AND id=$2`,
        [
          householdId,
          id,
          input.type,
          input.merchantId ?? null,
          input.category ?? null,
          input.thresholdCents,
          input.enabled,
        ],
      );
      return Boolean(result.rowCount);
    },
    async removeAlertRule(householdId: string, id: string) {
      const result = await pool.query(`DELETE FROM amex_alert_rules WHERE household_id=$1 AND id=$2`, [
        householdId,
        id,
      ]);
      return Boolean(result.rowCount);
    },
    async reevaluateAlerts(householdId: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        const rows = await this.list(householdId);
        const rules = await this.alertRules(householdId);
        const events = evaluateAmexRules(rows, rules);
        await client.query(`UPDATE amex_alert_events SET active=false WHERE household_id=$1`, [householdId]);
        for (const event of events)
          await client.query(
            `INSERT INTO amex_alert_events(household_id,rule_id,trigger_key,period_key,current_cents,threshold_cents)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(household_id,rule_id,trigger_key) DO UPDATE
           SET current_cents=EXCLUDED.current_cents,threshold_cents=EXCLUDED.threshold_cents,active=true`,
            [householdId, event.ruleId, event.key, event.period, event.currentCents, event.thresholdCents],
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async alertEvents(householdId: string) {
      const result = await pool.query<{
        id: string;
        rule_id: string;
        type: AmexAlertRule['type'];
        merchant: string | null;
        category: string | null;
        trigger_key: string;
        period_key: string;
        current_cents: string;
        threshold_cents: string;
        status: 'new' | 'seen' | 'dismissed';
        created_at: string;
      }>(
        `SELECT e.id,e.rule_id,r.type,m.name AS merchant,r.category,e.trigger_key,e.period_key,
         e.current_cents::text,e.threshold_cents::text,e.status,e.created_at::text
         FROM amex_alert_events e JOIN amex_alert_rules r ON r.household_id=e.household_id AND r.id=e.rule_id
         LEFT JOIN amex_merchants m ON m.household_id=r.household_id AND m.id=r.merchant_id
         WHERE e.household_id=$1 AND e.active=true ORDER BY e.created_at DESC`,
        [householdId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        type: row.type,
        merchant: row.merchant,
        category: row.category,
        key: row.trigger_key,
        period: row.period_key,
        currentCents: Number(row.current_cents),
        thresholdCents: Number(row.threshold_cents),
        status: row.status,
        createdAt: row.created_at,
      }));
    },
    async setAlertStatus(householdId: string, id: string, status: 'new' | 'seen' | 'dismissed') {
      const result = await pool.query(
        `UPDATE amex_alert_events SET status=$3 WHERE household_id=$1 AND id=$2 AND active=true`,
        [householdId, id, status],
      );
      return Boolean(result.rowCount);
    },
    async applyAiCategories(
      householdId: string,
      categoryNames: string[],
      classifications: Array<{ merchant: string; category: string }>,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const name of categoryNames) {
          if (!validCategoryName(name)) throw new Error('invalid_category');
          await client.query(
            `INSERT INTO amex_spending_categories(household_id,name,source) VALUES($1,$2,'ai') ON CONFLICT(household_id,name) DO NOTHING`,
            [householdId, name],
          );
        }
        let classified = 0;
        for (const { merchant, category } of classifications) {
          const result = await client.query(
            `INSERT INTO amex_merchant_categories(household_id,merchant,category,source)
             SELECT $1,$2,$3,'ai' WHERE EXISTS(SELECT 1 FROM amex_activity WHERE household_id=$1 AND merchant=$2)
             ON CONFLICT(household_id,merchant) DO UPDATE SET category=EXCLUDED.category,source='ai',updated_at=now()
             WHERE amex_merchant_categories.source <> 'user' RETURNING category`,
            [householdId, merchant, category],
          );
          if (result.rowCount && category !== needsReview) classified++;
        }
        await client.query('COMMIT');
        return classified;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async applyAiMerchantClassifications(
      householdId: string,
      categoryNames: string[],
      classifications: Array<{
        merchant: string;
        normalizedMerchant: string;
        category: string;
        confidence: number;
      }>,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [householdId]);
        for (const name of categoryNames) {
          if (!validCategoryName(name)) throw new Error('invalid_category');
          await client.query(
            `INSERT INTO amex_spending_categories(household_id,name,source) VALUES($1,$2,'ai')
             ON CONFLICT(household_id,name) DO NOTHING`,
            [householdId, name],
          );
        }
        let classified = 0;
        for (const { merchant, normalizedMerchant, category, confidence } of classifications) {
          if (!validMerchantName(normalizedMerchant)) throw new Error('invalid_merchant');
          const userDecision = await client.query(
            `SELECT 1 FROM amex_merchant_categories WHERE household_id=$1 AND merchant=$2 AND source='user'
             UNION ALL SELECT 1 FROM amex_merchant_aliases WHERE household_id=$1 AND source='user'
               AND ((match_type='exact' AND upper(pattern)=upper($2))
                 OR (match_type='prefix' AND starts_with(upper($2),upper(pattern)))) LIMIT 1`,
            [householdId, merchant],
          );
          if (userDecision.rowCount) continue;
          const current = await client.query<{ id: string; name: string }>(
            `SELECT id,name FROM amex_merchants WHERE household_id=$1 AND lower(name)=lower($2)`,
            [householdId, normalizedMerchant],
          );
          const target =
            current.rows[0] ??
            (
              await client.query<{ id: string; name: string }>(
                `INSERT INTO amex_merchants(household_id,name) VALUES($1,$2) RETURNING id,name`,
                [householdId, normalizedMerchant],
              )
            ).rows[0]!;
          const changed = await client.query(
            `UPDATE amex_activity SET merchant_id=$3,merchant=$4,merchant_source='ai',merchant_confidence=$5,merchant_review=false
             WHERE household_id=$1 AND merchant=$2 AND amount_cents > 0 AND merchant_source <> 'user'`,
            [householdId, merchant, target.id, target.name, confidence],
          );
          if (!changed.rowCount) continue;
          if (merchant !== target.name)
            await client.query(
              `INSERT INTO amex_merchant_aliases(household_id,merchant_id,pattern,match_type,source)
             VALUES($1,$2,$3,'exact','ai')
             ON CONFLICT(household_id,pattern,match_type) DO UPDATE SET merchant_id=EXCLUDED.merchant_id
             WHERE amex_merchant_aliases.source <> 'user'`,
              [householdId, target.id, merchant],
            );
          await client.query(
            `INSERT INTO amex_merchant_categories(household_id,merchant,category,source) VALUES($1,$2,$3,'ai')
             ON CONFLICT(household_id,merchant) DO UPDATE SET category=EXCLUDED.category,source='ai',updated_at=now()
             WHERE amex_merchant_categories.source <> 'user'`,
            [householdId, target.name, category],
          );
          classified++;
        }
        await client.query('COMMIT');
        return classified;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async summary(householdId: string) {
      return dashboard(await this.list(householdId));
    },
  };
}
export type AmexActivityStore = ReturnType<typeof postgresAmexActivity>;
