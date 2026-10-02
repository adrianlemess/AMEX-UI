import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AmexAnalytics } from './AmexAnalytics';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads separate AMEX screens with shared server-side selection and no AI consent gate', async () => {
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/analytics?')
        ? {
            period: { from: '2026-09-07', through: '2026-10-06', canCompare: false },
            coverage: { from: '2026-09-07', through: '2026-09-28' },
            imports: [],
            availableCategories: ['Needs review', 'Groceries'],
            totalCents: 1500,
            transactionCount: 1,
            averageCents: 1500,
            activeMerchants: 1,
            largest: null,
            changeCents: null,
            otherCreditsCents: 0,
            categories: [{ name: 'Needs review', cents: 1000, count: 1 }, { name: 'Groceries', cents: 500, count: 1 }],
            merchants: [{ name: 'Synthetic store', cents: 1500, count: 1 }],
            monthly: [],
            insights: [],
            byDay: [],
            distribution: [],
            concentration: [],
             daily: [{ date: '2026-09-08', cents: 1500, count: 1 }],
            anomalies: [],
            recurring: [],
            estimatedMonthlyRecurringCents: 0,
            categoryChanges: [],
            merchantChanges: [],
          }
        : url.endsWith('/cards')
          ? { cards: [{ id: 'synthetic', label: 'Primary', last4: '1014' }, { id: 'synthetic-two', label: 'Secondary', last4: '2004' }] }
        : url.includes('/transactions?')
          ? { rows: [], total: 0 }
          : url.endsWith('/import-reviews')
            ? { rows: [] }
          : url.endsWith('/alerts')
            ? { rules: [], events: [], progress: [] }
            : url.endsWith('/cycles')
              ? { cycles: ['2026-09', '2026-08'] }
             : { merchants: [] },
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<AmexAnalytics csrfToken="synthetic" />);
  expect(await screen.findByText('More history needed')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Show spending for' }), { target: { value: '1014' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/analytics?') && url.includes('cardLast4=1014'))).toBe(true));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/transactions?') && url.includes('cardLast4=1014'))).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Show spending for' }), { target: { value: '' } });
  const categoryCard = screen.getByRole('heading', { name: 'Spending by category' }).closest('section')!;
  const pie = categoryCard.querySelector('.amex-pie')!;
  const swatches = categoryCard.querySelectorAll('.amex-category-swatch');
  const bars = categoryCard.querySelectorAll('.amex-bar-track span');
  expect(pie.getAttribute('style')).toContain('#236879');
  expect(pie.getAttribute('style')).toContain('#c87948');
  expect(swatches[0]).toHaveStyle({ backgroundColor: '#236879' });
  expect(swatches[1]).toHaveStyle({ backgroundColor: '#c87948' });
  expect(bars[0]).toHaveStyle({ backgroundColor: '#236879' });
  expect(bars[1]).toHaveStyle({ backgroundColor: '#c87948' });
  expect(categoryCard).toHaveTextContent('67%');
  expect(categoryCard).toHaveTextContent('33%');
  expect(screen.queryByText(/consent checkbox/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Statement cycle starting' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'cycle' } });
  const cycle = screen.getByRole('combobox', { name: 'Statement cycle starting' });
  await waitFor(() => expect(cycle.querySelectorAll('option')).toHaveLength(2));
  expect(cycle).toHaveTextContent('7 September 2026 – 6 October 2026');
  expect(cycle).toHaveTextContent('7 August 2026 – 6 September 2026');
  fireEvent.change(cycle, { target: { value: '2026-08' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('from=2026-08-07&through=2026-09-06'))).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'dates' } });
  expect(screen.queryByRole('combobox', { name: 'Statement cycle starting' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'From year' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'current' } });
  expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Transactions$/ }));
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'store' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('search=store'))).toBe(true));
  expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Recurring$/ }));
  expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
  expect(screen.getByText(/not scheduled obligations/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Merchants$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic store' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('merchant=Synthetic+store'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /^Merchants$/ }));
  expect(screen.queryByLabelText('Merchant')).not.toBeInTheDocument();
  expect(screen.getByText('Selected-period merchants')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Alerts$/ }));
  expect(screen.getByRole('heading', { name: /^Alerts$/ })).toBeInTheDocument();
});

it('opens a calendar day in a searchable transaction dialog', async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.includes('/analytics?') ? {
      period: { from: '2026-09-07', through: '2026-10-06', canCompare: false },
      coverage: { from: '2026-09-08', through: '2026-09-08' }, imports: [],
      totalCents: 1500, transactionCount: 1, averageCents: 1500, activeMerchants: 1,
      categories: [{ name: 'Groceries', cents: 1500, count: 1 }], merchants: [], monthly: [],
      daily: [{ date: '2026-09-08', cents: 1500, count: 1 }],
      insights: [], byDay: [], distribution: [], concentration: [], anomalies: [],
    } : url.endsWith('/cards') ? { cards: [] } : url.includes('/transactions?') ? { total: 1, totalCents: 1500, rows: [{ reference: 'one', date: '2026-09-08', merchant: 'Test market', description: 'Test market', amountCents: 1500, kind: 'purchase', category: 'Groceries' }] }
      : url.endsWith('/import-reviews') ? { rows: [] } : url.endsWith('/alerts') ? { rules: [], events: [], progress: [] } : url.endsWith('/cycles') ? { cycles: ['2026-09', '2026-08'] } : { merchants: [] },
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<AmexAnalytics csrfToken="synthetic" />);
  fireEvent.click(screen.getByRole('button', { name: /^Analytics$/ }));
  expect(await screen.findByRole('heading', { name: 'Calendar daily spend' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Calendar daily spend' }).closest('section')).toHaveClass('amex-calendar-card');
  const day = await screen.findByRole('button', { name: /8 September.*View transactions/ });
  fireEvent.click(day);
  expect(await screen.findByText('8 September transactions')).toBeInTheDocument();
  expect(screen.getByLabelText('Filter this day')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('8 September transactions')).not.toBeInTheDocument();
});
