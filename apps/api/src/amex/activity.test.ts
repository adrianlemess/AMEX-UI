import { describe, expect, it } from 'vitest';
import {
  dashboard,
  amexCycleKey,
  amexCycleRange,
  activityKind,
  merchantName,
  previewActivity,
  type CategorizedActivity,
} from './activity.js';

const columns =
  'Datum,Beschreibung,Karteninhaber,Konto #,Betrag,Weitere Details,Erscheint auf Ihrer Abrechnung als,Adresse,Stadt,PLZ,Land,Betreff,Kategorie';
const row = (date: string, merchant: string, amount: string, reference: string) =>
  `${date},"${merchant}",Test Person,-00000,"${amount}",,"${merchant}","Address\nCity",,00000,DE,${reference},Miscellaneous-Other`;
const csv = (rows: string[]) => [columns, ...rows].join('\r\n');

describe('AMEX activity', () => {
  it('reads the original-style multiline German CSV, cents and credits without exposing personal fields', () => {
    const preview = previewActivity(
      csv([
        row('06/09/2026', 'AMZN MKTP DE*ABC123456 AMAZON', '17,99', 'r1'),
        row('28/09/2026', 'AMAZON.DE*XYZ987654 AMAZON', '-2,00', 'r2'),
        row('28/09/2026', 'UBER EATS HTTPS://HELP.UB', '48,77', 'r3'),
      ]),
    );
    expect(preview.count).toBe(3);
    expect(preview.from).toBe('2026-09-06');
    expect(preview.activities.map((a) => a.amountCents)).toEqual([1799, -200, 4877]);
    expect(preview.activities.map((a) => a.merchant)).toEqual(['Amazon', 'Amazon', 'Uber Eats']);
    expect(JSON.stringify(preview)).not.toContain('Test Person');
    expect(JSON.stringify(preview)).not.toContain('Address');
  });
  it('rejects duplicate references, changed schema, invalid dates and malformed quote grammar', () => {
    expect(
      previewActivity(
        csv([row('06/09/2026', 'Shop', '1,00', 'r1'), row('07/09/2026', 'Shop', '2,00', 'r1')]),
      ),
    ).toMatchObject({
      count: 2,
      invalidCount: 1,
      invalidRows: [{ record: 3, reason: 'duplicate_reference' }],
    });
    expect(previewActivity(csv([row('31/09/2026', 'Shop', '1,00', 'r1')])).invalidRows).toMatchObject([
      { reason: 'invalid_date' },
    ]);
    expect(previewActivity(csv([row('06/09/2026', 'Shop', '1.00', 'r1')])).invalidRows).toMatchObject([
      { reason: 'invalid_row' },
    ]);
    expect(() =>
      previewActivity(csv([row('06/09/2026', 'Shop', '1,00', 'r1').replace('"Shop"', '"Shop"evil')])),
    ).toThrow('invalid_csv');
    expect(() => previewActivity('other,columns\n1,2')).toThrow('unsupported_header');
  });
  it('keeps a stable fingerprint across irrelevant cardholder or address changes', () => {
    const source = csv([row('07/09/2026', 'Synthetic shop', '10,00', 'same')]);
    const changedPrivateFields = source
      .replace('Test Person', 'Other Holder')
      .replace('Address', 'Elsewhere');
    expect(previewActivity(source).activities[0]?.fingerprint).toBe(
      previewActivity(changedPrivateFields).activities[0]?.fingerprint,
    );
    expect(previewActivity(source.replace('Miscellaneous-Other', 'Other')).activities[0]?.fingerprint).toBe(
      previewActivity(source).activities[0]?.fingerprint,
    );
  });
  it('holds reference-free charges as separate identity decisions without retaining private CSV columns', () => {
    const preview = previewActivity(csv([
      row('06/09/2026', 'Synthetic shop', '10,00', ''),
      row('06/09/2026', 'Synthetic shop', '10,00', ''),
    ]));
    expect(preview.activities).toHaveLength(0);
    expect(preview.ambiguousRows).toMatchObject([
      { record: 2, amountCents: 1000, date: '2026-09-06' },
      { record: 3, amountCents: 1000, date: '2026-09-06' },
    ]);
    expect(preview.invalidCount).toBe(0);
    expect(preview.from).toBe('2026-09-06');
    expect(JSON.stringify(preview)).not.toContain('Test Person');
    expect(JSON.stringify(preview)).not.toContain('Address');
  });
  it('groups merchant variants without assigning a hardcoded category', () => {
    expect(merchantName('AMAZON.DE*N43YB3JG4     AMAZON.DE')).toBe('Amazon');
    expect(merchantName('AMZ*MARKETPLACE')).toBe('Amazon');
    expect(merchantName('UBER EATS               HTTPS://HELP.UB')).toBe('Uber Eats');
    expect(merchantName('SUMUP*WRAPUBLIC BERLIN- BERLIN')).toBe('SUMUP*WRAPUBLIC BERLIN- BERLIN');
    expect(merchantName('SYNTHETIC SUBSCRIPTION')).toBe('SYNTHETIC SUBSCRIPTION');
    expect(
      activityKind({ description: 'ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK', amountCents: -371438 }),
    ).toBe('card_payment');
    expect(activityKind({ description: 'Synthetic merchant return', amountCents: -500 })).toBe(
      'other_credit',
    );
  });
  it('groups nonadjacent statement periods and keeps credits separate', () => {
    const activities = previewActivity(
      csv([
        row('08/09/2026', 'Shop A', '25,00', 'r1'),
        row('09/09/2026', 'Shop A', '-5,00', 'r2'),
        row('08/03/2026', 'Shop B', '10,00', 'r3'),
      ]),
    ).activities;
    const report = dashboard(
      activities.map((a): CategorizedActivity => ({ ...a, category: 'Shopping', categorySource: 'rule' })),
    );
    expect(report.monthly.map((m) => m.month)).toEqual(['2026-03', '2026-09']);
    expect(report.monthly.every((m) => m.hasData)).toBe(true);
    expect(report.recentMonths).toEqual(['2026-03', '2026-09']);
    expect(report.totalSpendCents).toBe(3500);
    expect(report.totalOtherCreditsCents).toBe(500);
    expect(report.monthly.at(-1)?.topPurchases).toMatchObject([{ amountCents: 2500 }]);
    expect(report.merchants).toMatchObject([
      { name: 'SHOP A', cents: 2500, months: [0, 2500] },
      { name: 'SHOP B', cents: 1000, months: [1000, 0] },
    ]);
    expect(report.merchantTotals).toMatchObject([
      { name: 'SHOP A', cents: 2500 },
      { name: 'SHOP B', cents: 1000 },
    ]);
  });
  it('assigns the 6th to the previous statement period and the 7th to the next, across years', () => {
    expect(amexCycleKey('2026-09-06')).toBe('2026-08');
    expect(amexCycleKey('2026-09-07')).toBe('2026-09');
    expect(amexCycleKey('2026-01-06')).toBe('2025-12');
    expect(amexCycleKey('2026-01-07')).toBe('2026-01');
    expect(amexCycleRange('2025-12')).toEqual({ from: '2025-12-07', through: '2026-01-06' });
    const activities = previewActivity(
      csv([
        row('15/08/2026', 'August shop', '20,00', 'aug'),
        row('06/09/2026', 'September sixth', '26,00', 'sixth'),
        row('07/09/2026', 'September seventh', '50,00', 'seventh'),
        row('06/10/2026', 'October sixth', '10,00', 'oct-sixth'),
        row('10/09/2026', 'ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK', '-3714,38', 'payment'),
      ]),
    ).activities;
    const report = dashboard(
      activities.map((a): CategorizedActivity => ({
        ...a,
        category: 'Needs review',
        categorySource: 'unreviewed',
      })),
    );
    expect(
      report.monthly.map((m) => ({
        period: m.month,
        rows: m.count,
        purchases: m.spendCents,
      })),
    ).toEqual([
      { period: '2026-08', rows: 2, purchases: 4600 },
      { period: '2026-09', rows: 2, purchases: 6000 },
    ]);
    expect(report.merchants.find((m) => m.name === 'SEPTEMBER SIXTH')?.months).toEqual([2600, 0]);
    expect(report.merchants.find((m) => m.name === 'SEPTEMBER SEVENTH')?.months).toEqual([0, 5000]);
  });
  it('limits analysis to the latest two populated months without deleting historical rows', () => {
    const activities = previewActivity(
      csv([
        row('01/03/2026', 'Older shop', '90,00', 'old'),
        row('15/08/2026', 'August shop', '34,00', 'aug'),
        row('10/09/2026', 'ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK', '-3714,38', 'payment'),
        row('20/09/2026', 'September shop', '12,00', 'sep'),
      ]),
    ).activities;
    const report = dashboard(
      activities.map((a): CategorizedActivity => ({
        ...a,
        category: 'Needs review',
        categorySource: 'unreviewed',
      })),
    );
    expect(activities).toHaveLength(3);
    expect(report.monthly.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(report.monthly.map((m) => m.spendCents)).toEqual([3400, 1200]);
    expect(report.totalSpendCents).toBe(4600);
    expect(report.transactionCount).toBe(2);
    expect(report.merchantTotals.map((m) => m.name)).not.toContain('OLDER SHOP');
    expect(report.coverage).toEqual({
      from: '2026-08-15',
      through: '2026-09-20',
      monthsWithData: ['2026-08', '2026-09'],
    });
  });
  it('shows a single September month when the export contains no August rows', () => {
    const activities = previewActivity(
      csv([
        row('10/09/2026', 'ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK', '-3714,38', 'payment'),
        row('20/09/2026', 'September shop', '12,00', 'sep'),
      ]),
    ).activities;
    const report = dashboard(
      activities.map((a): CategorizedActivity => ({
        ...a,
        category: 'Needs review',
        categorySource: 'unreviewed',
      })),
    );
    expect(report.monthly.map((m) => m.month)).toEqual(['2026-09']);
    expect(report.merchants[0]?.months).toEqual([1200]);
  });
  it('excludes a card payment from purchases, categories, and merchants without calling it a refund', () => {
    const activities = previewActivity(
      csv([
        row('10/09/2026', 'ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK', '-3714,38', 'payment'),
        row('11/09/2026', 'Shop A', '25,00', 'purchase'),
      ]),
    ).activities;
    const report = dashboard(
      activities.map((a): CategorizedActivity => ({
        ...a,
        category: 'Needs review',
        categorySource: 'unreviewed',
      })),
    );
    expect(report.totalSpendCents).toBe(2500);
    expect(report.totalOtherCreditsCents).toBe(0);
    expect(report.categories).toEqual([{ name: 'Needs review', cents: 2500 }]);
    expect(report.merchants).toEqual([{ name: 'SHOP A', cents: 2500, months: [2500] }]);
    expect(report.monthly.at(-1)?.purchaseCount).toBe(1);
  });
});
