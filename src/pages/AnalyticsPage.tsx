import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ExpenseCategory, User } from '../types';
import { formatLKR, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { useTheme } from '../lib/theme';
import { lastNDays, toISODate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, Skeleton } from '../components/ui';
import { CategoryBars, CategoryDatum, TrendChart, TrendPoint } from '../components/Charts';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface AnalyticsPageProps {
  user: User;
}

type Range = 30 | 90;
type Source = 'all' | 'personal' | 'group';

/** One spending fact, whatever it came from. */
interface SpendRow {
  date: string;
  category: ExpenseCategory;
  amount: number;
  source: 'personal' | 'group';
}

const SOURCE_LABELS: Record<Source, string> = {
  all: 'Everything',
  personal: 'Personal',
  group: 'Group share',
};

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ user }) => {
  const { resolved } = useTheme();
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);
  const [source, setSource] = useState<Source>('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      // 190 days covers the 90-day range plus its comparison period.
      const since = toISODate(new Date(Date.now() - 190 * 24 * 3600 * 1000));

      const [dailyRes, splitRes] = await Promise.all([
        supabase
          .from('daily_expenses')
          .select('date, category, amount')
          .eq('user_id', user.id)
          .eq('is_deleted', false)
          .gte('date', since),
        // Your share of group bills, carrying the bill's own category. This is
        // what the breakdown used to miss: group spending was summed into a
        // single figure and never split by category.
        supabase
          .from('expense_splits')
          .select('amount, expenses!inner(category, created_at, is_deleted)')
          .eq('user_id', user.id)
          .eq('is_included', true)
          .eq('expenses.is_deleted', false)
          .gte('expenses.created_at', since),
      ]);

      if (dailyRes.error) throw dailyRes.error;
      if (splitRes.error) throw splitRes.error;

      const personal: SpendRow[] = (dailyRes.data ?? []).map((row: any) => ({
        date: row.date,
        category: (row.category || 'OTHER') as ExpenseCategory,
        amount: Number(row.amount),
        source: 'personal',
      }));

      const group: SpendRow[] = (splitRes.data ?? [])
        .filter((row: any) => row.expenses)
        .map((row: any) => ({
          date: String(row.expenses.created_at).slice(0, 10),
          category: (row.expenses.category || 'OTHER') as ExpenseCategory,
          amount: Number(row.amount),
          source: 'group',
        }));

      setRows([...personal, ...group]);
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your analytics.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (source === 'all' ? rows : rows.filter((row) => row.source === source)),
    [rows, source]
  );

  const byDate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const row of visible) map[row.date] = roundMoney((map[row.date] ?? 0) + row.amount);
    return map;
  }, [visible]);

  const trend = useMemo<TrendPoint[]>(
    () => lastNDays(range).map((date) => ({ date, value: byDate[date] ?? 0 })),
    [byDate, range]
  );

  const windowTotal = useMemo(() => roundMoney(trend.reduce((sum, p) => sum + p.value, 0)), [trend]);

  const previousTotal = useMemo(() => {
    const dates = lastNDays(range * 2).slice(0, range);
    return roundMoney(dates.reduce((sum, date) => sum + (byDate[date] ?? 0), 0));
  }, [byDate, range]);

  const changePercent = previousTotal > 0 ? ((windowTotal - previousTotal) / previousTotal) * 100 : null;

  const activeDays = trend.filter((p) => p.value > 0).length;
  const dailyAverage = range > 0 ? roundMoney(windowTotal / range) : 0;
  const busiest = trend.reduce<TrendPoint | null>(
    (top, point) => (point.value > (top?.value ?? 0) ? point : top),
    null
  );

  const splitByOrigin = useMemo(() => {
    const windowDates = new Set(lastNDays(range));
    let personal = 0;
    let group = 0;
    for (const row of rows) {
      if (!windowDates.has(row.date)) continue;
      if (row.source === 'personal') personal += row.amount;
      else group += row.amount;
    }
    return { personal: roundMoney(personal), group: roundMoney(group) };
  }, [rows, range]);

  const categoryData = useMemo<CategoryDatum[]>(() => {
    const windowDates = new Set(lastNDays(range));
    const totals: Record<string, number> = {};
    for (const row of visible) {
      if (!windowDates.has(row.date)) continue;
      totals[row.category] = roundMoney((totals[row.category] ?? 0) + row.amount);
    }
    return CATEGORIES.filter((cat) => (totals[cat.id] ?? 0) > 0)
      .map((cat) => ({
        key: cat.id,
        label: cat.name,
        emoji: cat.emoji,
        value: totals[cat.id],
        color: cat.color[resolved],
      }))
      .sort((a, b) => b.value - a.value);
  }, [visible, range, resolved]);

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
          <p className="page-subtitle">Personal tracker + your share of group bills</p>
        </div>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 'var(--sp-2)' }}>
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

      <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 'var(--sp-4)' }}>
        {(['all', 'personal', 'group'] as Source[]).map((option) => (
          <button
            key={option}
            type="button"
            className={`chip ${source === option ? 'is-selected' : ''}`}
            style={{ display: 'flex', justifyContent: 'center' }}
            onClick={() => setSource(option)}
          >
            {SOURCE_LABELS[option]}
          </button>
        ))}
      </div>

      <section className="card-hero is-neutral" style={{ marginBottom: 'var(--sp-5)' }}>
        <span className="label">
          {SOURCE_LABELS[source]} spending · last {range} days
        </span>
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

      {source === 'all' && (splitByOrigin.personal > 0 || splitByOrigin.group > 0) && (
        <div className="card row-between" style={{ marginBottom: 'var(--sp-5)' }}>
          <div>
            <span className="label">Own spending</span>
            <div className="amount-md tabular">{formatLKR(splitByOrigin.personal)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className="label">Share of group bills</span>
            <div className="amount-md tabular">{formatLKR(splitByOrigin.group)}</div>
          </div>
        </div>
      )}

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

      <h2 className="section-title" style={{ marginTop: 0 }}>
        Where it goes
      </h2>
      {topCategory && windowTotal > 0 && (
        <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
          {categoryMeta(topCategory.key).name} is your biggest category at{' '}
          {((topCategory.value / windowTotal) * 100).toFixed(0)}% of spending.
        </p>
      )}

      {categoryData.length === 0 ? (
        <EmptyState
          icon="📊"
          title="No data yet"
          text={
            source === 'group'
              ? 'Add a group expense and your share will be broken down here by category.'
              : 'Log a few expenses in the Tracker and your breakdown and trends will appear here.'
          }
        />
      ) : (
        <CategoryBars data={categoryData} total={windowTotal} />
      )}
    </div>
  );
};
