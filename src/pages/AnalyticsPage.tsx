import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLiveRefresh } from '../lib/realtime';
import { ExpenseCategory, User } from '../types';
import { formatLKR, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { useTheme } from '../lib/theme';
import { lastNDays, toISODate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, EmptyState, Skeleton } from '../components/ui';
import { CategoryBars, CategoryDatum, TrendChart, TrendPoint } from '../components/Charts';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface AnalyticsPageProps {
  user: User;
}

type Range = 30 | 90;

/**
 * One share of one shared bill — the unit everything on this screen is built
 * from, now that the app only records shared spending.
 */
interface SpendRow {
  date: string;
  category: ExpenseCategory;
  /** What this bill charged you. */
  amount: number;
  /** What you actually put in for it, which is usually not the same. */
  paid: number;
  groupId: string;
  groupName: string;
  /** Everyone else on the bill. */
  withIds: string[];
}

/** A ranked breakdown row, used for both "who with" and "which group". */
interface Ranked {
  key: string;
  label: string;
  value: number;
  user?: User;
}

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ user }) => {
  const { resolved } = useTheme();
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [people, setPeople] = useState<Record<string, User>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);

  const load = useCallback(async () => {
    setError(null);
    try {
      // 190 days covers the 90-day range plus its comparison period.
      const since = toISODate(new Date(Date.now() - 190 * 24 * 3600 * 1000));

      // Your share of every shared bill you were on. Lending is excluded here
      // rather than filtered later: money moving between two people is a
      // transfer, not spending, and counting it would double what you spent
      // once the borrower records what they actually bought.
      const { data, error: splitError } = await supabase
        .from('expense_splits')
        .select(
          'amount, expense_id, expenses!inner(id, category, created_at, is_deleted, is_loan, group_id, groups(name, is_direct))'
        )
        .eq('user_id', user.id)
        .eq('is_included', true)
        .eq('expenses.is_deleted', false)
        .eq('expenses.is_loan', false)
        .gte('expenses.created_at', since);
      if (splitError) throw splitError;

      const mine = (data ?? []).filter((row: any) => row.expenses);
      const expenseIds = mine.map((row: any) => row.expense_id);

      // Who else was on those bills, and what everyone put in. Two small
      // follow-up queries rather than a deep embed, which PostgREST cannot
      // express without ambiguity here.
      const [othersRes, payersRes] = await Promise.all([
        expenseIds.length > 0
          ? supabase
              .from('expense_splits')
              .select('expense_id, user_id, users(*)')
              .in('expense_id', expenseIds)
              .eq('is_included', true)
          : Promise.resolve({ data: [], error: null }),
        expenseIds.length > 0
          ? supabase
              .from('ledger_entries')
              .select('reference_id, amount')
              .eq('user_id', user.id)
              .eq('entry_type', 'EXPENSE')
              .in('reference_id', expenseIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      const withByExpense: Record<string, string[]> = {};
      const seen: Record<string, User> = {};
      for (const row of (othersRes.data ?? []) as any[]) {
        if (row.user_id === user.id) continue;
        (withByExpense[row.expense_id] ||= []).push(row.user_id);
        if (row.users) seen[row.user_id] = row.users as User;
      }
      setPeople(seen);

      const paidByExpense: Record<string, number> = {};
      for (const row of (payersRes.data ?? []) as any[]) {
        paidByExpense[row.reference_id] =
          (paidByExpense[row.reference_id] ?? 0) + Number(row.amount);
      }

      setRows(
        mine.map((row: any) => ({
          date: String(row.expenses.created_at).slice(0, 10),
          category: (row.expenses.category || 'OTHER') as ExpenseCategory,
          amount: Number(row.amount),
          paid: paidByExpense[row.expense_id] ?? 0,
          groupId: row.expenses.group_id,
          groupName: row.expenses.groups?.is_direct
            ? 'Just the two of you'
            : (row.expenses.groups?.name ?? 'A group'),
          withIds: withByExpense[row.expense_id] ?? [],
        }))
      );
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your stats.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh('analytics', ['expense_splits', 'expenses', 'ledger_entries'], load);

  const windowDates = useMemo(() => new Set(lastNDays(range)), [range]);
  const visible = useMemo(() => rows.filter((row) => windowDates.has(row.date)), [rows, windowDates]);

  const byDate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const row of rows) map[row.date] = roundMoney((map[row.date] ?? 0) + row.amount);
    return map;
  }, [rows]);

  const trend = useMemo<TrendPoint[]>(
    () => lastNDays(range).map((date) => ({ date, value: byDate[date] ?? 0 })),
    [byDate, range]
  );

  const windowTotal = useMemo(() => roundMoney(trend.reduce((sum, p) => sum + p.value, 0)), [trend]);

  /** What you actually put in over the window, which is rarely your share. */
  const fronted = useMemo(
    () => roundMoney(visible.reduce((sum, row) => sum + row.paid, 0)),
    [visible]
  );

  const previousTotal = useMemo(() => {
    const dates = lastNDays(range * 2).slice(0, range);
    return roundMoney(dates.reduce((sum, date) => sum + (byDate[date] ?? 0), 0));
  }, [byDate, range]);

  const changePercent = previousTotal > 0 ? ((windowTotal - previousTotal) / previousTotal) * 100 : null;

  const activeDays = trend.filter((p) => p.value > 0).length;

  /**
   * Averaged over the days you actually spent on, not every day in the window,
   * and never over more than the last 30. Dividing by the whole range answers
   * "how much per calendar day", which reads as a much smaller number than
   * people expect and drifts lower the wider the range gets — the useful figure
   * is what a spending day typically costs.
   */
  const averagedOverDays = useMemo(() => {
    const window = Math.min(range, 30);
    const from = lastNDays(window)[0];
    return Object.entries(byDate).filter(([date, value]) => date >= from && value > 0).length;
  }, [byDate, range]);

  const dailyAverage = useMemo(() => {
    const window = Math.min(range, 30);
    const from = lastNDays(window)[0];
    const days = Object.entries(byDate).filter(([date, value]) => date >= from && value > 0);
    if (days.length === 0) return 0;
    return roundMoney(days.reduce((sum, [, value]) => sum + value, 0) / days.length);
  }, [byDate, range]);

  const busiest = trend.reduce<TrendPoint | null>(
    (top, point) => (point.value > (top?.value ?? 0) ? point : top),
    null
  );

  const categoryData = useMemo<CategoryDatum[]>(() => {
    const totals: Record<string, number> = {};
    for (const row of visible) {
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
  }, [visible, resolved]);

  const topCategory = categoryData[0];

  /**
   * Who you spend with. A bill split three ways counts its whole share against
   * each of the other two — the question is "how much of my spending happens
   * around this person", not an apportionment, so it deliberately does not sum
   * to the total.
   */
  const byPerson = useMemo<Ranked[]>(() => {
    const totals: Record<string, number> = {};
    for (const row of visible) {
      for (const id of row.withIds) totals[id] = roundMoney((totals[id] ?? 0) + row.amount);
    }
    return Object.entries(totals)
      .map(([id, value]) => ({
        key: id,
        label: people[id]?.display_name ?? 'Someone',
        value,
        user: people[id],
      }))
      .sort((a, b) => b.value - a.value);
  }, [visible, people]);

  const byGroup = useMemo<Ranked[]>(() => {
    const totals: Record<string, { name: string; value: number }> = {};
    for (const row of visible) {
      const entry = (totals[row.groupId] ||= { name: row.groupName, value: 0 });
      entry.value = roundMoney(entry.value + row.amount);
    }
    return Object.entries(totals)
      .map(([id, { name, value }]) => ({ key: id, label: name, value }))
      .sort((a, b) => b.value - a.value);
  }, [visible]);

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
          <p className="page-subtitle">Your share of everything you have split</p>
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
        <span className="label">Your share · last {range} days</span>
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
          style={{ gap: 'var(--sp-5)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}
        >
          <div>
            {/* What you put in versus what was yours to pay. The gap between
                the two is the money you are waiting on. */}
            <div className="label">You fronted</div>
            <div className="amount-md tabular">{formatLKR(fronted)}</div>
          </div>
          <div>
            <div className="label">Avg. spending day</div>
            <div className="amount-md tabular">{formatLKR(dailyAverage)}</div>
            <div className="hint">
              {averagedOverDays > 0
                ? `over ${averagedOverDays} day${averagedOverDays === 1 ? '' : 's'}${range > 30 ? ', last 30' : ''}`
                : 'no spending yet'}
            </div>
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

      {windowTotal === 0 ? (
        <EmptyState
          icon="📊"
          title="Nothing split yet"
          text="Add a bill to a group, or record something with a friend, and your share will be charted here."
        />
      ) : (
        <>
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
          {topCategory && (
            <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
              {categoryMeta(topCategory.key).name} is your biggest category at{' '}
              {((topCategory.value / windowTotal) * 100).toFixed(0)}% of your share.
            </p>
          )}
          <CategoryBars data={categoryData} total={windowTotal} />

          {byPerson.length > 0 && (
            <>
              <h2 className="section-title">Who you spend with</h2>
              <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                How much of your spending happens around each person. A bill you split three ways counts
                against both of the others, so these do not add up to the total.
              </p>
              <div className="stack-sm">
                {byPerson.map((row) => (
                  <div key={row.key} className="card row">
                    <Avatar name={row.label} url={row.user?.avatar_url} size={32} />
                    <span className="grow truncate" style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                      {row.label}
                    </span>
                    <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                      {formatLKR(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {byGroup.length > 0 && (
            <>
              <h2 className="section-title">Which group</h2>
              <div className="stack-sm">
                {byGroup.map((row) => {
                  const pct = Math.round((row.value / windowTotal) * 100);
                  return (
                    <div key={row.key} className="card row">
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span
                          className="truncate"
                          style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600 }}
                        >
                          {row.label}
                        </span>
                        <span className="hint">{pct}% of your share</span>
                      </span>
                      <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                        {formatLKR(row.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
