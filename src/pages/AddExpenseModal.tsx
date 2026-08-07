import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { GroupMember, User, ExpenseCategory } from '../types';
import { formatLKR } from '../lib/currency';
import { X } from 'lucide-react';

interface AddExpenseModalProps {
  groupId: string;
  user: User;
  members: GroupMember[];
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES: { id: ExpenseCategory; name: string; emoji: string }[] = [
  { id: 'FOOD', name: 'Food & Drinks', emoji: '🍔' },
  { id: 'TRANSPORT', name: 'Transport', emoji: '🚗' },
  { id: 'ACCOMMODATION', name: 'Accommodation', emoji: '🏠' },
  { id: 'ENTERTAINMENT', name: 'Entertainment', emoji: '🎉' },
  { id: 'SHOPPING', name: 'Shopping', emoji: '🛍️' },
  { id: 'HEALTH', name: 'Health', emoji: '💊' },
  { id: 'UTILITIES', name: 'Utilities', emoji: '💡' },
  { id: 'OTHER', name: 'Other', emoji: '📌' },
];

export const AddExpenseModal: React.FC<AddExpenseModalProps> = ({ groupId, user, members, onClose, onSaved }) => {
  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('OTHER');
  const [splitMethod, setSplitMethod] = useState<'EQUAL' | 'UNEQUAL' | 'PERCENTAGE' | 'SHARES'>('EQUAL');
  const [paidByUserId, setPaidByUserId] = useState<string>(user.id);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [includedMembers, setIncludedMembers] = useState<Record<string, boolean>>(
    members.reduce((acc, m) => ({ ...acc, [m.user_id]: true }), {})
  );
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>(
    members.reduce((acc, m) => ({ ...acc, [m.user_id]: '1' }), {})
  );

  const amount = parseFloat(amountStr) || 0;
  const includedList = members.filter((m) => includedMembers[m.user_id]);

  const toggleIncluded = (userId: string) => {
    setIncludedMembers((prev) => ({ ...prev, [userId]: !prev[userId] }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('Please enter an expense title'); return; }
    if (amount <= 0) { setError('Please enter a valid amount'); return; }
    if (includedList.length === 0) { setError('At least one member must be included in the split'); return; }

    setLoading(true);
    setError(null);

    try {
      const onBehalfOf = paidByUserId !== user.id ? paidByUserId : null;

      const { data: newExpense, error: expErr } = await supabase
        .from('expenses')
        .insert({
          group_id: groupId,
          title,
          amount,
          paid_by: paidByUserId,
          created_by: user.id,
          on_behalf_of: onBehalfOf,
          category,
          split_method: splitMethod,
          notes,
        })
        .select()
        .single();

      if (expErr) throw expErr;

      const splitRows: any[] = [];
      const ledgerEntries: any[] = [];

      ledgerEntries.push({
        group_id: groupId,
        user_id: paidByUserId,
        entry_type: 'EXPENSE',
        amount: amount,
        reference_id: newExpense.id,
        description: `Paid for ${title}`
      });

      if (splitMethod === 'EQUAL') {
        const perPerson = amount / includedList.length;
        members.forEach((m) => {
          const isInc = !!includedMembers[m.user_id];
          const shareAmount = isInc ? perPerson : 0;
          splitRows.push({
            expense_id: newExpense.id,
            user_id: m.user_id,
            is_included: isInc,
            amount: shareAmount
          });
          if (isInc) {
            ledgerEntries.push({
              group_id: groupId,
              user_id: m.user_id,
              entry_type: 'SPLIT',
              amount: -shareAmount,
              reference_id: newExpense.id,
              description: `Share of ${title}`
            });
          }
        });
      } else if (splitMethod === 'UNEQUAL') {
        members.forEach((m) => {
          const isInc = !!includedMembers[m.user_id];
          const val = isInc ? (parseFloat(customAmounts[m.user_id]) || 0) : 0;
          splitRows.push({ expense_id: newExpense.id, user_id: m.user_id, is_included: isInc, amount: val });
          if (isInc && val > 0) {
            ledgerEntries.push({
              group_id: groupId,
              user_id: m.user_id,
              entry_type: 'SPLIT',
              amount: -val,
              reference_id: newExpense.id,
              description: `Custom share of ${title}`
            });
          }
        });
      } else if (splitMethod === 'PERCENTAGE') {
        members.forEach((m) => {
          const isInc = !!includedMembers[m.user_id];
          const pct = isInc ? (parseFloat(percentages[m.user_id]) || 0) : 0;
          const shareAmount = (amount * pct) / 100;
          splitRows.push({ expense_id: newExpense.id, user_id: m.user_id, is_included: isInc, amount: shareAmount, percentage: pct });
          if (isInc && shareAmount > 0) {
            ledgerEntries.push({
              group_id: groupId,
              user_id: m.user_id,
              entry_type: 'SPLIT',
              amount: -shareAmount,
              reference_id: newExpense.id,
              description: `${pct}% share of ${title}`
            });
          }
        });
      } else if (splitMethod === 'SHARES') {
        const totalShares = includedList.reduce((acc, m) => acc + (parseInt(shares[m.user_id]) || 1), 0);
        members.forEach((m) => {
          const isInc = !!includedMembers[m.user_id];
          const userShares = isInc ? (parseInt(shares[m.user_id]) || 1) : 0;
          const shareAmount = totalShares > 0 ? (amount * userShares) / totalShares : 0;
          splitRows.push({ expense_id: newExpense.id, user_id: m.user_id, is_included: isInc, amount: shareAmount, shares: userShares });
          if (isInc && shareAmount > 0) {
            ledgerEntries.push({
              group_id: groupId,
              user_id: m.user_id,
              entry_type: 'SPLIT',
              amount: -shareAmount,
              reference_id: newExpense.id,
              description: `${userShares} share(s) of ${title}`
            });
          }
        });
      }

      await supabase.from('expense_splits').insert(splitRows);
      await supabase.from('ledger_entries').insert(ledgerEntries);

      onSaved();
    } catch (err: any) {
      setError(err.message || 'Failed to save expense');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--on-background)' }}>Add Expense</h3>
          <button onClick={onClose} className="btn-icon">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            type="text"
            placeholder="What was it for? (e.g. Dinner)"
            className="input-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <input
            type="number"
            step="0.01"
            placeholder="Amount in LKR (Rs. 0.00)"
            className="input-field"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            required
          />

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 6, display: 'block' }}>Category</label>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  style={{
                    padding: '6px 12px', borderRadius: 16, border: category === cat.id ? '1px solid var(--primary)' : '1px solid var(--card-border)',
                    background: category === cat.id ? 'var(--primary-container)' : 'var(--surface-variant)',
                    color: category === cat.id ? 'var(--primary-light)' : 'var(--on-surface)',
                    fontSize: '0.8rem', whiteSpace: 'nowrap', cursor: 'pointer'
                  }}
                >
                  {cat.emoji} {cat.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 6, display: 'block' }}>Who paid?</label>
            <select
              className="input-field"
              value={paidByUserId}
              onChange={(e) => setPaidByUserId(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.user_id === user.id ? 'Me' : m.user?.display_name} {m.user_id !== user.id && '(Proxy Entry)'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 6, display: 'block' }}>Split Method</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {(['EQUAL', 'UNEQUAL', 'PERCENTAGE', 'SHARES'] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setSplitMethod(method)}
                  style={{
                    padding: '8px 4px', borderRadius: 12, border: splitMethod === method ? '1px solid var(--primary)' : '1px solid var(--card-border)',
                    background: splitMethod === method ? 'var(--primary-container)' : 'var(--surface-variant)',
                    color: splitMethod === method ? 'var(--primary-light)' : 'var(--on-surface)',
                    fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', textAlign: 'center'
                  }}
                >
                  {method}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 8, display: 'block' }}>
              Who is included in this bill? ({includedList.length}/{members.length})
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {members.map((m) => {
                const isInc = !!includedMembers[m.user_id];
                return (
                  <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: '0.9rem', color: isInc ? 'var(--on-background)' : 'var(--on-surface-variant)' }}>
                      <input
                        type="checkbox"
                        checked={isInc}
                        onChange={() => toggleIncluded(m.user_id)}
                        style={{ accentColor: 'var(--primary)', width: 18, height: 18 }}
                      />
                      {m.user?.display_name}
                    </label>

                    {isInc && splitMethod === 'EQUAL' && (
                      <span style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>
                        {amount > 0 ? formatLKR(amount / includedList.length) : '—'}
                      </span>
                    )}

                    {isInc && splitMethod === 'UNEQUAL' && (
                      <input
                        type="number"
                        placeholder="Rs."
                        className="input-field"
                        style={{ width: 90, padding: '6px 10px', fontSize: '0.85rem' }}
                        value={customAmounts[m.user_id] || ''}
                        onChange={(e) => setCustomAmounts({ ...customAmounts, [m.user_id]: e.target.value })}
                      />
                    )}

                    {isInc && splitMethod === 'PERCENTAGE' && (
                      <input
                        type="number"
                        placeholder="%"
                        className="input-field"
                        style={{ width: 80, padding: '6px 10px', fontSize: '0.85rem' }}
                        value={percentages[m.user_id] || ''}
                        onChange={(e) => setPercentages({ ...percentages, [m.user_id]: e.target.value })}
                      />
                    )}

                    {isInc && splitMethod === 'SHARES' && (
                      <input
                        type="number"
                        placeholder="Shares"
                        className="input-field"
                        style={{ width: 70, padding: '6px 10px', fontSize: '0.85rem' }}
                        value={shares[m.user_id] || '1'}
                        onChange={(e) => setShares({ ...shares, [m.user_id]: e.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <input
            type="text"
            placeholder="Notes (optional)"
            className="input-field"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {error && <div style={{ color: 'var(--negative)', fontSize: '0.85rem' }}>{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading} style={{ height: 50, marginTop: 8 }}>
            {loading ? 'Saving…' : 'Save Expense'}
          </button>
        </form>
      </div>
    </div>
  );
};
