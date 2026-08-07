import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DailyExpense, User } from '../types';
import { formatLKR, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { lastNDays, monthKey, toISODate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, Skeleton } from '../components/ui';
import { CategoryBars, CategoryDatum, TrendChart, TrendPoint } from '../components/Charts';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface AnalyticsPageProps {
  user: User;
}

type Range = 30 | 90;

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ user }) => {
  const [expenses, setExpenses] = useState<DailyExpense[]>([]);
  const [groupShare, setGroupShare] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);

  const load = useCallback(async () => {
    setError(null);
    try {
      // 90 days covers the widest range, plus the previous period for the
      // month-over-month comparison.
      const since = toISODate(new Date(Date.now() - 190 * 24 * 3600 * 1000));

      const { data, error: fetchError } = await supabase
        .from('daily_expenses')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_deleted', false)
        .gte('date', since)
        .order('date', { ascending: true });

      if (fetchError) throw fetchError;
      setExpenses((data ?? []) as DailyExpense[]);

      // What the user personally owes across all group bills this month.
      const { data: splitData } = await supabase
        .from('expense_splits')
        .select('amount, is_included, expenses!inner(is_deleted, created_at)')
        .eq('user_id', user.id)
        .eq('is_included', true);

      const monthPrefix = monthKey();
      const share = (splitData ?? [])
        .filter((row: any) => !row.expenses?.is_deleted && String(row.expenses?.created_at).startsWith(monthPrefix))
        .reduce((sum: number, row: any) => sum + Number(row.amount), 0);
      setGroupShare(roundMoney(share));
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your analytics.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const expense of expenses) {
      map[expense.date] = roundMoney((map[expense.date] ?? 0) + Number(expense.amount));
    }
    return map;
  }, [expenses]);

  /** Every day in the window, including the zero-spend ones. */
  const trend = useMemo<TrendPoint[]>(
    () => lastNDays(range).map((date) => ({ date, value: byDate[date] ?? 0 })),
    [byDate, range]
  );

  const windowTotal = useMemo(() => roundMoney(trend.reduce((sum, p) => sum + p.value, 0)), [trend]);

  const previousTotal = useMemo(() => {
    const dates = lastNDays(range * 2).slice(0, range);
    return roundMoney(dates.reduce((sum, date) => sum + (byDate[date] ?? 0), 0));
  }, [byDate, range]);

  const changePercent =
    previousTotal > 0 ? ((windowTotal - previousTotal) / previousTotal) * 100 : null;

  const activeDays = trend.filter((p) => p.value > 0).length;
  const dailyAverage = activeDays > 0 ? roundMoney(windowTotal / range) : 0;
  const busiest = trend.reduce<TrendPoint | null>(
    (top, point) => (point.value > (top?.value ?? 0) ? point : top),
    null
  );

  const categoryData = useMemo<CategoryDatum[]>(() => {
    const windowDates = new Set(lastNDays(range));
    const totals: Record<string, number> = {};
    for (const expense of expenses) {
      if (!windowDates.has(expense.date)) continue;
      totals[expense.category] = roundMoney((totals[expense.category] ?? 0) + Number(expense.amount));
    }
    return CATEGORIES.filter((cat) => (totals[cat.id] ?? 0) > 0)
      .map((cat) => ({
        key: cat.id,
        label: cat.name,
        emoji: cat.emoji,
        value: totals[cat.id],
        color: cat.color,
      }))
      .sort((a, b) => b.value - a.value);
  }, [expenses, range]);

  const topCategory = categoryData[0];

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">Stats</h1>
        </header>
        <Skeleton height={150} radius={24} />
        <div style={{ height: 16 }} />
        <Skeleton height={200} radius={18} />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Stats</h1>
          <p className="page-subtitle">Your personal spending</p>
        </div>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 'var(--sp-4)' }}>
        {([30, 90] as Range[]).map((option) => (
          <button
            key={option}
            type="button"
            className={`chip ${range === option ? 'is-selected' : ''}`}
            style={{ display: 'flex', justifyContent: 'center' }}
            onClick={() => setRange(option)}
          >
            Last {option} days
          </button>
        ))}
      </div>

      <section className="card-hero is-neutral" style={{ marginBottom: 'var(--sp-5)' }}>
        <span className="label">Tracked in the last {range} days</span>
        <div className="amount-xl" style={{ margin: '6px 0 4px' }}>
          {formatLKR(windowTotal)}
        </div>
        {changePercent !== null && (
          <span
            className="row hint"
            style={{ gap: 5, color: changePercent > 0 ? 'var(--negative)' : 'var(--positive)' }}
          >
            {changePercent > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {Math.abs(changePercent).toFixed(0)}% {changePercent > 0 ? 'more than' : 'less than'} the previous{' '}
            {range} days
          </span>
        )}

        <div
          className="row card-divider"
          style={{ gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}
        >
          <div>
            <div className="label">Daily average</div>
            <div className="amount-md tabular">{formatLKR(dailyAverage)}</div>
          </div>
          <div>
            <div className="label">Days with spend</div>
            <div className="amount-md tabular">
              {activeDays}
              <span className="hint"> / {range}</span>
            </div>
          </div>
        </div>
      </section>

      <h2 className="section-title" style={{ marginTop: 0 }}>
        Daily spending
      </h2>
      <div className="card" style={{ marginBottom: 'var(--sp-2)' }}>
        <TrendChart data={trend} />
      </div>
      {busiest && busiest.value > 0 && (
        <p className="hint" style={{ marginBottom: 'var(--sp-5)' }}>
          Highest day: {formatLKR(busiest.value)} on{' '}
          {new Date(busiest.date + 'T00:00:00').toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
          })}
          .
        </p>
      )}

      {groupShare > 0 && (
        <div className="card row" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="icon-tile" style={{ width: 40, height: 40, fontSize: 19 }}>
            👥
          </span>
          <span className="grow">
            <span className="label">Your share of group bills this month</span>
            <div className="amount-md tabular">{formatLKR(groupShare)}</div>
          </span>
        </div>
      )}

      <h2 className="section-title" style={{ marginTop: 0 }}>
        Where it goes
      </h2>
      {topCategory && (
        <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
          {categoryMeta(topCategory.key).name} is your biggest category at{' '}
          {((topCategory.value / windowTotal) * 100).toFixed(0)}% of spending.
        </p>
      )}

      {categoryData.length === 0 ? (
        <EmptyState
          icon="📊"
          title="No data yet"
          text="Log a few expenses in the Tracker and your breakdown and trends will appear here."
        />
      ) : (
        <CategoryBars data={categoryData} total={windowTotal} />
      )}
    </div>
  );
};
