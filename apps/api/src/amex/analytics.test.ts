import { describe, expect, it } from 'vitest';
import {
  amexAnalytics,
  detectRecurring,
  evaluateAmexRules,
  previousAmexRange,
  type AmexRow,
} from './analytics.js';

const row = (
  reference: string,
  date: string,
  merchant: string,
  category: string,
  amountCents: number,
): AmexRow => ({
  reference,
  date,
  merchant,
  category,
  amountCents,
  description: merchant,
  sourceCategory: '',
  fingerprint: reference.padEnd(64, '0'),
  categorySource: 'rule',
});

describe('isolated AMEX analytics', () => {
  it('compares equivalent 7th–6th periods and excludes payments and credits', () => {
    const records = [
      row('older', '2026-08-07', 'Shop', 'Shopping', 4000),
      row('new', '2026-09-07', 'Shop', 'Shopping', 6000),
      row('food', '2026-10-06', 'Market', 'Groceries', 3000),
      row('payment', '2026-09-10', 'Payment', 'Other', -8000),
    ];
    records[3]!.description = 'ZAHLUNG/TEST ERHALTEN BESTEN DANK';
    expect(previousAmexRange('2026-09-07', '2026-10-06')).toEqual({
      from: '2026-08-07',
      through: '2026-09-06',
    });
    const result = amexAnalytics(records, { from: '2026-09-07', through: '2026-10-06' }, [
      { from: '2026-08-07', through: '2026-09-06' },
      { from: '2026-09-07', through: '2026-10-06' },
    ]);
    expect(result.totalCents).toBe(9000);
    expect(result.previousCents).toBe(4000);
    expect(result.changeCents).toBe(5000);
    expect(result.categoryChanges.find((item) => item.name === 'Shopping')).toMatchObject({
      name: 'Shopping',
      changeCents: 2000,
    });
    expect(result.merchantChanges[0]).toMatchObject({ name: 'Market', changeCents: 3000 });
    expect(result.monthly).toMatchObject([{ key: '2026-09', cents: 9000 }]);
    expect(result.insights.map((item) => item.type)).toEqual(['top_category', 'top_merchant', 'change']);
    expect(result.distribution.reduce((count, bucket) => count + bucket.count, 0)).toBe(2);
  });
  it('marks absent comparison data unknown rather than asserting a zero baseline', () => {
    const result = amexAnalytics([row('new', '2026-09-08', 'Shop', 'Shopping', 1100)], {
      from: '2026-09-07',
      through: '2026-10-06',
    });
    expect(result.period.canCompare).toBe(false);
    expect(result.previousCents).toBeNull();
    expect(result.changeCents).toBeNull();
    expect(result.insights.map((item) => item.type)).toEqual(['top_category', 'top_merchant']);
    expect(result.insights.map((item) => item.text).join(' ')).not.toMatch(/previous|increase|decrease/i);
    expect(amexAnalytics([], { from: '2026-09-07', through: '2026-10-06' }).insights).toEqual([]);
    const partial = amexAnalytics(
      [
        row('old', '2026-08-18', 'Shop', 'Shopping', 1000),
        row('new', '2026-09-08', 'Shop', 'Shopping', 1100),
      ],
      { from: '2026-09-07', through: '2026-10-06' },
      [{ from: '2026-08-18', through: '2026-09-06' }],
    );
    expect(partial.previousCents).toBeNull();
  });
  it('keeps payment and credit rows out of the needs-review transaction filter', () => {
    const purchase = row('purchase', '2026-09-08', 'Unknown', 'Needs review', 1200);
    const payment = row('payment', '2026-09-09', 'Payment', 'Needs review', -3000);
    payment.description = 'ZAHLUNG/TEST ERHALTEN BESTEN DANK';
    const report = amexAnalytics([purchase, payment], {
      from: '2026-09-07',
      through: '2026-10-06',
      category: 'Needs review',
    });
    expect(report.transactionCount).toBe(1);
  });
  it('applies shared date and merchant filters to recurring candidates without losing their history', () => {
    const records = [
      row('a', '2026-06-15', 'Service', 'Subscriptions', 1099),
      row('b', '2026-07-15', 'Service', 'Subscriptions', 1099),
      row('c', '2026-08-15', 'Service', 'Subscriptions', 1299),
      row('d', '2026-08-16', 'Other', 'Shopping', 900),
    ];
    for (const item of records.slice(0, 3)) item.recurring = true;
    const range = { from: '2026-08-07', through: '2026-09-06' };
    expect(amexAnalytics(records, { ...range, merchant: 'Service' }).recurring).toMatchObject([
      { merchant: 'Service', count: 3 },
    ]);
    expect(amexAnalytics(records, { ...range, merchant: 'Other' }).recurring).toEqual([]);
    expect(amexAnalytics(records, { ...range, recurring: false }).recurring).toEqual([]);
  });
  it('requires three earlier same-merchant purchases before flagging an unusual amount', () => {
    const records = [
      row('a', '2026-05-10', 'Service', 'Services', 1000),
      row('b', '2026-06-10', 'Service', 'Services', 1100),
      row('c', '2026-07-10', 'Service', 'Services', 1200),
      row('d', '2026-08-10', 'Other', 'Services', 100),
      row('e', '2026-09-10', 'Service', 'Services', 9000),
      row('f', '2026-09-12', 'Other', 'Services', 9000),
    ];
    expect(amexAnalytics(records, { from: '2026-09-07', through: '2026-10-06' }).anomalies).toEqual([
      { reference: 'e', merchant: 'Service', amountCents: 9000, historicalMedianCents: 1100, baselineCount: 3 },
    ]);
  });
  it('finds conservative recurrence with a price change, not two coincidental charges', () => {
    const records = [
      row('a', '2026-06-15', 'Service', 'Subscriptions', 1099),
      row('b', '2026-07-15', 'Service', 'Subscriptions', 1099),
      row('c', '2026-08-15', 'Service', 'Subscriptions', 1299),
      row('d', '2026-08-16', 'Other', 'Subscriptions', 1099),
    ];
    expect(detectRecurring(records)).toMatchObject([
      { merchant: 'Service', frequency: 'monthly', priceChangeCents: 200, count: 3 },
    ]);
    expect(
      detectRecurring([
        row('x', '2026-06-15', 'Variable shop', 'Shopping', 1000),
        row('y', '2026-07-15', 'Variable shop', 'Shopping', 1050),
        row('z', '2026-08-15', 'Variable shop', 'Shopping', 1000),
        row('w', '2026-09-15', 'Variable shop', 'Shopping', 10000),
      ]),
    ).toEqual([]);
  });
  it('evaluates threshold events once per rule+cycle or source reference', () => {
    const records = [
      row('a', '2026-09-07', 'Shop', 'Shopping', 3000),
      row('b', '2026-10-06', 'Shop', 'Shopping', 2500),
    ];
    expect(
      evaluateAmexRules(records, [
        { id: 'merchant', type: 'merchant_monthly', merchant: 'Shop', thresholdCents: 5000, enabled: true },
        {
          id: 'category',
          type: 'category_monthly',
          category: 'Shopping',
          thresholdCents: 6000,
          enabled: true,
        },
        { id: 'single', type: 'transaction_amount', thresholdCents: 2600, enabled: true },
      ]),
    ).toMatchObject([
      { ruleId: 'merchant', key: 'cycle:2026-09', currentCents: 5500 },
      { ruleId: 'single', key: 'transaction:a', currentCents: 3000 },
    ]);
  });
  it('does not join the 6th and 7th into one alert cycle or net a card settlement', () => {
    const payment = row('payment', '2026-10-07', 'Shop', 'Shopping', -8000);
    payment.description = 'ZAHLUNG/TEST ERHALTEN BESTEN DANK';
    const events = evaluateAmexRules([
      row('old', '2026-10-06', 'Shop', 'Shopping', 3500),
      row('new', '2026-10-07', 'Shop', 'Shopping', 3500), payment,
    ], [
      { id: 'merchant', type: 'merchant_monthly', merchant: 'Shop', thresholdCents: 4000, enabled: true },
      { id: 'single', type: 'transaction_amount', thresholdCents: 3000, enabled: true },
    ]);
    expect(events.map((event) => event.key)).toEqual(['transaction:old', 'transaction:new']);
  });
});
