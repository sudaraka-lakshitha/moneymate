import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Budget, DailyExpense, ExpenseCategory, User } from '../types';
import { formatLKR, parseAmount, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { useTheme } from '../lib/theme';
import { friendlyDate, monthKey, monthLabel, startOfMonthISO, todayISO } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, ProgressBar, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { ReceiptPicker } from '../components/ReceiptPicker';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { queueWrite, readCache, useOnline, writeCache } from '../lib/offline';
import { Pencil, Plus, Repeat, Trash2, Wallet } from 'lucide-react';

const FREQUENCIES = [
  { id: 'DAILY', label: 'Daily' },
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'MONTHLY', label: 'Monthly' },
] as const;

type Frequency = (typeof FREQUENCIES)[number]['id'];

const nextRunAfter = (from: string, frequency: Frequency): string => {
  const date = new Date(`${from}T00:00:00`);
  if (frequency === 'DAILY') date.setDate(date.getDate() + 1);
  else if (frequency === 'WEEKLY') date.setDate(date.getDate() + 7);
  else date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
};

interface TrackerPageProps {
  user: User;
}

export const TrackerPage: React.FC<TrackerPageProps> = ({ user }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const { resolved } = useTheme();

  const [expenses, setExpenses] = useState<DailyExpense[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<DailyExpense | null>(null);
  const [showBudgets, setShowBudgets] = useState(false);

  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('FOOD');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('MONTHLY');
  const online = useOnline();

  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [savingBudgets, setSavingBudgets] = useState(false);

  const currentMonth = monthKey();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [expenseRes, budgetRes] = await Promise.all([
        supabase
          .from('daily_expenses')
          .select('*')
          .eq('user_id', user.id)
          .eq('is_deleted', false)
          .gte('date', startOfMonthISO())
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase.from('budgets').select('*').eq('user_id', user.id).eq('month', currentMonth),
      ]);

      if (expenseRes.error) throw expenseRes.error;
      const rows = (expenseRes.data ?? []) as DailyExpense[];
      setExpenses(rows);

      if (budgetRes.error) throw budgetRes.error;
      const budgetRows = (budgetRes.data ?? []) as Budget[];
      setBudgets(budgetRows);

      // Keep a snapshot so an offline launch shows real figures.
      writeCache(`tracker.${user.id}.${currentMonth}`, { expenses: rows, budgets: budgetRows });
    } catch (err) {
      const cached = readCache<{ expenses: DailyExpense[]; budgets: Budget[] }>(
        `tracker.${user.id}.${currentMonth}`
      );
      if (cached && !navigator.onLine) {
        setExpenses(cached.value.expenses);
        setBudgets(cached.value.budgets);
        setError(null);
      } else {
        setError(friendlyDbError(err, 'Could not load your tracker.'));
      }
    } finally {
      setLoading(false);
    }
  }, [user.id, currentMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = todayISO();
  const todayTotal = useMemo(
    () => roundMoney(expenses.filter((e) => e.date === today).reduce((sum, e) => sum + Number(e.amount), 0)),
    [expenses, today]
  );
  const monthTotal = useMemo(
    () => roundMoney(expenses.reduce((sum, e) => sum + Number(e.amount), 0)),
    [expenses]
  );

  const spentByCategory = useMemo(() => {
    const map: Record<string, number> = {};
    for (const expense of expenses) {
      map[expense.category] = roundMoney((map[expense.category] ?? 0) + Number(expense.amount));
    }
    return map;
  }, [expenses]);

  const budgetRows = useMemo(
    () =>
      budgets
        .map((budget) => {
          const spent = spentByCategory[budget.category] ?? 0;
          const limit = Number(budget.monthly_limit);
          return { budget, spent, limit, percent: limit > 0 ? (spent / limit) * 100 : 0 };
        })
        .sort((a, b) => b.percent - a.percent),
    [budgets, spentByCategory]
  );

  const totalBudget = budgetRows.reduce((sum, row) => sum + row.limit, 0);
  const overBudget = budgetRows.filter((row) => row.spent > row.limit);

  // Group the list by day so the history reads as a diary, not a flat dump.
  const grouped = useMemo(() => {
    const map = new Map<string, DailyExpense[]>();
    for (const expense of expenses) {
      const list = map.get(expense.date) ?? [];
      list.push(expense);
      map.set(expense.date, list);
    }
    return Array.from(map.entries());
  }, [expenses]);

  const resetForm = () => {
    setTitle('');
    setAmountStr('');
    setCategory('FOOD');
    setDate(todayISO());
    setNote('');
    setReceiptPath(null);
    setRecurring(false);
    setFrequency('MONTHLY');
  };

  const openAdd = () => {
    setEditing(null);
    resetForm();
    setShowAdd(true);
  };

  const openEdit = (expense: DailyExpense) => {
    setEditing(expense);
    setTitle(expense.title);
    setAmountStr(String(expense.amount));
    setCategory(expense.category);
    setDate(expense.date);
    setNote(expense.note ?? '');
    setReceiptPath(expense.receipt_url ?? null);
    setShowAdd(true);
  };

  const closeForm = () => {
    setShowAdd(false);
    setEditing(null);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = roundMoney(parseAmount(amountStr));
    if (!title.trim()) return toast.error('Give the expense a title.');
    if (amount <= 0) return toast.error('Enter an amount greater than zero.');

    if (editing) {
      if (!online) return toast.error('Editing requires an internet connection.');
      setSaving(true);
      try {
        const { error: updateError } = await supabase
          .from('daily_expenses')
          .update({
            title: title.trim(),
            amount,
            category,
            date,
            note: note.trim(),
            receipt_url: receiptPath,
          })
          .eq('id', editing.id);
        if (updateError) throw updateError;
        toast.success('Updated.');
        closeForm();
        await load();
      } catch (err) {
        toast.error(friendlyDbError(err, 'Could not update the entry.'));
      } finally {
        setSaving(false);
      }
      return;
    }

    const payload = {
      user_id: user.id,
      title: title.trim(),
      amount,
      category,
      date,
      note: note.trim(),
      receipt_url: receiptPath,
    };

    // Personal entries have no shared state to conflict with, so they can be
    // queued offline and replayed safely once the connection returns.
    if (!online) {
      queueWrite('daily_expenses', payload);
      setExpenses((current) =>
        [{ ...payload, id: `pending-${Date.now()}`, is_deleted: false, created_at: new Date().toISOString() } as DailyExpense, ...current]
      );
      toast.info('Saved offline — it will sync when you are back online.');
      closeForm();
      return;
    }

    setSaving(true);
    try {
      const { error: insertError } = await supabase.from('daily_expenses').insert(payload);
      if (insertError) throw insertError;

      if (recurring) {
        const { error: recurringError } = await supabase.from('recurring_expenses').insert({
          user_id: user.id,
          group_id: null,
          title: title.trim(),
          amount,
          category,
          notes: note.trim(),
          frequency,
          next_run: nextRunAfter(date, frequency),
        });
        if (recurringError) toast.error('Entry saved, but the repeat schedule could not be created.');
      }

      toast.success(recurring ? `Logged and repeating ${frequency.toLowerCase()}.` : 'Logged.');
      closeForm();
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not save the expense.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (expense: DailyExpense) => {
    const ok = await confirm({
      title: 'Delete this entry?',
      message: `"${expense.title}" will be removed from your tracker.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      const { error: deleteError } = await supabase
        .from('daily_expenses')
        .update({ is_deleted: true, deleted_at: new Date().toISOString() })
        .eq('id', expense.id);
      if (deleteError) throw deleteError;
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not delete the entry.'));
    }
  };

  const openBudgets = () => {
    setBudgetDrafts(
      Object.fromEntries(
        CATEGORIES.map((cat) => {
          const existing = budgets.find((b) => b.category === cat.id);
          return [cat.id, existing ? String(Number(existing.monthly_limit)) : ''];
        })
      )
    );
    setShowBudgets(true);
  };

  const handleSaveBudgets = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBudgets(true);

    try {
      const toUpsert = CATEGORIES.map((cat) => ({
        category: cat.id,
        limit: roundMoney(parseAmount(budgetDrafts[cat.id] ?? '')),
      }));

      const rows = toUpsert
        .filter((row) => row.limit > 0)
        .map((row) => ({
          user_id: user.id,
          category: row.category,
          monthly_limit: row.limit,
          month: currentMonth,
        }));

      const cleared = toUpsert.filter((row) => row.limit <= 0).map((row) => row.category);

      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from('budgets')
          .upsert(rows, { onConflict: 'user_id,category,month' });
        if (upsertError) throw upsertError;
      }

      // A blank or zero limit means "no budget for this category".
      if (cleared.length > 0) {
        const { error: deleteError } = await supabase
          .from('budgets')
          .delete()
          .eq('user_id', user.id)
          .eq('month', currentMonth)
          .in('category', cleared);
        if (deleteError) throw deleteError;
      }

      toast.success('Budgets saved.');
      setShowBudgets(false);
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not save your budgets.'));
    } finally {
      setSavingBudgets(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Tracker</h1>
          <p className="page-subtitle">{monthLabel(currentMonth)}</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>
          <Plus size={15} /> Log
        </button>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <section className="card-hero is-neutral" style={{ marginBottom: 'var(--sp-4)' }}>
        <span className="label">Spent this month</span>
        <div className="amount-xl tabular" style={{ margin: '6px 0 4px' }}>
          {formatLKR(monthTotal)}
        </div>
        {totalBudget > 0 && (
          <span className="hint">
            of {formatLKR(totalBudget)} budgeted · {Math.round((monthTotal / totalBudget) * 100)}% used
          </span>
        )}

        <div className="row card-divider" style={{ gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}>
          <div>
            <div className="label">Today</div>
            <div className="amount-md tabular" style={{ color: 'var(--accent)' }}>
              {formatLKR(todayTotal)}
            </div>
          </div>
          <div>
            <div className="label">Entries</div>
            <div className="amount-md tabular text-muted">{expenses.length}</div>
          </div>
        </div>
      </section>

      {overBudget.length > 0 && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="warning">
            Over budget in {overBudget.map((row) => categoryMeta(row.budget.category).name).join(', ')}.
          </Alert>
        </div>
      )}

      <div className="row-between" style={{ marginBottom: 'var(--sp-3)' }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Monthly budgets
        </h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={openBudgets}>
          <Wallet size={14} /> {budgets.length > 0 ? 'Edit' : 'Set budgets'}
        </button>
      </div>

      {budgetRows.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No budgets set"
          text="Set a monthly limit per category and MoneyMate will track how much is left."
          action={
            <button type="button" className="btn btn-primary" onClick={openBudgets}>
              Set budgets
            </button>
          }
        />
      ) : (
        <div className="stack-sm">
          {budgetRows.map(({ budget, spent, limit, percent }) => {
            const meta = categoryMeta(budget.category);
            const remaining = limit - spent;
            const barColor =
              percent >= 100 ? 'var(--negative)' : percent >= 80 ? 'var(--warning)' : meta.color[resolved];
            return (
              <div key={budget.id} className="card">
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span aria-hidden="true">{meta.emoji}</span>
                    <span className="truncate" style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {meta.name}
                    </span>
                  </span>
                  <span className="tabular hint">
                    {formatLKR(spent)} / {formatLKR(limit)}
                  </span>
                </div>
                <ProgressBar percent={percent} color={barColor} />
                <div className="hint" style={{ marginTop: 6 }}>
                  {remaining >= 0
                    ? `${formatLKR(remaining)} left`
                    : `${formatLKR(Math.abs(remaining))} over budget`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="section-title">This month's entries</h2>

      {loading ? (
        <SkeletonRows count={4} height={60} />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon="📆"
          title="Nothing logged yet"
          text="Track a coffee, a tuk ride, anything — it all feeds your analytics."
          action={
            <button type="button" className="btn btn-primary" onClick={openAdd}>
              Log an expense
            </button>
          }
        />
      ) : (
        <div className="stack">
          {grouped.map(([day, entries]) => {
            const dayTotal = roundMoney(entries.reduce((sum, e) => sum + Number(e.amount), 0));
            return (
              <div key={day}>
                <div className="row-between" style={{ marginBottom: 'var(--sp-2)' }}>
                  <span className="label">{friendlyDate(day)}</span>
                  <span className="hint tabular">{formatLKR(dayTotal)}</span>
                </div>
                <div className="card card-flush">
                  {entries.map((expense) => {
                    const meta = categoryMeta(expense.category);
                    return (
                      <div key={expense.id} className="list-row">
                        <span className="icon-tile" style={{ width: 34, height: 34, fontSize: 16 }}>
                          {meta.emoji}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="truncate" style={{ display: 'block', fontSize: '0.89rem', fontWeight: 600 }}>
                            {expense.title}
                          </span>
                          <span className="hint">{expense.note || meta.name}</span>
                        </span>
                        <span className="amount-md tabular">{formatLKR(expense.amount)}</span>
                        <span className="row" style={{ gap: 4, flexShrink: 0 }}>
                          <button
                            type="button"
                            className="btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => openEdit(expense)}
                            aria-label={`Edit ${expense.title}`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => handleDelete(expense)}
                            aria-label={`Delete ${expense.title}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <Sheet title={editing ? 'Edit expense' : 'Log an expense'} onClose={closeForm}>
          <form onSubmit={handleSubmit} className="stack">
            <input
              type="text"
              className="input"
              placeholder="What did you spend on?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />

            <div className="input-prefixed">
              <span className="input-prefix">Rs.</span>
              <input
                type="text"
                inputMode="decimal"
                className="input tabular"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <span className="label label-block">Category</span>
              <div className="rail">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className={`chip ${category === cat.id ? 'is-selected' : ''}`}
                    onClick={() => setCategory(cat.id)}
                  >
                    {cat.emoji} {cat.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label className="label label-block" htmlFor="entry-date">
                Date
              </label>
              <input
                id="entry-date"
                type="date"
                className="input"
                value={date}
                max={todayISO()}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>

            <input
              type="text"
              className="input"
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={140}
            />

            <ReceiptPicker
              scope={{ kind: 'personal', userId: user.id }}
              value={receiptPath}
              onChange={setReceiptPath}
              onScanned={(result) => {
                if (result.amount && !amountStr) setAmountStr(result.amount.toFixed(2));
                if (result.merchant && !title) setTitle(result.merchant);
                if (result.date) setDate(result.date);
              }}
            />

            {!editing && (
              <div className="field">
                <label className="row" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={recurring}
                    onChange={(e) => setRecurring(e.target.checked)}
                  />
                  <Repeat size={15} color="var(--primary)" />
                  <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>Repeat this entry</span>
                </label>

                {recurring && (
                  <>
                    <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                      {FREQUENCIES.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={`chip ${frequency === option.id ? 'is-selected' : ''}`}
                          style={{ display: 'flex', justifyContent: 'center' }}
                          onClick={() => setFrequency(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className="hint">Good for rent, subscriptions and season tickets.</span>
                  </>
                )}
              </div>
            )}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
              {saving && <Spinner />}
              {saving ? 'Saving…' : editing ? 'Save changes' : online ? 'Save entry' : 'Save offline'}
            </button>
          </form>
        </Sheet>
      )}

      {showBudgets && (
        <Sheet title={`Budgets · ${monthLabel(currentMonth)}`} onClose={() => setShowBudgets(false)}>
          <form onSubmit={handleSaveBudgets} className="stack">
            <p className="text-muted" style={{ fontSize: '0.86rem' }}>
              Set a monthly limit per category. Leave a field blank to remove its budget.
            </p>

            {CATEGORIES.map((cat) => (
              <div key={cat.id} className="row-between">
                <span className="row grow" style={{ gap: 8, minWidth: 0 }}>
                  <span aria-hidden="true">{cat.emoji}</span>
                  <span className="truncate" style={{ fontSize: '0.88rem' }}>
                    {cat.name}
                  </span>
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input input-sm tabular"
                  style={{ width: 110 }}
                  placeholder="No limit"
                  value={budgetDrafts[cat.id] ?? ''}
                  onChange={(e) => setBudgetDrafts({ ...budgetDrafts, [cat.id]: e.target.value })}
                />
              </div>
            ))}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={savingBudgets}>
              {savingBudgets && <Spinner />}
              {savingBudgets ? 'Saving…' : 'Save budgets'}
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
};
