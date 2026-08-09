import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLiveRefresh } from '../lib/realtime';
import { ExpenseCategory, User } from '../types';
import { formatLKR, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { useTheme } from '../lib/theme';
import { friendlyDate, lastNDays, toISODate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, Skeleton, Spinner } from '../components/ui';
import { CategoryBars, CategoryDatum, TrendChart, TrendPoint } from '../components/Charts';
import { HelpCircle, TrendingDown, TrendingUp } from 'lucide-react';

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
  const [pending, setPending] = useState<any[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);

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
        // Shared spending counted as yours. Group shares are marked counted as
        // they are written, so this is normally everything you were in; a record
        // a friend made with you privately only lands here once you say so.
        // TRUE, never merely unset — undecided is not consent.
        supabase
          .from('expense_splits')
          .select('amount, include_in_stats, expenses!inner(category, created_at, is_deleted)')
          .eq('user_id', user.id)
          .eq('is_included', true)
          .eq('include_in_stats', true)
          .eq('expenses.is_deleted', false)
          .gte('expenses.created_at', since),
      ]);

      if (dailyRes.error) throw dailyRes.error;
      if (splitRes.error) throw splitRes.error;

      // Shares somebody else's bill gave you that you have not ruled on yet.
      // They are already real expenses and already affect what you owe; the only
      // open question is whether they belong in your charts.
      //
      // Explicitly somebody else's: a bill you entered yourself carries your
      // answer already, and being asked to confirm your own typing is noise.
      const { data: pendingData } = await supabase
        .from('expense_splits')
        .select(
          'expense_id, amount, expenses!inner(title, category, created_at, created_by, is_deleted, group_id, groups(name, is_direct))'
        )
        .eq('user_id', user.id)
        .eq('is_included', true)
        .is('include_in_stats', null)
        .eq('expenses.is_deleted', false)
        .neq('expenses.created_by', user.id)
        .order('expense_id')
        .limit(50);
      setPending(pendingData ?? []);

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

  // Somebody else adding a bill puts a decision in your queue; it should appear
  // without you having to leave the screen and come back.
  useLiveRefresh('analytics', ['expense_splits', 'expenses', 'daily_expenses'], load);

  const decide = async (expenseId: string, include: boolean) => {
    setDeciding(expenseId);
    try {
      const { error: rpcError } = await supabase.rpc('set_split_stats_choice', {
        p_expense_id: expenseId,
        p_include: include,
      });
      if (rpcError) throw rpcError;
      await load();
    } catch (err) {
      setError(friendlyDbError(err, 'Could not save that choice.'));
    } finally {
      setDeciding(null);
    }
  };

  const decideAll = async (include: boolean) => {
    setDeciding('ALL');
    try {
      const { error: rpcError } = await supabase.rpc('set_all_pending_stats_choices', {
        p_include: include,
      });
      if (rpcError) throw rpcError;
      await load();
    } catch (err) {
      setError(friendlyDbError(err, 'Could not save those choices.'));
    } finally {
      setDeciding(null);
    }
  };

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
  /**
   * Averaged over the days you actually spent on, not every day in the window,
   * and never over more than the last 30. Dividing by the whole range answers
   * "how much per calendar day", which reads as a much smaller number than
   * people expect and drifts lower the wider the range gets — the useful figure
   * is what a spending day typically costs.
   */
  const dailyAverage = useMemo(() => {
    const window = Math.min(range, 30);
    const from = lastNDays(window)[0];
    const days = Object.entries(byDate).filter(([date, value]) => date >= from && value > 0);
    if (days.length === 0) return 0;
    const total = days.reduce((sum, [, value]) => sum + value, 0);
    return roundMoney(total / days.length);
  }, [byDate, range]);

  const averagedOverDays = useMemo(() => {
    const window = Math.min(range, 30);
    const from = lastNDays(window)[0];
    return Object.entries(byDate).filter(([date, value]) => date >= from && value > 0).length;
  }, [byDate, range]);
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

      {pending.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--warning)', marginBottom: 'var(--sp-4)' }}>
          <span className="row" style={{ gap: 8, marginBottom: 6 }}>
            <HelpCircle size={16} color="var(--warning)" />
            <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>
              {pending.length} shared {pending.length === 1 ? 'record' : 'records'} with a friend
            </span>
          </span>
          <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
            A friend recorded these straight with you, outside any group. Group spending counts
            automatically; this asks only because you were never at the form. They already count toward
            what you owe — this is only about the charts below.
          </p>

          <div className="stack-sm">
            {pending.map((row: any) => (
              <div key={row.expense_id} className="card row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <span
                    className="truncate"
                    style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600 }}
                  >
                    {row.expenses?.title ?? 'Expense'}
                  </span>
                  <span className="hint">
                    {friendlyDate(String(row.expenses?.created_at ?? '').slice(0, 10))}
                    {row.expenses?.groups && !row.expenses.groups.is_direct
                      ? ` · ${row.expenses.groups.name}`
                      : ''}
                    {' · your share '}
                    {formatLKR(Number(row.amount))}
                  </span>
                </span>
                <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => decide(row.expense_id, false)}
                    disabled={deciding !== null}
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => decide(row.expense_id, true)}
                    disabled={deciding !== null}
                  >
                    {deciding === row.expense_id ? <Spinner /> : 'Count it'}
                  </button>
                </span>
              </div>
            ))}
          </div>

          {pending.length > 1 && (
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm grow"
                onClick={() => decideAll(false)}
                disabled={deciding !== null}
              >
                Skip all
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm grow"
                onClick={() => decideAll(true)}
                disabled={deciding !== null}
              >
                Count all
              </button>
            </div>
          )}
        </section>
      )}

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
