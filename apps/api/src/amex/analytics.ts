import {
  activityKind,
  amexCycleKey,
  amexCycleRange,
  needsReview,
  type CategorizedActivity,
} from './activity.js';

export interface AmexFilters {
  from: string;
  through: string;
  merchant?: string;
  category?: string;
  minCents?: number;
  maxCents?: number;
  recurring?: boolean;
  search?: string;
  cardLast4?: string;
}
export interface AmexRow extends CategorizedActivity {
  merchantId?: string | null;
  recurring?: boolean;
  categoryOverride?: string | null;
}
export interface AmexAlertRule {
  id: string;
  type: 'merchant_monthly' | 'category_monthly' | 'transaction_amount';
  merchant?: string | null;
  category?: string | null;
  thresholdCents: number;
  enabled: boolean;
}

const sum = (rows: AmexRow[]) => rows.reduce((total, row) => total + row.amountCents, 0);
const purchases = (rows: AmexRow[]) => rows.filter((row) => activityKind(row) === 'purchase');
const shiftDay = (date: string, difference: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + difference * 86_400_000).toISOString().slice(0, 10);
const datesBetween = (from: string, through: string) => {
  const dates: string[] = [];
  for (let current = from; current <= through; current = shiftDay(current, 1)) dates.push(current);
  return dates;
};
const centsBy = (rows: AmexRow[], key: (row: AmexRow) => string) => {
  const totals = new Map<string, { name: string; cents: number; count: number }>();
  for (const row of rows) {
    const name = key(row);
    const value = totals.get(name) ?? { name, cents: 0, count: 0 };
    value.cents += row.amountCents;
    value.count++;
    totals.set(name, value);
  }
  return [...totals.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
};

export function filterAmex(rows: AmexRow[], filter: AmexFilters): AmexRow[] {
  const query = filter.search?.trim().toLowerCase();
  return rows.filter(
    (row) =>
      activityKind(row) !== 'card_payment' && row.date >= filter.from &&
      row.date <= filter.through &&
      (!filter.cardLast4 || row.cardLast4 === filter.cardLast4) &&
      (!filter.merchant || row.merchant === filter.merchant) &&
      (!filter.category ||
        (row.category === filter.category &&
          (filter.category !== needsReview || activityKind(row) === 'purchase'))) &&
      (filter.minCents === undefined || row.amountCents >= filter.minCents) &&
      (filter.maxCents === undefined || row.amountCents <= filter.maxCents) &&
      (filter.recurring === undefined || Boolean(row.recurring) === filter.recurring) &&
      (!query || row.merchant.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)),
  );
}

/** Calendar-safe comparisons: complete cycles compare to the same number of prior cycles. */
export function previousAmexRange(from: string, through: string) {
  if (
    from.endsWith('-07') &&
    through.endsWith('-06') &&
    amexCycleRange(amexCycleKey(through)).through === through
  ) {
    const first = amexCycleKey(from);
    const last = amexCycleKey(through);
    const cycles =
      (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
      Number(last.slice(5, 7)) -
      Number(first.slice(5, 7)) +
      1;
    if (cycles > 0) {
      const start = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1 - cycles, 7));
      return { from: start.toISOString().slice(0, 10), through: shiftDay(from, -1) };
    }
  }
  const days =
    Math.round((Date.parse(`${through}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
  return { from: shiftDay(from, -days), through: shiftDay(from, -1) };
}

export function detectRecurring(rows: AmexRow[]) {
  const groups = new Map<string, AmexRow[]>();
  for (const row of purchases(rows)) groups.set(row.merchant, [...(groups.get(row.merchant) ?? []), row]);
  return [...groups.entries()]
    .flatMap(([merchant, charges]) => {
      const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
      if (sorted.length < 3) return [];
      const gaps = sorted
        .slice(1)
        .map((row, index) =>
          Math.round(
            (Date.parse(`${row.date}T12:00:00Z`) - Date.parse(`${sorted[index]!.date}T12:00:00Z`)) /
              86_400_000,
          ),
        );
      const monthly = gaps.every((gap) => gap >= 25 && gap <= 35);
      const weekly = gaps.every((gap) => gap >= 6 && gap <= 8);
      if (!monthly && !weekly) return [];
      const amounts = sorted.map((row) => row.amountCents).sort((a, b) => a - b);
      const median = amounts[Math.floor(amounts.length / 2)]!;
      const tolerance = Math.max(200, median * 0.2);
      if (
        sorted.filter((row) => Math.abs(row.amountCents - median) <= tolerance).length <
          Math.max(3, Math.ceil(sorted.length * 0.8)) ||
        Math.abs(sorted.at(-1)!.amountCents - median) > tolerance
      )
        return [];
      const last = sorted.at(-1)!;
      const previous = sorted.at(-2)!;
      return [
        {
          merchant,
          merchantId: sorted[0]!.merchantId ?? null,
          frequency: monthly ? ('monthly' as const) : ('weekly' as const),
          estimatedCents: median,
          monthlyCents: monthly ? median : Math.round((median * 52) / 12),
          annualCents: monthly ? median * 12 : median * 52,
          firstCharge: sorted[0]!.date,
          lastCharge: last.date,
          lastAmountCents: last.amountCents,
          previousAmountCents: previous.amountCents,
          priceChangeCents: last.amountCents - previous.amountCents,
          count: sorted.length,
          references: sorted.map((row) => row.reference),
        },
      ];
    })
    .sort((a, b) => b.monthlyCents - a.monthlyCents);
}

export function evaluateAmexRules(rows: AmexRow[], rules: AmexAlertRule[]) {
  const eligible = purchases(rows);
  type Event = {
    ruleId: string;
    key: string;
    period: string;
    currentCents: number;
    thresholdCents: number;
    reference: string | null;
  };
  return rules
    .filter((rule) => rule.enabled)
    .flatMap((rule): Event[] => {
      if (rule.type === 'transaction_amount')
        return eligible
          .filter((row) => row.amountCents > rule.thresholdCents)
          .map((row) => ({
            ruleId: rule.id,
            key: `transaction:${row.reference}`,
            period: amexCycleKey(row.date),
            currentCents: row.amountCents,
            thresholdCents: rule.thresholdCents,
            reference: row.reference,
          }));
      const matched = eligible.filter((row) =>
        rule.type === 'merchant_monthly' ? row.merchant === rule.merchant : row.category === rule.category,
      );
      const totals = centsBy(matched, (row) => amexCycleKey(row.date));
      return totals
        .filter((item) => item.cents > rule.thresholdCents)
        .map((item) => ({
          ruleId: rule.id,
          key: `cycle:${item.name}`,
          period: item.name,
          currentCents: item.cents,
          thresholdCents: rule.thresholdCents,
          reference: null,
        }));
    });
}

export function amexAnalytics(
  rows: AmexRow[],
  filter: AmexFilters,
  imports: Array<{ from: string | null; through: string | null }> = [],
) {
  const all = filterAmex(rows, filter);
  const selected = purchases(all);
  const previous = previousAmexRange(filter.from, filter.through);
  const previousPurchases = purchases(filterAmex(rows, { ...filter, ...previous }));
  const observedCycles = new Set(rows.map((row) => amexCycleKey(row.date)));
  // Row presence alone cannot establish comparison coverage. Provenance records the
  // observed export span, but even full endpoints cannot prove a CSV had no gaps.
  const canCompare =
    imports.length > 0 &&
    datesBetween(previous.from, previous.through).every((date) =>
      imports.some((batch) => batch.from && batch.through && batch.from <= date && batch.through >= date),
    );
  const totalCents = sum(selected);
  const categories = centsBy(selected, (row) => row.category);
  const merchants = centsBy(selected, (row) => row.merchant);
  const precedingCategories = new Map(
    centsBy(previousPurchases, (row) => row.category).map((x) => [x.name, x.cents]),
  );
  const precedingMerchants = new Map(
    centsBy(previousPurchases, (row) => row.merchant).map((x) => [x.name, x.cents]),
  );
  const deltas = (current: typeof categories, prior: Map<string, number>) =>
    [...new Set([...current.map((x) => x.name), ...prior.keys()])]
      .map((name) => ({
        name,
        currentCents: current.find((x) => x.name === name)?.cents ?? 0,
        previousCents: prior.get(name) ?? 0,
        changeCents: (current.find((x) => x.name === name)?.cents ?? 0) - (prior.get(name) ?? 0),
      }))
      .sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents));
  const categoryChanges = canCompare ? deltas(categories, precedingCategories) : [];
  const merchantChanges = canCompare ? deltas(merchants, precedingMerchants) : [];
  const groupByCycle = centsBy(selected, (row) => amexCycleKey(row.date));
  const cycles = datesBetween(filter.from, filter.through)
    .map(amexCycleKey)
    .filter((key, index, list) => index === 0 || key !== list[index - 1]);
  const monthly = cycles.map((key) => ({
    key,
    ...amexCycleRange(key),
    cents: groupByCycle.find((item) => item.name === key)?.cents ?? 0,
    hasData: observedCycles.has(key),
    categories: centsBy(
      selected.filter((row) => amexCycleKey(row.date) === key),
      (row) => row.category,
    ),
  }));
  const dailyTotals = new Map<string, { cents: number; count: number }>();
  const byDay = Array.from({ length: 7 }, (_, day) => ({ day, cents: 0, count: 0 }));
  for (const row of selected) {
    const entry = dailyTotals.get(row.date) ?? { cents: 0, count: 0 };
    entry.cents += row.amountCents;
    entry.count++;
    dailyTotals.set(row.date, entry);
    const weekday = byDay[new Date(`${row.date}T12:00:00Z`).getUTCDay()]!;
    weekday.cents += row.amountCents;
    weekday.count++;
  }
  const daily = datesBetween(filter.from, filter.through).map((date) => ({
    date,
    cents: dailyTotals.get(date)?.cents ?? 0,
    count: dailyTotals.get(date)?.count ?? 0,
  }));
  const edges = [0, 1000, 2500, 5000, 10000, 25000, 50000, Infinity];
  const distribution = edges.slice(0, -1).map((lower, index) => {
    const included = selected.filter(
      (row) => row.amountCents >= lower && row.amountCents < edges[index + 1]!,
    );
    return {
      fromCents: lower,
      throughCents: edges[index + 1] === Infinity ? null : edges[index + 1]!,
      count: included.length,
      cents: sum(included),
    };
  });
  const concentration = [1, 3, 5, 10].map((count) => ({
    count,
    cents: merchants.slice(0, count).reduce((amount, item) => amount + item.cents, 0),
    percent: totalCents
      ? Math.round(
          (1000 * merchants.slice(0, count).reduce((amount, item) => amount + item.cents, 0)) / totalCents,
        ) / 10
      : 0,
  }));
  const merchantDetails = merchants.map((merchant) => {
    const history = purchases(rows).filter((row) => row.merchant === merchant.name);
    const selectedHistory = selected.filter((row) => row.merchant === merchant.name);
    const dates = history.map((row) => row.date).sort();
    return {
      name: merchant.name,
      cents: merchant.cents,
      count: merchant.count,
      averageCents: Math.round(merchant.cents / merchant.count),
      largestCents: Math.max(...selectedHistory.map((row) => row.amountCents)),
      sharePercent: totalCents ? Math.round((1000 * merchant.cents) / totalCents) / 10 : 0,
      first: dates[0] ?? null,
      last: dates.at(-1) ?? null,
      variants: centsBy(history, (row) => row.description).map((item) => ({
        name: item.name,
        count: item.count,
      })),
      monthly: monthly.map((cycle) => ({
        key: cycle.key,
        cents: sum(selectedHistory.filter((row) => amexCycleKey(row.date) === cycle.key)),
      })),
    };
  });
  const categoryDetails = categories.map((category) => ({
    name: category.name,
    cents: category.cents,
    count: category.count,
    sharePercent: totalCents ? Math.round((1000 * category.cents) / totalCents) / 10 : 0,
    merchants: centsBy(
      selected.filter((row) => row.category === category.name),
      (row) => row.merchant,
    ),
    monthly: monthly.map((cycle) => ({
      key: cycle.key,
      cents: cycle.categories.find((item) => item.name === category.name)?.cents ?? 0,
    })),
  }));
  const selectedReferences = new Set(selected.map((row) => row.reference));
  const recurring = detectRecurring(rows).filter((candidate) =>
    candidate.references.some((reference) => selectedReferences.has(reference)),
  );
  const median =
    selected.map((row) => row.amountCents).sort((a, b) => a - b)[Math.floor(selected.length / 2)] ?? 0;
  const historical = purchases(rows.filter((row) => row.date < filter.from));
  const historicalByMerchant = new Map<string, number[]>();
  for (const row of historical)
    historicalByMerchant.set(row.merchant, [...(historicalByMerchant.get(row.merchant) ?? []), row.amountCents]);
  const anomalies = selected.flatMap((row) => {
    const amounts = historicalByMerchant.get(row.merchant);
    if (!amounts || amounts.length < 3) return [];
    const ordered = [...amounts].sort((a, b) => a - b);
    const historicalMedianCents = ordered[Math.floor(ordered.length / 2)]!;
    if (row.amountCents <= historicalMedianCents * 2.5 || row.amountCents <= historicalMedianCents + 5000)
      return [];
    return [{ reference: row.reference, merchant: row.merchant, amountCents: row.amountCents,
      historicalMedianCents, baselineCount: amounts.length }];
  });
  const previousCents = canCompare ? sum(previousPurchases) : null;
  const euros = (cents: number) =>
    new Intl.NumberFormat('en-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const insights: Array<{
    type: string;
    text: string;
    changeCents?: number;
    category?: string | null;
    merchant?: string | null;
  }> = [];
  if (selected.length && categories[0])
    insights.push({
      type: 'top_category',
      text: `${categories[0].name} accounts for ${euros(categories[0].cents)} across ${categories[0].count} of ${selected.length} observed purchases in this selection.`,
      category: categories[0].name,
    });
  if (selected.length && merchants[0])
    insights.push({
      type: 'top_merchant',
      text: `${merchants[0].name} is the largest merchant in this selection at ${euros(merchants[0].cents)} across ${merchants[0].count} purchases.`,
      merchant: merchants[0].name,
    });
  if (canCompare && previousCents !== null)
    insights.push({
      type: 'change',
      text: `Observed spending ${totalCents >= previousCents ? 'increased' : 'decreased'} by ${euros(Math.abs(totalCents - previousCents))} versus the preceding comparable period.`,
      changeCents: totalCents - previousCents,
      category: categoryChanges[0]?.name ?? null,
      merchant: merchantChanges[0]?.name ?? null,
    });
  if (anomalies.length)
    insights.push({
      type: 'historical_outliers',
      text: `${anomalies.length} purchase${anomalies.length === 1 ? '' : 's'} exceeded 2.5 times the same merchant's earlier median by more than €50, based on at least three previous charges per merchant.`,
    });
  return {
    period: { from: filter.from, through: filter.through, previous, canCompare },
    coverage: {
      from:
        imports
          .map((r) => r.from)
          .filter((v): v is string => Boolean(v))
          .sort()[0] ?? null,
      through:
        imports
          .map((r) => r.through)
          .filter((v): v is string => Boolean(v))
          .sort()
          .at(-1) ?? null,
      partialPossible: true,
    },
    totalCents,
    transactionCount: selected.length,
    averageCents: selected.length ? Math.round(totalCents / selected.length) : 0,
    largest: [...selected].sort((a, b) => b.amountCents - a.amountCents)[0] ?? null,
    activeMerchants: merchants.length,
    medianCents: median,
    previousCents,
    changeCents: previousCents === null ? null : totalCents - previousCents,
    changePercent: previousCents
      ? Math.round((1000 * (totalCents - previousCents)) / previousCents) / 10
      : null,
    categories,
    merchants,
    merchantDetails,
    categoryDetails,
    categoryChanges,
    merchantChanges,
    monthly,
    daily,
    byDay,
    distribution,
    concentration,
    recurring,
    estimatedMonthlyRecurringCents: recurring.reduce((amount, item) => amount + item.monthlyCents, 0),
    anomalies,
    insights,
    otherCreditsCents: Math.abs(sum(all.filter((row) => activityKind(row) === 'other_credit'))),
  };
}
