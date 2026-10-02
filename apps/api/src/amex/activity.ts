import { createHash } from 'node:crypto';
import { parseCsvRecords } from '../shared/csv.js';

export const needsReview = 'Needs review';
export type Category = string;
export function validCategoryName(name: string): boolean {
  return (
    name.toLowerCase() !== needsReview.toLowerCase() &&
    /^[A-Za-z][A-Za-z &/-]{1,47}$/.test(name) &&
    name.trim() === name
  );
}
export interface Activity {
  reference: string;
  date: string;
  description: string;
  merchant: string;
  amountCents: number;
  sourceCategory: string;
  fingerprint: string;
  cardLast4?: string | null;
}
export type AmbiguousActivity = Omit<Activity, 'reference' | 'fingerprint'> & { record: number };
export type ActivityKind = 'purchase' | 'card_payment' | 'other_credit';
/** The AMEX statement period starts on the 7th and ends on the following month's 6th. */
export function amexCycleKey(date: string): string {
  if (Number(date.slice(8, 10)) >= 7) return date.slice(0, 7);
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 2, 1))
    .toISOString()
    .slice(0, 7);
}
export function amexCycleRange(key: string) {
  const [year, month] = key.split('-').map(Number);
  return { from: `${key}-07`, through: new Date(Date.UTC(year!, month!, 6)).toISOString().slice(0, 10) };
}
export function activityKind(row: Pick<Activity, 'description' | 'amountCents'>): ActivityKind {
  if (row.amountCents >= 0) return 'purchase';
  // This is the AMEX payment posting, not a merchant return. Keep future unfamiliar credits separate.
  if (
    /^ZAHLUNG\/.*ERHALTEN\s+BESTEN\s+DANK/i.test(row.description.trim()) ||
    /^PAYMENT (RECEIVED|THANK YOU)/i.test(row.description.trim())
  )
    return 'card_payment';
  return 'other_credit';
}
const header = [
  'Datum',
  'Beschreibung',
  'Karteninhaber',
  'Konto #',
  'Betrag',
  'Weitere Details',
  'Erscheint auf Ihrer Abrechnung als',
  'Adresse',
  'Stadt',
  'PLZ',
  'Land',
  'Betreff',
  'Kategorie',
];

export function merchantName(description: string): string {
  const name = description.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^(?:AMZN|AMZ\*|AMAZON(?:\b|[.*]))/.test(name)) return 'Amazon';
  if (/^UBER\s*EATS/.test(name)) return 'Uber Eats';
  if (/^UBER\b/.test(name)) return 'Uber';
  if (/^VOI\b/.test(name)) return 'Voi';
  if (/^PAYPAL\s*\*/.test(name))
    return (
      name
        .replace(/^PAYPAL\s*\*/, '')
        .split(/\s{2,}|\sHTTPS?:/)[0]!
        .slice(0, 60) || 'PayPal'
    );
  if (/^APPLE\.COM|^APPLE COM/.test(name)) return 'Apple';
  // Strip common payment-specific IDs, URLs and terminal/location suffixes, not arbitrary merchant words.
  return (
    name
      .replace(/\s+HTTPS?:\/\/.*$/, '')
      // A word after * can be the actual merchant (SUMUP*WRAPUBLIC); strip only ID-like tokens.
      .replace(/\*(?=[A-Z0-9]*\d)[A-Z0-9]{8,}.*$/, '')
      .replace(/\s+(?=[A-Z0-9]{10,}$)(?=[A-Z0-9]*\d)[A-Z0-9]+$/, '')
      .slice(0, 80)
      .trim() || 'Unknown merchant'
  );
}

export function previewActivity(csv: string) {
  if (Buffer.byteLength(csv, 'utf8') > 1_000_000) throw new Error('too_large');
  const rows = parseCsvRecords(csv.replace(/^\uFEFF/, ''));
  if (rows.shift()?.join('\u0000') !== header.join('\u0000')) throw new Error('unsupported_header');
  const seen = new Set<string>();
  const activities: Activity[] = [];
  const ambiguousRows: AmbiguousActivity[] = [];
  let excludedPayments = 0;
  const invalidRows: Array<{ record: number; reason: string }> = [];
  rows.forEach((row, index) => {
    try {
      if (row.length !== header.length) throw new Error('invalid_row');
      const [day, month, year] = /^([0-3]\d)\/(0[1-9]|1[0-2])\/(20\d{2})$/.exec(row[0]!)?.slice(1) ?? [];
      const date = `${year}-${month}-${day}`;
      if (!year || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
        throw new Error('invalid_date');
      const amount = /^(-?)(\d{1,9}),(\d{2})$/.exec(row[4]!.trim());
      if (!amount || row[11]!.length > 150 || !row[1]?.trim() || row[1].length > 300)
        throw new Error('invalid_row');
      const reference = row[11]!.trim();
      const amountCents = (amount[1] ? -1 : 1) * (Number(amount[2]) * 100 + Number(amount[3]));
      const description = row[1].trim();
      const account = row[3]!.trim();
      const cardLast4 = /^-?\d{4,19}$/.test(account) ? account.slice(-4) : null;
      if (activityKind({ description, amountCents }) === 'card_payment') {
        excludedPayments++;
        return;
      }
      if (reference && seen.has(reference)) throw new Error('duplicate_reference');
      if (reference) seen.add(reference);
      if (!reference) {
        ambiguousRows.push({ record: index + 2, date, description, merchant: merchantName(description),
          amountCents, sourceCategory: row[12]!.trim(), cardLast4 });
        return;
      }
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([reference, date, amountCents, description, cardLast4, 'EUR']))
        .digest('hex');
      activities.push({
        reference,
        date,
        description,
        merchant: merchantName(description),
        amountCents,
        sourceCategory: row[12]!.trim(),
        fingerprint,
        cardLast4,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['invalid_row', 'invalid_date', 'duplicate_reference'].includes(error.message)
      )
        throw error;
      if (invalidRows.length < 20) invalidRows.push({ record: index + 2, reason: error.message });
    }
  });
  return {
    activities,
    ambiguousRows,
    hash: createHash('sha256').update(csv).digest('hex'),
    count: rows.length,
    invalidCount: rows.length - activities.length - ambiguousRows.length - excludedPayments,
    excludedPayments,
    invalidRows,
    from: [...activities, ...ambiguousRows].map((a) => a.date).sort()[0] ?? null,
    through:
      [...activities, ...ambiguousRows]
        .map((a) => a.date)
        .sort()
        .at(-1) ?? null,
  };
}

export interface CategorizedActivity extends Activity {
  category: Category;
  categorySource: 'rule' | 'user' | 'ai' | 'suggested' | 'unreviewed';
}
export function dashboard(rows: CategorizedActivity[], asOf = new Date().toISOString().slice(0, 10)) {
  const recent = [...new Set(rows.map((r) => amexCycleKey(r.date)))].sort().slice(-2);
  const visibleRows = rows.filter((r) => recent.includes(amexCycleKey(r.date)));
  const purchases = visibleRows.filter((r) => activityKind(r) === 'purchase');
  const spend = (r: CategorizedActivity) => (activityKind(r) === 'purchase' ? r.amountCents : 0);
  const group = (items: CategorizedActivity[], key: (r: CategorizedActivity) => string) => {
    const totals = new Map<string, number>();
    for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + spend(item));
    return [...totals]
      .map(([name, cents]) => ({ name, cents }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  };
  const monthly = recent.map((month) => {
    const allItems = visibleRows.filter((r) => amexCycleKey(r.date) === month);
    const items = allItems.filter((r) => activityKind(r) === 'purchase');
    return {
      month,
      hasData: true,
      spendCents: items.reduce((sum, r) => sum + spend(r), 0),
      otherCreditsCents: allItems
        .filter((r) => activityKind(r) === 'other_credit')
        .reduce((sum, r) => sum - r.amountCents, 0),
      count: allItems.length,
      purchaseCount: items.length,
      categories: group(items, (r) => r.category),
      merchants: group(items, (r) => r.merchant),
      topPurchases: [...items]
        .filter((r) => r.amountCents > 0)
        .sort((a, b) => b.amountCents - a.amountCents)
        .slice(0, 5)
        .map(({ date, merchant, amountCents }) => ({ date, merchant, amountCents })),
    };
  });
  const merchants = group(purchases, (r) => r.merchant)
    .slice(0, 10)
    .map((item) => ({
      ...item,
      months: recent.map((month) => {
        const items = purchases.filter((r) => r.merchant === item.name && amexCycleKey(r.date) === month);
        return items.reduce((sum, r) => sum + spend(r), 0);
      }),
    }));
  return {
    asOf,
    currency: 'EUR',
    coverage: {
      from: visibleRows.map((r) => r.date).sort()[0] ?? null,
      through:
        visibleRows
          .map((r) => r.date)
          .sort()
          .at(-1) ?? null,
      monthsWithData: recent,
    },
    monthly,
    categories: group(purchases, (r) => r.category),
    merchantTotals: group(purchases, (r) => r.merchant),
    merchants,
    recentMonths: recent,
    uncategorized: purchases.filter((r) => r.category === needsReview).length,
    totalSpendCents: purchases.reduce((sum, r) => sum + spend(r), 0),
    totalOtherCreditsCents: visibleRows
      .filter((r) => activityKind(r) === 'other_credit')
      .reduce((sum, r) => sum - r.amountCents, 0),
    purchaseCount: purchases.length,
    transactionCount: visibleRows.length,
  };
}
