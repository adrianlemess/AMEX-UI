import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../locales';
import './amex.css';

type Group = { name: string; cents: number; count: number };
type Row = {
  reference: string;
  date: string;
  description: string;
  merchant: string;
  merchantId: string | null;
  merchantSource?: 'rule' | 'user' | 'ai';
  merchantConfidence?: number | null;
  merchantReview?: boolean;
  sourceCategory: string;
  category: string;
  categorySource: string;
  categoryOverride: string | null;
  amountCents: number;
  cardLast4?: string | null;
  recurring: boolean;
  kind: 'purchase' | 'card_payment' | 'other_credit';
};
type Import = {
  id: string;
  filename: string;
  mappingVersion?: string;
  importedAt: string;
  count: number;
  added: number;
  duplicates: number;
  invalid: number;
  reviewCount?: number;
  from: string | null;
  through: string | null;
};
type Summary = {
  period: {
    from: string;
    through: string;
    previous?: { from: string; through: string };
    canCompare: boolean;
  };
  coverage: { from: string | null; through: string | null };
  totalCents: number;
  transactionCount: number;
  averageCents: number;
  medianCents: number;
  activeMerchants: number;
  largest: Row | null;
  previousCents: number | null;
  changeCents: number | null;
  changePercent: number | null;
  otherCreditsCents: number;
  categories: Group[];
  merchants: Group[];
  merchantDetails: Array<{
    name: string;
    cents: number;
    count: number;
    averageCents: number;
    largestCents: number;
    sharePercent: number;
    first: string | null;
    last: string | null;
    variants: Array<{ name: string; count: number }>;
    monthly: Array<{ key: string; cents: number }>;
  }>;
  categoryDetails: Array<{
    name: string;
    cents: number;
    count: number;
    sharePercent: number;
    merchants: Group[];
    monthly: Array<{ key: string; cents: number }>;
  }>;
  categoryChanges: Array<{ name: string; currentCents: number; previousCents: number; changeCents: number }>;
  merchantChanges: Array<{ name: string; currentCents: number; previousCents: number; changeCents: number }>;
  monthly: Array<{
    key: string;
    from: string;
    through: string;
    cents: number;
    hasData: boolean;
    categories: Group[];
  }>;
  daily: Array<{ date: string; cents: number; count: number }>;
  byDay: Array<{ day: number; cents: number; count: number }>;
  distribution: Array<{ fromCents: number; throughCents: number | null; count: number; cents: number }>;
  concentration: Array<{ count: number; cents: number; percent: number }>;
  recurring: Array<{
    merchant: string;
    merchantId?: string | null;
    reviewStatus?: 'new' | 'confirmed' | 'dismissed';
    frequency: string;
    estimatedCents: number;
    monthlyCents: number;
    annualCents: number;
    firstCharge?: string;
    lastCharge: string;
    lastAmountCents: number;
    priceChangeCents: number;
    count: number;
  }>;
  estimatedMonthlyRecurringCents: number;
  recurringReviewReady?: boolean;
  anomalies: Array<{
    reference: string;
    merchant: string;
    amountCents: number;
    historicalMedianCents: number;
    baselineCount: number;
  }>;
  insights: Array<{ type: string; text: string; changeCents: number }>;
  imports: Import[];
  availableCategories: string[];
};
type Merchant = {
  id: string;
  name: string;
  aliases: Array<{ id: string; pattern: string; matchType: string; source: string }>;
};
type Change = {
  action: string;
  entity: string;
  previous: string | null;
  next: string | null;
  affectedRows: number;
  changedAt: string;
};
type AlertRule = {
  id: string;
  type: 'merchant_monthly' | 'category_monthly' | 'transaction_amount';
  merchantId: string | null;
  merchant: string | null;
  category: string | null;
  thresholdCents: number;
  enabled: boolean;
};
type AlertEvent = {
  id: string;
  ruleId: string;
  type: string;
  merchant: string | null;
  category: string | null;
  period: string;
  currentCents: number;
  thresholdCents: number;
  status: 'new' | 'seen' | 'dismissed';
};
type AlertProgress = { id: string; period: { from: string; through: string }; currentCents: number | null };
type ClassificationStatus = {
  enabled: boolean;
  pendingMerchants: number;
  lastAttempt: null | {
    status: string;
    at: string;
    reason: string | null;
    model: string | null;
    candidateCount: number | null;
    classified: number | null;
    awaitingReview: number | null;
  };
};
type View = 'overview' | 'transactions' | 'analytics' | 'merchants' | 'recurring' | 'alerts';
type Card = { id: string; label: string; last4: string };

function CardRegistration({ busy, onRegister }: { busy: boolean; onRegister: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="amex-card-form" onSubmit={onRegister}>
    <label className="field">Card name
      <input name="cardLabel" maxLength={40} placeholder="My card" autoComplete="off" required />
    </label>
    <label className="field">Last four digits only
      <input name="cardLast4" inputMode="numeric" pattern="[0-9]{4}" minLength={4} maxLength={4} placeholder="1234" autoComplete="off" required />
    </label>
    <button type="submit" className="primary-button" disabled={busy}>Add card</button>
  </form>;
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const shortDate = (date: string) => {
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat('en-GB', { month: 'long', day: 'numeric' }).format(parsed);
};
const today = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function cycleKey(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 - (day! < 7 ? 1 : 0), 1)).toISOString().slice(0, 7);
}
function rangeFor(key: string) {
  const [year, month] = key.split('-').map(Number);
  return { from: `${key}-07`, through: new Date(Date.UTC(year!, month!, 6)).toISOString().slice(0, 10) };
}
function shiftCycle(key: string, change: number) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + change, 1)).toISOString().slice(0, 7);
}
const cycleLabel = (key: string) => {
  const { from, through } = rangeFor(key);
  return `${shortDate(from)} ${from.slice(0, 4)} – ${shortDate(through)} ${through.slice(0, 4)}`;
};
function presetRange(preset: string, key: string) {
  const effectiveKey = preset === 'previous' ? shiftCycle(key, -1) : key;
  const end =
    (preset === 'current' || preset === 'ytd') && key === cycleKey(today())
      ? today()
      : rangeFor(effectiveKey).through;
  const count = Number(preset.replace('last', ''));
  return {
    from:
      preset === 'ytd'
        ? `${key.slice(0, 4)}-01-07`
        : rangeFor(shiftCycle(effectiveKey, Number.isFinite(count) ? 1 - count : 0)).from,
    through: end,
  };
}
function DateSelect({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [year, month, day] = value.split('-').map(Number);
  const update = (nextYear: number, nextMonth: number, nextDay: number) => {
    const last = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    onChange(`${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(nextDay, last)).padStart(2, '0')}`);
  };
  return <fieldset className="amex-date-select"><legend>{label}</legend>
    <select aria-label={`${label} day`} value={day} onChange={(event) => update(year!, month!, Number(event.target.value))}>
      {Array.from({ length: new Date(Date.UTC(year!, month!, 0)).getUTCDate() }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
    </select>
    <select aria-label={`${label} month`} value={month} onChange={(event) => update(year!, Number(event.target.value), day!)}>
      {Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(Date.UTC(2020, index, 1)))}</option>)}
    </select>
    <select aria-label={`${label} year`} value={year} onChange={(event) => update(Number(event.target.value), month!, day!)}>
      {Array.from({ length: 30 }, (_, index) => new Date().getUTCFullYear() + 1 - index).map((item) => <option key={item} value={item}>{item}</option>)}
    </select>
  </fieldset>;
}
async function api<T>(url: string, csrfToken: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'request_failed',
    );
  return response.json() as Promise<T>;
}
const categoryColors = [
  '#236879', '#c87948', '#76619b', '#498f75', '#b08b33', '#aa6285', '#447ba1',
  '#a45640', '#607f36', '#765a42', '#9b5674', '#477d81', '#846eab', '#ac753b',
];
const categoryColor = (index: number) =>
  categoryColors[index] ?? `hsl(${(index * 137.508) % 360} 45% 43%)`;

function Bars({ items, onSelect, categoryLegend }: { items: Group[]; onSelect?: (name: string) => void; categoryLegend?: boolean }) {
  const max = Math.max(1, ...items.map((item) => item.cents));
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  return (
    <ol className="amex-bars">
      {items.map((item, index) => (
        <li key={item.name}>
          <div className="amex-bar-label">
            <span className="amex-category-name">
              {categoryLegend && <span className="amex-category-swatch" aria-hidden="true" style={{ backgroundColor: categoryColor(index) }} />}
              {onSelect ? (
                <button type="button" className="amex-text-button" onClick={() => onSelect(item.name)}>
                  {item.name}
                </button>
              ) : (
                <span>{item.name}</span>
              )}
            </span>
            <strong>
              {money(item.cents)} · {item.count}{categoryLegend && total > 0 ? ` · ${Math.round(item.cents / total * 100)}%` : ''}
            </strong>
          </div>
          <div className="amex-bar-track" aria-hidden="true">
            <span style={{ width: `${(item.cents / max) * 100}%`, ...(categoryLegend ? { backgroundColor: categoryColor(index) } : {}) }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
function Trend({ points }: { points: Array<{ label: string; cents: number; hasData: boolean }> }) {
  if (!points.length) return null;
  const max = Math.max(1, ...points.map((item) => item.cents));
  const plotted = points.map((item, index) => ({
    ...item,
    x: 20 + (index * 520) / Math.max(1, points.length - 1),
    y: 120 - (item.cents / max) * 100,
  }));
  return (
    <div className="amex-chart-wrap">
      <svg
        viewBox="0 0 560 145"
        className="amex-trend-svg"
        role="img"
        aria-label="Observed AMEX purchase trend; missing export periods are not zero spending"
      >
        <line x1="20" y1="120" x2="540" y2="120" stroke="#91abb0" />
        {plotted
          .slice(1)
          .map((item, index) =>
            plotted[index]!.hasData && item.hasData ? (
              <line
                key={item.label}
                x1={plotted[index]!.x}
                y1={plotted[index]!.y}
                x2={item.x}
                y2={item.y}
                stroke="#236879"
                strokeWidth="3"
              />
            ) : null,
          )}
        {plotted
          .filter((item) => item.hasData)
          .map((item) => (
            <circle key={item.label} cx={item.x} cy={item.y} r="4" fill="#236879">
              <title>
                {item.label}: {money(item.cents)}
              </title>
            </circle>
          ))}
      </svg>
    </div>
  );
}

function Delta({ items, onSelect }: { items: Summary['categoryChanges']; onSelect: (name: string) => void }) {
  return (
    <ul className="amex-delta-list">
      {items.slice(0, 12).map((item) => (
        <li key={item.name}>
          <button type="button" className="amex-text-button" onClick={() => onSelect(item.name)}>
            {item.name}
          </button>
          <span>
            {money(item.previousCents)} → {money(item.currentCents)}
          </span>
          <strong>
            {item.changeCents >= 0 ? '+' : '−'}
            {money(Math.abs(item.changeCents))}
          </strong>
        </li>
      ))}
    </ul>
  );
}

export function AmexAnalytics({ csrfToken }: { csrfToken: string }) {
  const [view, setView] = useState<View>('overview');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [preset, setPreset] = useState('current');
  const [selectedCycle, setSelectedCycle] = useState(() => cycleKey(today()));
  const [range, setRange] = useState(() => presetRange('current', cycleKey(today())));
  const [availableCycles, setAvailableCycles] = useState<string[] | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  const [cardLast4, setCardLast4] = useState('');
  const [merchantFilter, setMerchantFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const [recurringFilter, setRecurringFilter] = useState('all');
  const [data, setData] = useState<Summary | null>(null);
  const [transactions, setTransactions] = useState<{ rows: Row[]; total: number; totalCents: number } | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantOptions, setMerchantOptions] = useState<string[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [alerts, setAlerts] = useState<{
    rules: AlertRule[];
    events: AlertEvent[];
    progress: AlertProgress[];
  }>({ rules: [], events: [], progress: [] });
  const [classificationStatus, setClassificationStatus] = useState<ClassificationStatus | null>(null);
  const [importReviews, setImportReviews] = useState<Array<{
    id: string; filename: string; record: number; date: string; description: string;
    amountCents: number; possibleDuplicates: number;
  }>>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('date');
  const [direction, setDirection] = useState('desc');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTransactions, setDayTransactions] = useState<{ rows: Row[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [daySearch, setDaySearch] = useState('');
  const dayDialog = useRef<HTMLDialogElement>(null);
  const [aiInsights, setAiInsights] = useState<{ insights: string[]; facts: string[] } | null>(null);
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<{
    hash: string;
    count: number;
    from: string;
    through: string;
    duplicates: number;
    conflicts: number;
    invalid?: number;
    awaitingIdentityReview?: number;
    importReviewReady?: boolean;
    invalidRows?: Array<{ record: number; reason: string }>;
    merchantCount?: number;
    spendCents: number;
    otherCreditsCents: number;
    excludedPayments?: number;
    cardLast4s?: string[];
    unidentifiedCardRows?: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<'preview' | 'import' | 'retry' | 'insights' | null>(null);
  const [revision, setRevision] = useState(0);
  const [ruleType, setRuleType] = useState<AlertRule['type']>('transaction_amount');
  const [ruleTarget, setRuleTarget] = useState('');
  const [threshold, setThreshold] = useState('');

  const query = new URLSearchParams({ from: range.from, through: range.through });
  if (cardLast4) query.set('cardLast4', cardLast4);
  if (view === 'transactions') {
    if (merchantFilter) query.set('merchant', merchantFilter);
    if (categoryFilter) query.set('category', categoryFilter);
    if (search) query.set('search', search);
    if (minimum) query.set('minCents', String(Math.round(Number(minimum) * 100)));
    if (maximum) query.set('maxCents', String(Math.round(Number(maximum) * 100)));
    if (recurringFilter !== 'all') query.set('recurring', recurringFilter);
  }
  const filterQuery = query.toString();
  useEffect(() => {
    let active = true;
    api<{ cards: Card[] }>('/api/amex/cards', csrfToken)
      .then((result) => { if (active) { setCards(result.cards); setSetupOpen((current) => current ?? result.cards.length === 0); } })
      .catch(() => { if (active) setError('Could not load your cards.'); });
    return () => { active = false; };
  }, [csrfToken, revision]);
  useEffect(() => {
    let active = true;
    api<{ cycles: string[] }>(`/api/amex/cycles${cardLast4 ? `?cardLast4=${cardLast4}` : ''}`, csrfToken)
      .then((result) => { if (active) setAvailableCycles(result.cycles); })
      .catch(() => { if (active) setError('Could not load available AMEX cycles.'); });
    return () => { active = false; };
  }, [csrfToken, cardLast4, revision]);
  useEffect(() => {
    if (preset !== 'cycle' || !availableCycles?.length || availableCycles.includes(selectedCycle)) return;
    setSelectedCycle(availableCycles[0]!);
    setRange(rangeFor(availableCycles[0]!));
  }, [availableCycles, preset, selectedCycle]);
  useEffect(() => { setAiInsights(null); }, [range.from, range.through, cardLast4]);
  useEffect(() => {
    if (!selectedDay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dayDialog.current?.focus();
    return () => previous?.focus();
  }, [selectedDay]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api<Summary>(`/api/amex/analytics?${filterQuery}`, csrfToken)
      .then((result) => {
        if (active) { setData(result); setLoading(false); }
      })
      .catch(() => {
        if (active) { setError('Could not load AMEX analytics.'); setLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [csrfToken, filterQuery, revision]);
  useEffect(() => {
    if (!selectedDay) return;
    let active = true;
    setDayTransactions(null);
    api<{ rows: Row[]; total: number }>(`/api/amex/transactions?from=${selectedDay}&through=${selectedDay}&page=1&size=100${cardLast4 ? `&cardLast4=${cardLast4}` : ''}`, csrfToken)
      .then((result) => { if (active) setDayTransactions(result); })
      .catch(() => { if (active) setError('Could not load this day’s transactions.'); });
    return () => { active = false; };
  }, [selectedDay, csrfToken, cardLast4, revision]);
  useEffect(() => {
    let active = true;
    setTransactionsLoading(true);
    api<{ rows: Row[]; total: number; totalCents: number }>(
      `/api/amex/transactions?${filterQuery}&page=${page}&size=40&sort=${sort}&direction=${direction}`,
      csrfToken,
    )
      .then((result) => {
        if (active) { setTransactions(result); setTransactionsLoading(false); }
      })
      .catch(() => {
        if (active) { setError('Could not load AMEX transactions.'); setTransactionsLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [csrfToken, filterQuery, page, sort, direction, revision]);
  useEffect(() => {
    let active = true;
    api<ClassificationStatus>('/api/amex/classification/status', csrfToken)
      .then((result) => {
        if (active) setClassificationStatus(result);
      })
      .catch(() => {
        if (active) setError('Could not load AMEX classification status.');
      });
    return () => {
      active = false;
    };
  }, [csrfToken, revision]);
  useEffect(() => {
    let active = true;
    api<{ rows: typeof importReviews }>('/api/amex/import-reviews', csrfToken)
      .then((result) => { if (active) setImportReviews(result.rows); })
      .catch(() => { if (active) setError('Could not load AMEX import reviews.'); });
    return () => { active = false; };
  }, [csrfToken, revision]);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ merchants: Merchant[]; filterMerchants?: string[]; changes?: Change[] }>('/api/amex/merchants', csrfToken),
      api<{ rules: AlertRule[]; events: AlertEvent[]; progress: AlertProgress[] }>(
        '/api/amex/alerts',
        csrfToken,
      ),
    ])
      .then(([m, a]) => {
        if (active) {
          setMerchants(m.merchants);
          setMerchantOptions(m.filterMerchants ?? m.merchants.map((merchant) => merchant.name));
          setChanges(m.changes ?? []);
          setAlerts({ ...a, progress: a.progress ?? [] });
        }
      })
      .catch(() => {
        if (active) setError('Could not load AMEX merchant or alert settings.');
      });
    return () => {
      active = false;
    };
  }, [csrfToken, revision]);
  const refresh = () => {
    setRevision((value) => value + 1);
  };
  async function action(run: () => Promise<void>, label: 'preview' | 'import' | 'retry' | 'insights' | null = null) {
    setBusy(true);
    setBusyLabel(label);
    setError('');
    setMessage('');
    try {
      await run();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? `AMEX action failed (${cause.message}).` : 'AMEX action failed.');
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }
  function registerCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const label = (form.elements.namedItem('cardLabel') as HTMLInputElement).value.trim();
    const last4 = (form.elements.namedItem('cardLast4') as HTMLInputElement).value;
    void action(async () => {
      await api('/api/amex/cards', csrfToken, { label, last4 });
      form.reset();
      if (cards?.length) setSetupOpen(false);
      setMessage(`Card ending ${last4} added.`);
    });
  }
  function renameCard(card: Card, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = ((event.currentTarget.elements.namedItem('label') as HTMLInputElement).value).trim();
    if (label === card.label) return;
    void action(async () => {
      await api(`/api/amex/cards/${card.id}`, csrfToken, { label }, 'PUT');
      setMessage(`Card ending ${card.last4} renamed.`);
    });
  }
  const drill = (field: 'merchant' | 'category', name: string) => {
    setMerchantFilter('');
    setCategoryFilter('');
    if (field === 'merchant') setMerchantFilter(name);
    else setCategoryFilter(name);
    setPage(1);
    setView('transactions');
  };
  function changePreset(value: string) {
    setPreset(value);
    if (value === 'cycle') {
      const key = availableCycles?.includes(selectedCycle) ? selectedCycle : availableCycles?.[0];
      if (key) { setSelectedCycle(key); setRange(rangeFor(key)); }
    } else if (value === 'all')
      setRange({ from: data?.coverage.from ?? rangeFor(shiftCycle(cycleKey(today()), -119)).from, through: today() });
    else if (value !== 'dates') setRange(presetRange(value, cycleKey(today())));
    setPage(1);
  }
  async function chooseFile(file?: File) {
    setPreview(null);
    setCsv('');
    if (!file) return;
    if (file.size > 1_000_000) {
      setError('CSV exceeds the 1 MB limit.');
      return;
    }
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    await action(async () => {
      setPreview(await api('/api/amex/activity/preview', csrfToken, { csv: text }));
    }, 'preview');
  }
  const newEvents = alerts.events.filter((event) => event.status === 'new').length;
  const clearTransactionFilters = () => {
    setMerchantFilter(''); setCategoryFilter(''); setSearch('');
    setMinimum(''); setMaximum(''); setRecurringFilter('all'); setPage(1);
  };
  const setScreen = (next: View) => { if (view === 'transactions' && next !== 'transactions') clearTransactionFilters(); setView(next); };
  if (cards === null) return <section className="content-card amex-card-onboarding" aria-live="polite">
    <h2>Loading your cards…</h2>
    {error && <><p role="alert" className="alert">{error}</p><button type="button" className="secondary-button" onClick={refresh}>Try again</button></>}
  </section>;
  if (setupOpen && cards) return <section className="content-card amex-card-onboarding" aria-labelledby="card-onboarding-title">
    <p className="eyebrow">AMEX · step 1 of 2</p>
    <h2 id="card-onboarding-title">Set up your cards</h2>
    <p>Give each card a name you recognize. Enter only the last four digits from the CSV’s “Konto #” column. Your full card number and cardholder names are never saved.</p>
    {error && <p role="alert" className="alert">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    <ol className="amex-onboarding-steps">
      <li><strong>First card</strong>{cards[0] ? <span>{cards[0].label} ····{cards[0].last4} ✓</span> : <span>Not registered yet</span>}</li>
      <li><strong>Second card</strong>{cards[1] ? <span>{cards[1].label} ····{cards[1].last4} ✓</span> : <span>Add it now or later</span>}</li>
    </ol>
    <CardRegistration busy={busy} onRegister={registerCard} />
    {cards.length > 0 && <button className="secondary-button" type="button" onClick={() => setSetupOpen(false)}>
      Continue to dashboard{cards.length === 1 ? ' with one card' : ''}
    </button>}
    <p className="muted">After setup, import your private AMEX CSV. Choose either card or both together at any time.</p>
  </section>;
  return (
    <section className="content-card amex-page amex-analytics" aria-labelledby="amex-title">
      <p className="eyebrow">AMEX · EUR activity</p>
      <h2 id="amex-title" tabIndex={-1}>
        {t('amexAnalyticsTitle')}
      </h2>
      <p className="muted">
        {t('amexIntro')}
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <section className="amex-visual-card amex-card-selector" aria-label="Card selection">
        <h3>Spending view</h3>
        <p className="muted">Switch between cards or see your combined AMEX spending.</p>
        <div className="amex-card-choices" role="group" aria-label="Show spending for">
          <button type="button" className={cardLast4 === '' ? 'primary-button' : 'secondary-button'} aria-pressed={cardLast4 === ''} onClick={() => { setCardLast4(''); setPage(1); setSelectedDay(null); }}>
            Both cards together
          </button>
          {cards?.map((card) => <button key={card.id} type="button" className={cardLast4 === card.last4 ? 'primary-button' : 'secondary-button'} aria-pressed={cardLast4 === card.last4}
            onClick={() => { setCardLast4(card.last4); setPage(1); setSelectedDay(null); }}>
            {card.label} ····{card.last4}
          </button>)}
        </div>
        <p className="muted">{cardLast4 ? `Showing ${cards?.find((card) => card.last4 === cardLast4)?.label ?? 'selected card'} only.` : 'Showing both cards, including rows whose card could not be identified.'} Alerts, import history and merchant settings always cover the whole account.</p>
        <details className="configuration-section">
          <summary>Manage cards</summary>
          <div className="configuration-section-content">
            <CardRegistration busy={busy} onRegister={registerCard} />
            {cards?.map((card) => <form key={`${card.id}:${card.label}`} className="amex-card-rename" onSubmit={(event) => renameCard(card, event)}>
              <label className="field">Name for ····{card.last4}
                <input name="label" defaultValue={card.label} maxLength={40} required />
              </label>
              <button className="secondary-button" type="submit" disabled={busy}>Save name</button>
            </form>)}
            <p className="muted">Card endings cannot be edited. If an import shows an unregistered ending, add it here before choosing its individual view.</p>
          </div>
        </details>
      </section>
      <details className="configuration-section" open={!data?.imports.length && !data?.transactionCount}>
        <summary>{t('amexImport')}</summary>
        <div className="configuration-section-content">
          <p>
            {t('amexImportDisclosure')}
          </p>
          <label className="field">
            {t('amexSelectCsv')}{' '}
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => void chooseFile(e.target.files?.[0])}
            />
          </label>
          {busyLabel === 'preview' && <p role="status">Checking CSV preview…</p>}
          {preview && (
            <div className="notice">
              <p>
                {preview.count} source rows · {preview.from} – {preview.through} · Purchases{' '}
                {money(preview.spendCents)} · {preview.excludedPayments ?? 0} card payments excluded · Other credits{' '}
                {money(preview.otherCreditsCents)}
              </p>
              <p>
                {preview.duplicates} already imported · {preview.conflicts} changed references (blocked) ·{' '}
                {preview.count - (preview.excludedPayments ?? 0) - (preview.invalid ?? 0) - (preview.awaitingIdentityReview ?? 0) - preview.duplicates - preview.conflicts} potentially new ·{' '}
                {preview.awaitingIdentityReview ?? 0} without references (held for review) ·{' '}
                {preview.invalid ?? 0} invalid · {preview.merchantCount ?? '—'} merchants
              </p>
              <p>Cards found in this CSV: {preview.cardLast4s?.length ? preview.cardLast4s.map((last4) => cards?.find((card) => card.last4 === last4)?.label ?? `Unregistered ····${last4}`).join(' · ') : 'none identified'}.
                {preview.unidentifiedCardRows ? ` ${preview.unidentifiedCardRows} rows have no recognized card identifier and appear only in the combined view.` : ''}
                {preview.cardLast4s?.some((last4) => !cards?.some((card) => card.last4 === last4)) ? ' Register those card endings above to filter them after import.' : ''}</p>
              {preview.count === (preview.excludedPayments ?? 0) && <p role="status">This file contains only card payments, so there is nothing to import for spending analytics.</p>}
              {(preview.invalid ?? 0) > 0 && (
                <p role="alert">
                  Invalid records (first 20):{' '}
                  {preview.invalidRows?.map((item) => `${item.record}: ${item.reason}`).join(' · ')}. Correct
                  the source CSV before importing; no rows will be saved.
                </p>
              )}
              {(preview.awaitingIdentityReview ?? 0) > 0 && !preview.importReviewReady && (
                <p role="alert">Reference-free rows cannot be staged until the AMEX review migration is installed. No rows from this file will be saved yet.</p>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={busy || preview.count === (preview.excludedPayments ?? 0) || preview.conflicts > 0 || (preview.invalid ?? 0) > 0 || ((preview.awaitingIdentityReview ?? 0) > 0 && !preview.importReviewReady)}
                onClick={() =>
                  void action(async () => {
                    const result = await api<{
                      added: number;
                      awaitingIdentityReview?: number;
                      classification?: {
                        awaitingReview: number;
                        status: string;
                        reason?: string;
                        classified: number;
                        failedMerchants?: string[];
                      };
                    }>('/api/amex/activity/commit', csrfToken, { csv, hash: preview.hash, filename });
                    setCsv('');
                    setPreview(null);
                    setMessage(
                      `${result.added} transactions imported; ${result.awaitingIdentityReview ?? 0} reference-free rows held for manual identity review. ${result.classification?.classified ?? 0} merchants classified; ${result.classification?.awaitingReview ?? 0} awaiting category review.${result.classification?.failedMerchants?.length ? ` Unresolved: ${result.classification.failedMerchants.join(', ')}.` : ''}${result.classification?.status === 'pending' || result.classification?.status === 'unavailable' || result.classification?.status === 'skipped' ? ` Automatic classification ${result.classification.status} (${result.classification.reason ?? 'check status below'}). Use Retry classification below if needed.` : ''}`,
                    );
                  }, 'import')
                }
              >
                {busyLabel === 'import' ? 'Importing and categorizing…' : t('amexConfirmImport')}
              </button>
              {busyLabel === 'import' && (
                <p role="status">
                  Saving transactions and checking unknown merchants. This may take a moment; please do not
                  close the page.
                </p>
              )}
            </div>
          )}
          {data?.imports.length ? (
            <details>
              <summary>Import history ({data.imports.length})</summary>
              <ul>
                {data.imports.map((item) => (
                  <li key={item.id}>
                      {item.filename} · {item.added} added, {item.duplicates} duplicates, {item.reviewCount ?? 0} held for identity review · mapping {item.mappingVersion ?? 'unknown'} ·{' '}
                    {item.from ?? 'No new rows'} – {item.through ?? 'No new rows'}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </details>
      {importReviews.length > 0 && <section aria-label="Import identity review" className="amex-visual-card">
        <h3>{t('amexIdentityReview')} ({importReviews.length} shown)</h3>
        <p>These rows were not counted as spending. Identical charges can be separate purchases. Compare against existing transactions before deciding; confirming distinct creates a new purchase, dismissing keeps the row out.</p>
        <ul>{importReviews.map((row) => <li key={row.id}>
          <strong>{row.date} · {money(row.amountCents)}</strong> · {row.description} · {row.filename} record {row.record}
          {' '}· {row.possibleDuplicates} exact date/description/amount matches already saved
          {' '}<button type="button" disabled={busy} onClick={() => void action(async () => {
            await api(`/api/amex/import-reviews/${row.id}`, csrfToken, { decision: 'distinct' }, 'PUT');
            setMessage('Row saved as a distinct transaction.');
          })}>{t('amexConfirmDistinct')}</button>
          {' '}<button type="button" disabled={busy} onClick={() => void action(async () => {
            await api(`/api/amex/import-reviews/${row.id}`, csrfToken, { decision: 'dismissed' }, 'PUT');
            setMessage('Row dismissed; no transaction was created.');
          })}>{t('amexDismissRow')}</button>
        </li>)}</ul>
      </section>}
      <section
        className="amex-classification-status"
        aria-label="AMEX classification status"
        aria-busy={busyLabel === 'retry'}
      >
        <h3>{t('amexClassification')}</h3>
        <p>
          {classificationStatus
            ? `${classificationStatus.pendingMerchants} merchants await review across all imported history. ${classificationStatus.enabled ? 'DeepSeek classification is configured.' : 'DeepSeek classification is not configured on this server.'}`
            : 'Checking classification status…'}
        </p>
        {classificationStatus?.lastAttempt && (
          <p className="muted">
            Last attempt: {classificationStatus.lastAttempt.status} · {classificationStatus.lastAttempt.at}
            {classificationStatus.lastAttempt.model ? ` · ${classificationStatus.lastAttempt.model}` : ''}
            {classificationStatus.lastAttempt.reason ? ` · ${classificationStatus.lastAttempt.reason}` : ''}
            {classificationStatus.lastAttempt.candidateCount != null
              ? ` · ${classificationStatus.lastAttempt.classified ?? 0}/${classificationStatus.lastAttempt.candidateCount} classified`
              : ''}
          </p>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !classificationStatus?.enabled || !classificationStatus.pendingMerchants}
          onClick={() =>
            void action(async () => {
              const result = await api<{
                classified: number;
                awaitingReview: number;
                status: string;
                reason?: string;
                failedMerchants?: string[];
              }>('/api/amex/merchants/retry-classification', csrfToken, {});
              setMessage(
                `${result.classified} merchants classified; ${result.awaitingReview} still need review.${result.failedMerchants?.length ? ` Unresolved: ${result.failedMerchants.join(', ')}.` : ''} ${result.status === 'pending' ? `Classification could not finish (${result.reason ?? 'unknown'}).` : ''}`,
              );
            }, 'retry')
          }
        >
          {busyLabel === 'retry' ? 'Categorizing merchants…' : t('amexRetry')}
        </button>
        {busyLabel === 'retry' && (
          <p role="status">Classifying unresolved merchants. Your imported transactions remain saved.</p>
        )}
      </section>
      <nav className="amex-view-nav" aria-label={t('amexViews')}>
        {(['overview', 'transactions', 'analytics', 'merchants', 'recurring', 'alerts'] as View[]).map(
          (item) => (
            <button
              key={item}
              type="button"
              className={view === item ? 'is-active' : ''}
              aria-current={view === item ? 'page' : undefined}
              onClick={() => setScreen(item)}
            >
              {t(({ overview: 'amexOverview', transactions: 'amexTransactions', analytics: 'amexAnalytics', merchants: 'amexMerchants', recurring: 'amexRecurring', alerts: 'amexAlerts' } as const)[item])}
              {item === 'alerts' && newEvents ? ` (${newEvents})` : ''}
            </button>
          ),
        )}
      </nav>
      <button type="button" className="amex-filter-toggle secondary-button" aria-expanded={filtersOpen} aria-controls="amex-filters" onClick={() => setFiltersOpen((open) => !open)}>
        {filtersOpen ? t('amexHideFilters') : t('amexShowFilters')}
      </button>
      <fieldset id="amex-filters" className={`amex-range-filters${filtersOpen ? ' is-open' : ''}`}>
        <legend>Time period · AMEX cycles run from the 7th to the 6th</legend>
        <label>
          {t('amexPeriod')}{' '}
          <select value={preset} onChange={(e) => changePreset(e.target.value)}>
            <option value="current">{t('amexCurrentCycle')}</option>
            <option value="previous">{t('amexPreviousCycle')}</option>
            <option value="last3">{t('amexLast3')}</option>
            <option value="last6">{t('amexLast6')}</option>
            <option value="last12">{t('amexLast12')}</option>
            <option value="all">{t('amexAllHistory')}</option>
            <option value="ytd">{t('amexYtd')}</option>
            <option value="cycle">Choose statement cycle</option>
            <option value="dates">{t('amexCustomDates')}</option>
          </select>
        </label>
        {preset === 'cycle' && (
          <label>
            Statement cycle starting{' '}
            <select
              value={selectedCycle}
              disabled={!availableCycles?.length}
              onChange={(e) => {
                const key = e.target.value;
                setSelectedCycle(key);
                setRange(rangeFor(key));
                setPage(1);
              }}
            >{availableCycles?.length ? availableCycles.map((key) =>
              <option key={key} value={key}>{cycleLabel(key)}</option>) :
              <option value={selectedCycle}>{availableCycles ? 'No imported cycles yet' : 'Loading cycles…'}</option>}</select>
          </label>
        )}
        {preset === 'dates' && (
          <>
            <DateSelect label={t('amexFrom')} value={range.from} onChange={(from) => { setRange({ from, through: from > range.through ? from : range.through }); setPage(1); }} />
            <DateSelect label={t('amexThrough')} value={range.through} onChange={(through) => { setRange({ from: through < range.from ? through : range.from, through }); setPage(1); }} />
          </>
        )}
        <span className="muted amex-range-caption">Selected: {shortDate(range.from)} – {shortDate(range.through)} {range.from.slice(0, 4) !== range.through.slice(0, 4) ? `(${range.from.slice(0, 4)}–${range.through.slice(0, 4)})` : `(${range.from.slice(0, 4)})`}</span>
        {view === 'transactions' && <div className="amex-transaction-filter-fields">
        <label>
          {t('amexMerchant')}{' '}
          <select
            value={merchantFilter}
            onChange={(e) => {
              setMerchantFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('amexAllMerchants')}</option>
            {merchantOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('amexCategory')}{' '}
          <select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('amexAllCategories')}</option>
            {data?.availableCategories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('amexSearch')}{' '}
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('amexSearchHint')}
          />
        </label>
        <label>
          {t('amexMinEur')}{' '}
          <input
            type="number"
            min="0"
            step="0.01"
            value={minimum}
            onChange={(e) => {
              setMinimum(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          {t('amexMaxEur')}{' '}
          <input
            type="number"
            min="0"
            step="0.01"
            value={maximum}
            onChange={(e) => {
              setMaximum(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Recurring{' '}
          <select
            value={recurringFilter}
            onChange={(e) => {
              setRecurringFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">All</option>
            <option value="true">Candidates</option>
            <option value="false">Other</option>
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={clearTransactionFilters}
        >
          Clear filters
        </button>
        </div>}
      </fieldset>
      {loading && <p role="status" className="amex-loading">Updating {view}…</p>}
      {view === 'overview' && (
        <div className="amex-view-panel">
          <h3>Overview</h3>
          <p className="muted">
            {data?.coverage.from
              ? `Imported activity: ${data.coverage.from} – ${data.coverage.through}. `
              : 'No imported activity yet. '}
            CSV coverage may be partial; a cycle with no rows is not confirmed as zero.
          </p>
          {!data?.transactionCount && (
            <p className="notice">No purchases in this selection. Import a CSV above or change the period.</p>
          )}
          <div className="amex-kpis">
            {(
              [
                ['Gross purchases', data?.totalCents == null ? '—' : money(data.totalCents)],
                ['Purchases', data?.transactionCount ?? '—'],
                ['Average', data ? money(data.averageCents) : '—'],
                ['Active merchants', data?.activeMerchants ?? '—'],
                ['Largest purchase', data?.largest ? money(data.largest.amountCents) : '—'],
                [
                  'Comparable change',
                  data?.changeCents == null
                    ? 'More history needed'
                    : `${data.changeCents >= 0 ? '+' : '−'}${money(Math.abs(data.changeCents))} (${data.changePercent ?? '—'}%)`,
                ],
              ] as Array<[string, string | number]>
            ).map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="muted">Other credits: {money(data?.otherCreditsCents ?? 0)} (excluded from gross purchases).</p>
          <section aria-label="Spending insights">
            <h4>Spending insights</h4>
            <p className="muted">
              Computed from imported transactions, not generated by OpenAI. Comparisons appear only when the
              preceding period has observed export coverage; exports may still be partial.
            </p>
            {data?.insights.length ? (
              data.insights.map((insight) => (
                <p className="notice" key={insight.type}>
                  Observed: {insight.text}
                </p>
              ))
            ) : (
              <p className="muted">
                No purchase insights in this selection. Try All imported history or another cycle.
              </p>
            )}
            {data?.transactionCount && !data.period.canCompare ? (
              <p className="muted">
                More preceding history is needed for a reliable period-over-period insight
                {data.period.previous
                  ? ` (${data.period.previous.from} – ${data.period.previous.through})`
                  : ''}
                .
              </p>
            ) : null}
          </section>
          <div className="amex-dashboard-grid">
            <section className="amex-visual-card">
              <h4>Statement-cycle trend</h4>
              <Trend
                points={
                  data?.monthly.length === 1
                    ? data.daily.map((item) => ({
                        label: item.date,
                        cents: item.cents,
                        hasData: data.imports.some(
                          (batch) =>
                            batch.from &&
                            batch.through &&
                            item.date >= batch.from &&
                            item.date <= batch.through,
                        ),
                      }))
                    : (data?.monthly.map((item) => ({
                        label: cycleLabel(item.key),
                        cents: item.cents,
                        hasData: item.hasData,
                      })) ?? [])
                }
              />
              <Bars
                items={
                  data?.monthly.map((item) => ({
                    name: cycleLabel(item.key) + (item.hasData ? ' · observed' : ' · no imported data'),
                    cents: item.cents,
                    count: item.categories.reduce((sum, cat) => sum + cat.count, 0),
                  })) ?? []
                }
              />
            </section>
            <section className="amex-visual-card">
              <h4>Categories</h4>
              <Bars items={data?.categories ?? []} onSelect={(name) => drill('category', name)} />
              {data?.categoryDetails?.map((category) => (
                <details key={category.name}>
                  <summary>
                    {category.name} · {category.sharePercent}% of purchases
                  </summary>
                  <p>
                    Spend: {money(category.cents)} · {category.count} purchases
                  </p>
                  <h5>Top merchants</h5>
                  <Bars items={category.merchants.slice(0, 5)} onSelect={(name) => drill('merchant', name)} />
                  <p>
                    Cycle history:{' '}
                    {category.monthly
                      .map((item) => `${cycleLabel(item.key)}: ${money(item.cents)}`)
                      .join(' · ')}
                  </p>
                </details>
              ))}
            </section>
            <section className="amex-visual-card">
              <h4>Top merchants</h4>
              <Bars items={data?.merchants.slice(0, 10) ?? []} onSelect={(name) => drill('merchant', name)} />
            </section>
            <section className="amex-visual-card">
              <h4>Spending by category</h4>
              <p className="muted">Share of purchases in the selected period</p>
              {data?.totalCents ? <div className="amex-pie" role="img" aria-label={data.categories.map((c) => `${c.name}: ${money(c.cents)}`).join(', ')} style={{ background: `conic-gradient(${data.categories.reduce<{ parts: string[]; offset: number }>((acc, category, index) => {
                const next = acc.offset + category.cents / data.totalCents * 100;
                acc.parts.push(`${categoryColor(index)} ${acc.offset}% ${next}%`);
                acc.offset = next;
                return acc;
              }, { parts: [], offset: 0 }).parts.join(', ')})` }} /> : <p>No purchases in this period.</p>}
              <Bars items={data?.categories ?? []} categoryLegend onSelect={(name) => drill('category', name)} />
            </section>
          </div>
        </div>
      )}
      {view === 'transactions' && (
        <div className="amex-view-panel">
          <div className="amex-transactions-header"><h3>Transactions</h3><strong aria-live="polite">Selected purchases: {transactionsLoading || !transactions ? 'Loading…' : money(transactions.totalCents ?? 0)}</strong></div>
          <p>
            {transactions?.total ?? 0} imported transactions matching this selection. Source descriptions are
            never edited.
          </p>
          {data?.categories.some((item) => item.name === 'Needs review') && <details className="amex-review-shortcut">
            <summary>Review uncategorized transactions</summary>
            <button type="button" className="secondary-button" onClick={() => drill('category', 'Needs review')}>Show needs review</button>
          </details>}
          <div className="amex-filters">
            <label>
              Sort by{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="date">Date</option>
                <option value="amount">Amount</option>
                <option value="merchant">Merchant</option>
              </select>
            </label>
            <label>
              Direction{' '}
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
          </div>
          {transactionsLoading && <p role="status">Loading matching transactions…</p>}
          <div className="amex-transaction-list" aria-busy={transactionsLoading}>
            {transactions?.rows.map((row) => (
              <details key={row.reference}>
                <summary>
                  <span>
                    {shortDate(row.date)} · {row.merchant}{row.cardLast4 ? ` · ${cards?.find((card) => card.last4 === row.cardLast4)?.label ?? 'Card'} ····${row.cardLast4}` : ' · Card unknown'} {row.recurring ? '· recurring candidate' : ''}
                  </span>
                  <strong>
                    {row.kind === 'purchase' ? money(row.amountCents) : `Other credit ${money(-row.amountCents)}`}
                  </strong>
                </summary>
                <div className="amex-transaction-detail">
                    <p>Original description: {row.description}</p>
                  <p>
                    Merchant identity: {row.merchant} ({row.merchantSource ?? 'rule'}
                    {row.merchantConfidence != null
                      ? `, confidence ${Math.round(row.merchantConfidence * 100)}%`
                      : ''}
                    ){row.merchantReview ? ' · review suggested' : ''}
                  </p>
                  <p>
                    Source category: {row.sourceCategory || '—'} · Reference: {row.reference}
                  </p>
                  {row.kind === 'purchase' && (
                    <>
                      <p>
                        Category: {row.category} (
                        {row.categoryOverride ? 'transaction override' : row.categorySource})
                      </p>
                      <label>
                        Override this transaction only{' '}
                        <select
                          value={row.categoryOverride ?? ''}
                          disabled={busy}
                          onChange={(e) =>
                            void action(async () => {
                              await api(
                                `/api/amex/transactions/${encodeURIComponent(row.reference)}/category`,
                                csrfToken,
                                { category: e.target.value || null },
                                'PUT',
                              );
                              setMessage('Transaction category updated.');
                            })
                          }
                        >
                          <option value="">Use merchant category</option>
                          {data?.availableCategories.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>{' '}
                      <label>
                        Set merchant default{' '}
                        <select
                          value={row.categoryOverride ? '' : row.category}
                          disabled={busy}
                          onChange={(e) =>
                            void action(async () => {
                              await api(
                                '/api/amex/activity/merchant-category',
                                csrfToken,
                                { merchant: row.merchant, category: e.target.value },
                                'PUT',
                              );
                              setMessage('Merchant category updated.');
                            })
                          }
                        >
                          <option value="">Choose category</option>
                          {data?.availableCategories.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              </details>
            ))}
          </div>
          <div className="amex-pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {Math.max(1, Math.ceil((transactions?.total ?? 0) / 40))}
            </span>
            <button
              type="button"
              disabled={page * 40 >= (transactions?.total ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {view === 'analytics' && (
        <div className="amex-view-panel">
          <h3>Analytics</h3>
          <section className="amex-visual-card amex-ai-insights">
            <h4>AI spending insights</h4>
            <p className="muted">Optional DeepSeek interpretation of computed AMEX facts for {shortDate(range.from)} – {shortDate(range.through)}. No full transaction list is sent. Totals below remain calculated by the app.</p>
            <button type="button" className="secondary-button" disabled={busy || !data?.transactionCount} onClick={() => void action(async () => {
              setAiInsights(await api('/api/amex/insights', csrfToken, { from: range.from, through: range.through, ...(cardLast4 ? { cardLast4 } : {}) }));
            }, 'insights')}>{busyLabel === 'insights' ? 'Generating insights…' : 'Generate insights for this period'}</button>
            {aiInsights && <div role="status"><ul>{aiInsights.insights.map((insight, index) => <li key={index}>{insight}</li>)}</ul><p className="muted">Verified facts: {aiInsights.facts.join(' ')}</p></div>}
          </section>
          <p className="muted">
            {data?.period.canCompare
              ? `Observed comparison for the preceding equivalent period. Coverage may be partial.`
              : 'More history needed for a comparison. Missing rows do not mean zero spending.'}
          </p>
          {data?.period.canCompare && (
            <div className="amex-dashboard-grid">
              <section className="amex-visual-card">
                <h4>Category contribution to change</h4>
                <Delta items={data.categoryChanges} onSelect={(name) => drill('category', name)} />
              </section>
              <section className="amex-visual-card">
                <h4>Merchant contribution to change</h4>
                <Delta items={data.merchantChanges} onSelect={(name) => drill('merchant', name)} />
              </section>
            </div>
          )}
          <div className="amex-dashboard-grid">
            <section className="amex-visual-card">
              <h4>Day of week</h4>
              <Bars
                items={(data?.byDay ?? []).map((d) => ({
                  name: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                    d.day
                  ]!,
                  cents: d.cents,
                  count: d.count,
                }))}
              />
            </section>
            <section className="amex-visual-card">
              <h4>Purchase sizes</h4>
              <Bars
                items={(data?.distribution ?? []).map((d) => ({
                  name: `${money(d.fromCents)} – ${d.throughCents == null ? 'above' : money(d.throughCents)}`,
                  cents: d.cents,
                  count: d.count,
                }))}
              />
            </section>
            <section className="amex-visual-card">
              <h4>Merchant concentration</h4>
              <p className="muted">Share held by the highest-spending merchants in this selection.</p>
              <ul>
                {data?.concentration.map((c) => (
                  <li key={c.count}>
                    Top {c.count}: {money(c.cents)} · {c.percent}% of selected purchases
                    <div className="amex-bar-track" aria-hidden="true"><span style={{ width: `${c.percent}%` }} /></div>
                    <small>{data.merchants.slice(0, c.count).map((merchant, index) => <span key={merchant.name}>{index ? ' · ' : ''}<button type="button" className="amex-text-button" onClick={() => drill('merchant', merchant.name)}>{merchant.name}</button></span>)}</small>
                  </li>
                ))}
              </ul>
            </section>
            <section className="amex-visual-card">
              <h4>Explainable unusually large purchases</h4>
              {data?.anomalies.length ? (
                <ul>
                  {data.anomalies.map((a) => (
                    <li key={a.reference}>
                      {a.merchant}: {money(a.amountCents)} vs median {money(a.historicalMedianCents)} from{' '}
                      {a.baselineCount} earlier purchases at this merchant
                    </li>
                  ))}
                </ul>
              ) : (
                <p>More history needed, or no qualifying outliers.</p>
              )}
            </section>
          </div>
          <section className="amex-visual-card amex-calendar-card">
            <h4>Calendar daily spend</h4>
            <p className="muted">Select a day to see its transactions. Days without purchases are not proof of complete CSV coverage.</p>
            <div className="amex-calendar-grid">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span className="amex-weekday" key={day}>{day}</span>)}
              {Array.from({ length: data?.daily[0] ? (new Date(`${data.daily[0].date}T12:00:00Z`).getUTCDay() + 6) % 7 : 0 }, (_, index) => <span aria-hidden="true" key={`blank-${index}`} />)}
              {data?.daily.map((d) => (
                <button type="button"
                  key={d.date}
                  title={`${d.date}: ${money(d.cents)} · ${d.count} purchases`}
                  style={{ background: d.count ? '#d5ece7' : '#f3f6f6' }}
                  onClick={() => setSelectedDay(d.date)}
                  aria-label={`${shortDate(d.date)}: ${d.count ? `${money(d.cents)} in ${d.count} purchases` : 'No observed purchases'}. View transactions`}
                >
                  <time dateTime={d.date}>{shortDate(d.date)}</time>
                  <strong>{d.count ? money(d.cents) : '—'}</strong>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {view === 'merchants' && (
        <div className="amex-view-panel">
          <h3>Merchants &amp; categories</h3>
          <p>
            Renames, aliases and merges change historical groups; source descriptions stay intact. Check a
            merchant carefully before merging.
          </p>
          <div className="amex-dashboard-grid">
            <section className="amex-visual-card">
              <h4>Selected-period merchants</h4>
              <Bars items={data?.merchants ?? []} onSelect={(name) => drill('merchant', name)} />
            </section>
            <section className="amex-visual-card">
              <h4>Selected-period categories</h4>
              <Bars items={data?.categories ?? []} onSelect={(name) => drill('category', name)} />
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem('categoryName') as HTMLInputElement;
                  void action(async () => {
                    await api('/api/amex/categories', csrfToken, { name: input.value });
                    input.value = '';
                    setMessage('Category created.');
                  });
                }}
              >
                <label>
                  New AMEX category <input name="categoryName" required minLength={2} maxLength={48} />
                </label>{' '}
                <button type="submit" disabled={busy}>
                  Create
                </button>
              </form>
            </section>
          </div>
          <details>
            <summary>Manage merchant identities and aliases ({merchants.length})</summary>
            <div className="amex-merchant-grid">
              {merchants.map((m) => (
                <section className="amex-visual-card" key={m.id}>
                  <h4>{m.name}</h4>
                  <p>
                    Selected-period spending:{' '}
                    {money(data?.merchants.find((item) => item.name === m.name)?.cents ?? 0)} ·{' '}
                    {data?.merchants.find((item) => item.name === m.name)?.count ?? 0} purchases
                  </p>
                  {data?.merchantDetails?.find((item) => item.name === m.name) &&
                    (() => {
                      const detail = data.merchantDetails.find((item) => item.name === m.name)!;
                      return (
                        <details>
                          <summary>Spending profile</summary>
                          <p>
                            Average {money(detail.averageCents)} · Largest {money(detail.largestCents)} ·{' '}
                            {detail.sharePercent}% of purchases
                          </p>
                          <p>
                            First observed {detail.first} · Last observed {detail.last}
                          </p>
                          <p>
                            Cycle history:{' '}
                            {detail.monthly
                              .map((item) => `${cycleLabel(item.key)}: ${money(item.cents)}`)
                              .join(' · ')}
                          </p>
                          <details>
                            <summary>Original descriptions ({detail.variants.length})</summary>
                            <ul>
                              {detail.variants.map((variant) => (
                                <li key={variant.name}>
                                  {variant.name} · {variant.count}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </details>
                      );
                    })()}
                  <button
                    type="button"
                    className="amex-text-button"
                    onClick={() => drill('merchant', m.name)}
                  >
                    View transactions
                  </button>
                  {m.aliases.length > 0 && (
                    <p className="muted">
                      Aliases:{' '}
                      {m.aliases
                        .map((alias) => `${alias.pattern} (${alias.matchType}, ${alias.source})`)
                        .join(' · ')}
                    </p>
                  )}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const field = event.currentTarget.elements.namedItem('name') as HTMLInputElement;
                      void action(async () => {
                        await api(`/api/amex/merchants/${m.id}`, csrfToken, { name: field.value }, 'PUT');
                        setMessage('Merchant renamed.');
                      });
                    }}
                  >
                    <label>
                      Rename <input name="name" defaultValue={m.name} minLength={2} maxLength={80} required />
                    </label>
                    <button disabled={busy}>Save</button>
                  </form>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const pattern = (form.elements.namedItem('pattern') as HTMLInputElement).value;
                      const matchType = (form.elements.namedItem('matchType') as HTMLSelectElement).value;
                      void action(async () => {
                        await api(`/api/amex/merchants/${m.id}/aliases`, csrfToken, { pattern, matchType });
                        form.reset();
                        setMessage('Alias applied to existing and future matches.');
                      });
                    }}
                  >
                    <label>
                      New alias <input name="pattern" required maxLength={300} />
                    </label>
                    <label>
                      Match{' '}
                      <select name="matchType">
                        <option value="exact">Exact</option>
                        <option value="prefix">Prefix (5+ characters)</option>
                      </select>
                    </label>
                    <button disabled={busy}>Apply alias</button>
                  </form>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const targetId = (
                        event.currentTarget.elements.namedItem('targetId') as HTMLSelectElement
                      ).value;
                      if (
                        !window.confirm(
                          `Merge ${m.name} into ${merchants.find((item) => item.id === targetId)?.name}? This changes historical grouping.`,
                        )
                      )
                        return;
                      void action(async () => {
                        await api(`/api/amex/merchants/${m.id}/merge`, csrfToken, { targetId });
                        setMessage('Merchants merged.');
                      });
                    }}
                  >
                    <label>
                      Merge into{' '}
                      <select name="targetId" required defaultValue="">
                        <option value="" disabled>
                          Choose target
                        </option>
                        {merchants
                          .filter((item) => item.id !== m.id)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button disabled={busy || merchants.length < 2}>Merge</button>
                  </form>
                </section>
              ))}
            </div>
          </details>
          <details>
            <summary>Recent AMEX corrections ({changes.length})</summary>
            <ol>
              {changes.map((change, index) => (
                <li key={`${change.changedAt}-${index}`}>
                  {change.changedAt} · {change.action.replaceAll('_', ' ')} · {change.previous ?? '—'} →{' '}
                  {change.next ?? '—'} · {change.affectedRows} transactions affected
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
      {view === 'recurring' && (
        <div className="amex-view-panel">
          <h3>Recurring candidates</h3>
          <p className="muted">
            Detected from at least three similar charges at regular intervals. These are observations, not
            scheduled obligations.
          </p>
          <p>
            Estimated monthly equivalent: <strong>{money(data?.estimatedMonthlyRecurringCents ?? 0)}</strong>
            {' '}excluding dismissed candidates.
          </p>
          {data && !data.recurringReviewReady && <p className="muted">Recurring review requires the next AMEX database migration; candidate detection remains available.</p>}
          {!data?.recurring.length && (
            <p className="notice">More history needed or no confident recurring pattern.</p>
          )}
          <div className="amex-dashboard-grid">
            {data?.recurring.map((item) => (
              <section className="amex-visual-card" key={item.merchant}>
                <h4>{item.merchant}</h4>
                <p>{item.reviewStatus === 'new' ? 'New candidate · not reviewed' : item.reviewStatus === 'dismissed' ? 'Dismissed candidate' : 'Confirmed by you as a recurring observation'}</p>
                <p>
                  {item.count} charges · {item.frequency} · last on {item.lastCharge}:{' '}
                  {money(item.lastAmountCents)}
                </p>
                {item.firstCharge && (
                  <p>
                    First observed: {item.firstCharge}
                    {item.firstCharge >= range.from ? ' · newly observed in selection' : ''}
                  </p>
                )}
                <p>
                  Typical {money(item.estimatedCents)} · monthly equivalent {money(item.monthlyCents)} ·
                  annualized {money(item.annualCents)}
                </p>
                {item.priceChangeCents !== 0 && (
                  <p>
                    Latest change: {item.priceChangeCents > 0 ? '+' : '−'}
                    {money(Math.abs(item.priceChangeCents))}
                  </p>
                )}
                <button
                  type="button"
                  className="amex-text-button"
                  onClick={() => drill('merchant', item.merchant)}
                >
                  View charges
                </button>
                {' '}
                {item.merchantId && data.recurringReviewReady && <button
                  type="button" className="secondary-button" disabled={busy}
                  onClick={() => void action(async () => {
                    await api(`/api/amex/recurring/${item.merchantId}/review`, csrfToken,
                      { status: item.reviewStatus === 'dismissed' ? 'confirmed' : 'dismissed' }, 'PUT');
                    setMessage('Recurring candidate review saved.');
                  })}
                >{item.reviewStatus === 'dismissed' ? 'Restore candidate' : 'Dismiss candidate'}</button>}
                {item.reviewStatus === 'new' && item.merchantId && data.recurringReviewReady && <button
                  type="button" className="secondary-button" disabled={busy}
                  onClick={() => void action(async () => {
                    await api(`/api/amex/recurring/${item.merchantId}/review`, csrfToken,
                      { status: 'confirmed' }, 'PUT');
                    setMessage('Recurring candidate confirmed as an observation.');
                  })}
                >Confirm candidate</button>}
              </section>
            ))}
          </div>
        </div>
      )}
      {view === 'alerts' && (
        <div className="amex-view-panel">
          <h3>Alerts</h3>
          <p className="muted">
            Informational thresholds only. “Monthly” follows the 7th–6th statement cycle; a rule fires
            strictly above its threshold.
          </p>
          <form
            className="amex-rule-form"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const cents = Math.round(Number(threshold) * 100);
              if (!Number.isSafeInteger(cents) || cents <= 0) {
                setError('Enter a positive EUR threshold.');
                return;
              }
              void action(async () => {
                await api('/api/amex/alerts/rules', csrfToken, {
                  type: ruleType,
                  ...(ruleType === 'merchant_monthly' ? { merchantId: ruleTarget } : {}),
                  ...(ruleType === 'category_monthly' ? { category: ruleTarget } : {}),
                  thresholdCents: cents,
                  enabled: true,
                });
                setThreshold('');
                setRuleTarget('');
                setMessage('Alert rule created.');
              });
            }}
          >
            <label>
              Rule type{' '}
              <select
                value={ruleType}
                onChange={(e) => {
                  setRuleType(e.target.value as AlertRule['type']);
                  setRuleTarget('');
                }}
              >
                <option value="transaction_amount">Single purchase</option>
                <option value="merchant_monthly">Merchant per cycle</option>
                <option value="category_monthly">Category per cycle</option>
              </select>
            </label>
            {ruleType === 'merchant_monthly' && (
              <label>
                Merchant{' '}
                <select required value={ruleTarget} onChange={(e) => setRuleTarget(e.target.value)}>
                  <option value="">Choose merchant</option>
                  {merchants.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {ruleType === 'category_monthly' && (
              <label>
                Category{' '}
                <select required value={ruleTarget} onChange={(e) => setRuleTarget(e.target.value)}>
                  <option value="">Choose category</option>
                  {data?.availableCategories
                    .filter((item) => item !== 'Needs review')
                    .map((item) => (
                      <option value={item} key={item}>
                        {item}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Above EUR{' '}
              <input
                type="number"
                required
                min="0.01"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <button type="submit" disabled={busy}>
              Create rule
            </button>
          </form>
          <h4>Rules</h4>
          {!alerts.rules.length && <p>No rules yet.</p>}
          <ul className="amex-rule-list">
            {alerts.rules.map((rule) => (
              <li key={rule.id}>
                <strong>
                  {rule.type.replaceAll('_', ' ')} · {rule.merchant ?? rule.category ?? 'Any merchant'}
                </strong>{' '}
                above {money(rule.thresholdCents)}
                {alerts.progress.find((item) => item.id === rule.id)?.currentCents != null && (
                  <span>
                    Observed {money(alerts.progress.find((item) => item.id === rule.id)!.currentCents!)} /{' '}
                    {money(rule.thresholdCents)} ·{' '}
                    {alerts.progress.find((item) => item.id === rule.id)!.period.from} –{' '}
                    {alerts.progress.find((item) => item.id === rule.id)!.period.through}
                  </span>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      void action(async () => {
                        await api(
                          `/api/amex/alerts/rules/${rule.id}`,
                          csrfToken,
                          {
                            type: rule.type,
                            ...(rule.merchantId ? { merchantId: rule.merchantId } : {}),
                            ...(rule.category ? { category: rule.category } : {}),
                            thresholdCents: rule.thresholdCents,
                            enabled: e.target.checked,
                          },
                          'PUT',
                        );
                        setMessage('Rule updated.');
                      })
                    }
                  />{' '}
                  Enabled
                </label>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const amount = (event.currentTarget.elements.namedItem('limit') as HTMLInputElement)
                      .value;
                    const thresholdCents = Math.round(Number(amount) * 100);
                    if (!Number.isSafeInteger(thresholdCents) || thresholdCents <= 0) {
                      setError('Enter a positive EUR threshold.');
                      return;
                    }
                    void action(async () => {
                      await api(
                        `/api/amex/alerts/rules/${rule.id}`,
                        csrfToken,
                        {
                          type: rule.type,
                          ...(rule.merchantId ? { merchantId: rule.merchantId } : {}),
                          ...(rule.category ? { category: rule.category } : {}),
                          thresholdCents,
                          enabled: rule.enabled,
                        },
                        'PUT',
                      );
                      setMessage('Threshold updated.');
                    });
                  }}
                >
                  <label>
                    Threshold EUR{' '}
                    <input
                      name="limit"
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      defaultValue={(rule.thresholdCents / 100).toFixed(2)}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Update threshold
                  </button>
                </form>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api(`/api/amex/alerts/rules/${rule.id}`, csrfToken, {}, 'DELETE');
                      setMessage('Rule deleted.');
                    })
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <h4>Events ({newEvents} new)</h4>
          {!alerts.events.length && <p>No thresholds exceeded in imported activity.</p>}
          <ul className="amex-rule-list">
            {alerts.events.map((event) => (
              <li key={event.id}>
                <strong>
                  {event.merchant ?? event.category ?? 'Purchase'} · {event.period} ·{' '}
                  {money(event.currentCents)}
                </strong>
                <span>
                  Threshold {money(event.thresholdCents)} · {event.status}
                </span>
                {(['seen', 'dismissed'] as const).map((status) => (
                  <button
                    type="button"
                    key={status}
                    disabled={busy || event.status === status}
                    onClick={() =>
                      void action(async () => {
                        await api(`/api/amex/alerts/events/${event.id}`, csrfToken, { status }, 'PATCH');
                        setMessage(`Alert marked ${status}.`);
                      })
                    }
                  >
                    {status === 'seen' ? 'Mark seen' : 'Dismiss'}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {selectedDay && <div className="amex-modal-backdrop">
        <dialog ref={dayDialog} tabIndex={-1} open aria-modal="true" aria-label={`Transactions on ${shortDate(selectedDay)}`} className="amex-day-dialog" onKeyDown={(event) => { if (event.key === 'Escape') setSelectedDay(null); }}>
          <div className="amex-transactions-header"><h3>{shortDate(selectedDay)} transactions</h3><button type="button" className="secondary-button" onClick={() => setSelectedDay(null)}>Close</button></div>
          {!dayTransactions ? <p role="status">Loading transactions…</p> : <>
            <p>{dayTransactions.total} transactions · {money(dayTransactions.rows.filter((row) => row.kind === 'purchase').reduce((sum, row) => sum + row.amountCents, 0))} in purchases</p>
            <label className="amex-day-search">Filter this day <input type="search" value={daySearch} placeholder="Merchant or description" onChange={(event) => setDaySearch(event.target.value)} /></label>
            <div className="amex-transaction-list">{dayTransactions.rows.filter((row) => `${row.merchant} ${row.description}`.toLowerCase().includes(daySearch.toLowerCase())).map((row) => <details key={row.reference}><summary><span>{shortDate(row.date)} · {row.merchant}</span><strong>{money(row.amountCents)}</strong></summary><div className="amex-transaction-detail"><p>Original description: {row.description}</p><p>Category: {row.category}</p></div></details>)}</div>
            {dayTransactions.total > dayTransactions.rows.length && <p>Showing the first {dayTransactions.rows.length} transactions.</p>}
          </>}
        </dialog>
      </div>}
    </section>
  );
}
