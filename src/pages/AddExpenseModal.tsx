import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Expense, ExpenseCategory, GroupMember, SplitMethod, User } from '../types';
import { allocate, formatLKR, parseAmount, roundMoney, splitEvenly } from '../lib/currency';
import { CATEGORIES } from '../lib/categories';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, Sheet, Spinner } from '../components/ui';
import { ReceiptPicker } from '../components/ReceiptPicker';
import { useToast } from '../components/Toast';
import { todayISO } from '../lib/dates';
import { Plus, Repeat, Save, Trash2 } from 'lucide-react';

interface AddExpenseModalProps {
  groupId: string;
  user: User;
  members: GroupMember[];
  /** When present the modal edits this expense instead of creating one. */
  expense?: Expense | null;
  /** Group defaults, used to pre-fill a brand new bill. */
  defaults?: {
    method: SplitMethod;
    shares: Record<string, number>;
    included: Record<string, boolean>;
  };
  onClose: () => void;
  onSaved: () => void;
}

const FREQUENCIES = [
  { id: 'DAILY', label: 'Daily' },
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'MONTHLY', label: 'Monthly' },
] as const;

const SPLIT_METHODS: { id: SplitMethod; label: string; hint: string }[] = [
  { id: 'EQUAL', label: 'Equal', hint: 'Split evenly between everyone included.' },
  { id: 'UNEQUAL', label: 'Custom', hint: 'Type the exact rupee amount each person owes.' },
  { id: 'PERCENTAGE', label: 'Percent', hint: 'Give each person a share of the bill as a percentage.' },
  { id: 'SHARES', label: 'Shares', hint: 'Weight by shares — 2 shares pays twice as much as 1.' },
  { id: 'ITEMIZED', label: 'Itemized', hint: 'Add each line and tick who is on it.' },
];

interface LineItem {
  key: string;
  name: string;
  amount: string;
  sharedBy: string[];
}

const newLineItem = (memberIds: string[]): LineItem => ({
  key: Math.random().toString(36).slice(2),
  name: '',
  amount: '',
  sharedBy: memberIds,
});

/** First date after `from` on the given cadence. */
const nextRunAfter = (from: string, frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'): string => {
  const date = new Date(`${from}T00:00:00`);
  if (frequency === 'DAILY') date.setDate(date.getDate() + 1);
  else if (frequency === 'WEEKLY') date.setDate(date.getDate() + 7);
  else date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
};

export const AddExpenseModal: React.FC<AddExpenseModalProps> = ({
  groupId,
  user,
  members,
  expense,
  defaults,
  onClose,
  onSaved,
}) => {
  const toast = useToast();
  const isEditing = Boolean(expense);
  const memberIds = useMemo(() => members.map((m) => m.user_id), [members]);

  const [title, setTitle] = useState(expense?.title ?? '');
  const [amountStr, setAmountStr] = useState(expense ? String(expense.amount) : '');
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? 'OTHER');
  // A new bill starts from the group's saved default; an edit keeps its own.
  const [splitMethod, setSplitMethod] = useState<SplitMethod>(
    expense?.split_method ?? defaults?.method ?? 'EQUAL'
  );
  const [paidBy, setPaidBy] = useState(expense?.paid_by ?? user.id);
  const [notes, setNotes] = useState(expense?.notes ?? '');

  // When editing, these start neutral and are replaced by the expense's stored
  // splits in the effect below. Defaulting everyone to `true` here is what made
  // an edit silently re-include people the bill had deliberately left out.
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      memberIds.map((id) => [id, isEditing ? false : (defaults?.included[id] ?? true)])
    )
  );
  const [loadingSplits, setLoadingSplits] = useState(isEditing);
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      memberIds.map((id) => [id, String(isEditing ? 1 : (defaults?.shares[id] ?? 1))])
    )
  );
  const [items, setItems] = useState<LineItem[]>(() => [newLineItem(memberIds)]);

  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('MONTHLY');
  const [savingDefaults, setSavingDefaults] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On by default: a bill you are entering yourself and are part of is your own
  // spending. The confirmation flow exists for what other people add, not for
  // making you tick a box to see your own expenses in your own charts.
  const [statsChoice, setStatsChoice] = useState(true);

  // Rebuild the form from what was actually saved: who was in, and the exact
  // per-person figures for whichever split method was used. Without this an edit
  // reopens as an even split across everybody and saving rewrites the bill.
  useEffect(() => {
    if (!expense) return;
    let active = true;

    void (async () => {
      const { data, error: splitError } = await supabase
        .from('expense_splits')
        .select('user_id, is_included, amount, percentage, shares, include_in_stats')
        .eq('expense_id', expense.id);

      if (!active) return;
      if (splitError || !data) {
        setLoadingSplits(false);
        return;
      }

      const inc: Record<string, boolean> = {};
      const amts: Record<string, string> = {};
      const pcts: Record<string, string> = {};
      const shr: Record<string, string> = {};

      for (const row of data as any[]) {
        inc[row.user_id] = Boolean(row.is_included);
        amts[row.user_id] = String(Number(row.amount));
        pcts[row.user_id] = String(Number(row.percentage ?? 0));
        shr[row.user_id] = String(Number(row.shares ?? 1));
        if (row.user_id === user.id) setStatsChoice(row.include_in_stats === true);
      }

      // A member added to the group after this bill has no split row at all.
      for (const id of memberIds) if (!(id in inc)) inc[id] = false;

      setIncluded(inc);
      setCustomAmounts(amts);
      setPercentages(pcts);
      setShares(shr);
      setLoadingSplits(false);
    })();

    return () => {
      active = false;
    };
  }, [expense?.id, memberIds, user.id]);

  const amount = roundMoney(parseAmount(amountStr));
  const includedMembers = members.filter((m) => included[m.user_id]);

  const itemsTotal = useMemo(
    () => roundMoney(items.reduce((sum, item) => sum + parseAmount(item.amount), 0)),
    [items]
  );

  /**
   * Derives every member's share for the chosen method. Returns per-user
   * amounts that sum to exactly the bill total, plus a validation message when
   * the inputs do not describe a valid split.
   */
  const computed = useMemo(() => {
    const effectiveTotal = splitMethod === 'ITEMIZED' ? itemsTotal : amount;
    const perUser: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));

    if (effectiveTotal <= 0) {
      return { perUser, total: effectiveTotal, problem: null as string | null };
    }
    if (splitMethod !== 'ITEMIZED' && includedMembers.length === 0) {
      return { perUser, total: effectiveTotal, problem: 'Include at least one person in the split.' };
    }

    if (splitMethod === 'EQUAL') {
      const parts = splitEvenly(effectiveTotal, includedMembers.length);
      includedMembers.forEach((m, i) => {
        perUser[m.user_id] = parts[i];
      });
      return { perUser, total: effectiveTotal, problem: null };
    }

    if (splitMethod === 'UNEQUAL') {
      let sum = 0;
      for (const m of includedMembers) {
        const value = roundMoney(parseAmount(customAmounts[m.user_id] ?? ''));
        perUser[m.user_id] = value;
        sum = roundMoney(sum + value);
      }
      const problem =
        Math.abs(sum - effectiveTotal) > 0.005
          ? `Custom amounts add up to ${formatLKR(sum)}, but the bill is ${formatLKR(effectiveTotal)}.`
          : null;
      return { perUser, total: effectiveTotal, problem };
    }

    if (splitMethod === 'PERCENTAGE') {
      const weights = includedMembers.map((m) => Math.max(parseAmount(percentages[m.user_id] ?? ''), 0));
      const totalPercent = roundMoney(weights.reduce((a, b) => a + b, 0));
      if (Math.abs(totalPercent - 100) > 0.01) {
        return {
          perUser,
          total: effectiveTotal,
          problem: `Percentages add up to ${totalPercent}%, not 100%.`,
        };
      }
      const parts = allocate(effectiveTotal, weights);
      includedMembers.forEach((m, i) => {
        perUser[m.user_id] = parts[i];
      });
      return { perUser, total: effectiveTotal, problem: null };
    }

    if (splitMethod === 'SHARES') {
      const weights = includedMembers.map((m) => Math.max(parseInt(shares[m.user_id] ?? '1', 10) || 0, 0));
      if (weights.reduce((a, b) => a + b, 0) <= 0) {
        return { perUser, total: effectiveTotal, problem: 'Give at least one person a share above zero.' };
      }
      const parts = allocate(effectiveTotal, weights);
      includedMembers.forEach((m, i) => {
        perUser[m.user_id] = parts[i];
      });
      return { perUser, total: effectiveTotal, problem: null };
    }

    // ITEMIZED — each line is split evenly between the people on it, then
    // every member's lines are summed.
    const named = items.filter((item) => parseAmount(item.amount) > 0);
    if (named.length === 0) {
      return { perUser, total: effectiveTotal, problem: 'Add at least one line item with an amount.' };
    }
    const unassigned = named.find((item) => item.sharedBy.length === 0);
    if (unassigned) {
      return {
        perUser,
        total: effectiveTotal,
        problem: `"${unassigned.name || 'Untitled item'}" has nobody assigned to it.`,
      };
    }

    for (const item of named) {
      const parts = splitEvenly(roundMoney(parseAmount(item.amount)), item.sharedBy.length);
      item.sharedBy.forEach((uid, i) => {
        perUser[uid] = roundMoney((perUser[uid] ?? 0) + parts[i]);
      });
    }
    return { perUser, total: effectiveTotal, problem: null };
  }, [splitMethod, amount, itemsTotal, includedMembers, memberIds, customAmounts, percentages, shares, items]);

  const toggleIncluded = (userId: string) =>
    setIncluded((prev) => ({ ...prev, [userId]: !prev[userId] }));

  /** Remembers this configuration so the next bill in this group starts here. */
  const handleSaveDefaults = async () => {
    setSavingDefaults(true);
    try {
      const { error: rpcError } = await supabase.rpc('save_split_defaults', {
        p_group_id: groupId,
        p_method: splitMethod,
        p_members: members.map((m) => ({
          user_id: m.user_id,
          share: parseInt(shares[m.user_id] ?? '1', 10) || 1,
          included: Boolean(included[m.user_id]),
        })),
      });
      if (rpcError) throw rpcError;
      toast.success('Saved as this group’s default split.');
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not save the default split.'));
    } finally {
      setSavingDefaults(false);
    }
  };

  const toggleItemMember = (itemKey: string, userId: string) =>
    setItems((prev) =>
      prev.map((item) =>
        item.key === itemKey
          ? {
              ...item,
              sharedBy: item.sharedBy.includes(userId)
                ? item.sharedBy.filter((id) => id !== userId)
                : [...item.sharedBy, userId],
            }
          : item
      )
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) return setError('Give the expense a title.');

    const total = computed.total;
    if (total <= 0) {
      return setError(
        splitMethod === 'ITEMIZED' ? 'Add line items with amounts.' : 'Enter an amount greater than zero.'
      );
    }
    if (computed.problem) return setError(computed.problem);

    // The database rejects a split set that does not reconstruct the total, so
    // build the payload from the derived amounts rather than raw input.
    const splits = members.map((m) => {
      const share = computed.perUser[m.user_id] ?? 0;
      const isIncluded = splitMethod === 'ITEMIZED' ? share > 0 : Boolean(included[m.user_id]);
      return {
        user_id: m.user_id,
        is_included: isIncluded,
        amount: isIncluded ? share : 0,
        percentage: splitMethod === 'PERCENTAGE' ? parseAmount(percentages[m.user_id] ?? '') : 0,
        shares: splitMethod === 'SHARES' ? parseInt(shares[m.user_id] ?? '1', 10) || 0 : 1,
        // Answered here only for myself. Everyone else's split is left undecided
        // so their own charts are never changed by a bill I typed.
        stats: m.user_id === user.id ? statsChoice : undefined,
      };
    });

    const payloadItems =
      splitMethod === 'ITEMIZED'
        ? items
            .filter((item) => parseAmount(item.amount) > 0)
            .map((item) => ({
              name: item.name.trim() || 'Item',
              amount: roundMoney(parseAmount(item.amount)),
              shared_by: item.sharedBy,
            }))
        : [];

    setSaving(true);
    try {
      const args = {
        p_title: title.trim(),
        p_amount: total,
        p_paid_by: paidBy,
        p_category: category,
        p_split_method: splitMethod,
        p_notes: notes.trim(),
        p_splits: splits,
        p_items: payloadItems,
      };

      // Both RPCs write the expense, its splits, its items and the ledger pair
      // in one transaction — a partial save can never corrupt balances.
      const { data: savedId, error: rpcError } = isEditing
        ? await supabase.rpc('update_expense', { p_expense_id: expense!.id, ...args })
        : await supabase.rpc('save_expense', { p_group_id: groupId, ...args });

      if (rpcError) throw rpcError;

      // The receipt is attached after the row exists, so a failed save never
      // leaves an orphaned image reference.
      const expenseId = isEditing ? expense!.id : (savedId as string);
      if (receiptPath && expenseId) {
        await supabase.from('expenses').update({ receipt_url: receiptPath }).eq('id', expenseId);
      }

      if (recurring && !isEditing) {
        const { error: recurringError } = await supabase.from('recurring_expenses').insert({
          user_id: user.id,
          group_id: groupId,
          title: title.trim(),
          amount: total,
          category,
          notes: notes.trim(),
          paid_by: paidBy,
          split_method: splitMethod,
          splits,
          frequency,
          // The bill just posted counts as this period, so schedule the next.
          next_run: nextRunAfter(todayISO(), frequency),
        });
        if (recurringError) {
          toast.error('Expense saved, but the repeat schedule could not be created.');
        }
      }

      toast.success(
        isEditing
          ? 'Expense updated.'
          : recurring
            ? `Expense added and set to repeat ${frequency.toLowerCase()}.`
            : 'Expense added.'
      );
      onSaved();
    } catch (err) {
      setError(friendlyDbError(err, 'Could not save the expense.'));
    } finally {
      setSaving(false);
    }
  };

  const activeMethod = SPLIT_METHODS.find((m) => m.id === splitMethod);

  return (
    <Sheet title={isEditing ? 'Edit expense' : 'Add expense'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="stack">
        <input
          type="text"
          className="input"
          placeholder="What was it for? (e.g. Dinner at Ministry of Crab)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus={!isEditing}
          required
        />

        {splitMethod !== 'ITEMIZED' ? (
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
        ) : (
          <div className="card row-between" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
            <span className="label">Total from items</span>
            <span className="amount-md tabular">{formatLKR(itemsTotal)}</span>
          </div>
        )}

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
          <label className="label label-block" htmlFor="paid-by">
            Who paid?
          </label>
          <select id="paid-by" className="input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.user_id === user.id ? 'Me' : `${m.user?.display_name ?? 'Member'} (proxy entry)`}
              </option>
            ))}
          </select>
          {paidBy !== user.id && (
            <span className="hint">
              Recorded on their behalf — they get the credit, you stay logged as the author.
            </span>
          )}
        </div>

        <div className="field">
          <span className="label label-block">Split method</span>
          <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {SPLIT_METHODS.map((method) => (
              <button
                key={method.id}
                type="button"
                className={`chip ${splitMethod === method.id ? 'is-selected' : ''}`}
                style={{ justifyContent: 'center', display: 'flex' }}
                onClick={() => setSplitMethod(method.id)}
              >
                {method.label}
              </button>
            ))}
          </div>
          {activeMethod && <span className="hint">{activeMethod.hint}</span>}
        </div>

        {splitMethod === 'ITEMIZED' ? (
          <div className="field">
            <span className="label label-block">Line items</span>
            <div className="stack">
              {items.map((item, index) => (
                <div key={item.key} className="card" style={{ padding: 'var(--sp-3)' }}>
                  <div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
                    <input
                      type="text"
                      className="input input-sm grow"
                      placeholder={`Item ${index + 1}`}
                      value={item.name}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((it) => (it.key === item.key ? { ...it, name: e.target.value } : it))
                        )
                      }
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      className="input input-sm tabular"
                      style={{ width: 92 }}
                      placeholder="0.00"
                      value={item.amount}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((it) => (it.key === item.key ? { ...it, amount: e.target.value } : it))
                        )
                      }
                    />
                    <button
                      type="button"
                      className="btn-icon"
                      style={{ width: 32, height: 32 }}
                      aria-label="Remove item"
                      onClick={() => setItems((prev) => prev.filter((it) => it.key !== item.key))}
                      disabled={items.length === 1}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {members.map((m) => (
                      <button
                        key={m.user_id}
                        type="button"
                        className={`chip ${item.sharedBy.includes(m.user_id) ? 'is-selected' : ''}`}
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => toggleItemMember(item.key, m.user_id)}
                      >
                        {m.user_id === user.id ? 'Me' : m.user?.display_name ?? 'Member'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 'var(--sp-2)' }}
              onClick={() => setItems((prev) => [...prev, newLineItem(memberIds)])}
            >
              <Plus size={14} /> Add item
            </button>
          </div>
        ) : (
          <div className="field">
            <span className="label label-block">
              Who is in on this? ({includedMembers.length}/{members.length})
            </span>
            <div className="stack-sm">
              {members.map((m) => {
                const isIn = Boolean(included[m.user_id]);
                return (
                  <div key={m.user_id} className="row-between">
                    <label className="row grow" style={{ cursor: 'pointer', minWidth: 0 }}>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={isIn}
                        onChange={() => toggleIncluded(m.user_id)}
                      />
                      <Avatar name={m.user?.display_name} url={m.user?.avatar_url} size={28} />
                      <span
                        className="truncate"
                        style={{ fontSize: '0.9rem', color: isIn ? 'var(--on-background)' : 'var(--on-surface-faint)' }}
                      >
                        {m.user_id === user.id ? 'Me' : m.user?.display_name ?? 'Member'}
                      </span>
                    </label>

                    {isIn && splitMethod === 'EQUAL' && (
                      <span className="hint tabular">
                        {computed.total > 0 ? formatLKR(computed.perUser[m.user_id] ?? 0) : '—'}
                      </span>
                    )}
                    {isIn && splitMethod === 'UNEQUAL' && (
                      <input
                        type="text"
                        inputMode="decimal"
                        className="input input-sm tabular"
                        style={{ width: 96 }}
                        placeholder="0.00"
                        value={customAmounts[m.user_id] ?? ''}
                        onChange={(e) =>
                          setCustomAmounts({ ...customAmounts, [m.user_id]: e.target.value })
                        }
                      />
                    )}
                    {isIn && splitMethod === 'PERCENTAGE' && (
                      <input
                        type="text"
                        inputMode="decimal"
                        className="input input-sm tabular"
                        style={{ width: 74 }}
                        placeholder="%"
                        value={percentages[m.user_id] ?? ''}
                        onChange={(e) => setPercentages({ ...percentages, [m.user_id]: e.target.value })}
                      />
                    )}
                    {isIn && splitMethod === 'SHARES' && (
                      <input
                        type="number"
                        min={0}
                        className="input input-sm tabular"
                        style={{ width: 68 }}
                        value={shares[m.user_id] ?? '1'}
                        onChange={(e) => setShares({ ...shares, [m.user_id]: e.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Live preview of what each person ends up owing. */}
        {computed.total > 0 && !computed.problem && (
          <div className="card" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
            <span className="label label-block">Each person owes</span>
            <div className="stack-sm">
              {members
                .filter((m) => (computed.perUser[m.user_id] ?? 0) > 0)
                .map((m) => (
                  <div key={m.user_id} className="row-between">
                    <span className="truncate" style={{ fontSize: '0.85rem' }}>
                      {m.user_id === user.id ? 'Me' : m.user?.display_name ?? 'Member'}
                    </span>
                    <span className="tabular" style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                      {formatLKR(computed.perUser[m.user_id] ?? 0)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {computed.problem && <Alert variant="warning">{computed.problem}</Alert>}

        {/* Saving the arrangement is only useful for a fresh bill. */}
        {!isEditing && splitMethod !== 'ITEMIZED' && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSaveDefaults}
            disabled={savingDefaults}
            style={{ alignSelf: 'flex-start' }}
          >
            {savingDefaults ? <Spinner /> : <Save size={14} />}
            Save this as the group’s default split
          </button>
        )}

        <ReceiptPicker
          scope={{ kind: 'group', groupId }}
          value={receiptPath}
          onChange={setReceiptPath}
          onScanned={(result) => {
            // Only fill blanks — never overwrite something already typed.
            if (result.amount && !amountStr) setAmountStr(result.amount.toFixed(2));
            if (result.merchant && !title) setTitle(result.merchant);
          }}
        />

        {!isEditing && (
          <div className="field">
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={recurring}
                onChange={(e) => setRecurring(e.target.checked)}
              />
              <Repeat size={15} color="var(--primary)" />
              <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>Repeat this bill</span>
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
                <span className="hint">
                  Posts automatically with this same split. If the app is not opened for a while, any
                  missed occurrences are filled in on the next visit.
                </span>
              </>
            )}
          </div>
        )}

        <textarea
          className="input"
          placeholder="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {includedMembers.some((m) => m.user_id === user.id) && (
          <label className="card row" style={{ cursor: 'pointer', gap: 'var(--sp-3)' }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={statsChoice}
              onChange={(e) => setStatsChoice(e.target.checked)}
            />
            <span className="grow" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem' }}>
                Count my share in my stats
              </span>
              <span className="hint">
                Only affects your own charts. Everyone else decides for themselves.
              </span>
            </span>
          </label>
        )}

        {error && <Alert variant="error">{error}</Alert>}

        <button
          type="submit"
          className="btn btn-primary btn-block btn-lg"
          disabled={saving || Boolean(computed.problem)}
        >
          {saving && <Spinner />}
          {saving ? 'Saving…' : isEditing ? 'Save changes' : `Add ${computed.total > 0 ? formatLKR(computed.total) : 'expense'}`}
        </button>
      </form>
    </Sheet>
  );
};
