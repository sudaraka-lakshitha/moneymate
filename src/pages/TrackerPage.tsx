import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DailyExpense, User, ExpenseCategory } from '../types';
import { formatLKR } from '../lib/currency';
import { Plus, Trash2 } from 'lucide-react';

interface TrackerPageProps {
  user: User;
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

export const TrackerPage: React.FC<TrackerPageProps> = ({ user }) => {
  const [expenses, setExpenses] = useState<DailyExpense[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('OTHER');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  useEffect(() => {
    loadDailyExpenses();
  }, [user.id]);

  const loadDailyExpenses = async () => {
    try {
      const { data } = await supabase
        .from('daily_expenses')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_deleted', false)
        .order('date', { ascending: false });

      if (data) setExpenses(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(amountStr);
    if (!title || !amount) return;

    await supabase.from('daily_expenses').insert({
      user_id: user.id,
      title,
      amount,
      category,
      date,
    });

    setShowAddModal(false);
    setTitle('');
    setAmountStr('');
    loadDailyExpenses();
  };

  const handleDelete = async (id: string) => {
    await supabase.from('daily_expenses').update({ is_deleted: true }).eq('id', id);
    loadDailyExpenses();
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const todayExpenses = expenses.filter((e) => e.date === todayStr);
  const todayTotal = todayExpenses.reduce((acc, e) => acc + Number(e.amount), 0);
  const monthTotal = expenses.reduce((acc, e) => acc + Number(e.amount), 0);

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)' }}>Daily Tracker</h2>
        <button onClick={() => setShowAddModal(true)} className="btn-primary" style={{ padding: '8px 14px' }}>
          <Plus size={18} /> Add Daily
        </button>
      </div>

      <div className="glass-card-primary" style={{ padding: 20, marginBottom: 24 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>Total Spent This Month</span>
        <h2 style={{ fontSize: '2.2rem', fontWeight: 800, color: 'var(--on-background)', margin: '6px 0 16px' }}>
          {formatLKR(monthTotal)}
        </h2>
        <div style={{ display: 'flex', gap: 24, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 12 }}>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>Today's Total</span>
            <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: '1rem' }}>{formatLKR(todayTotal)}</div>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>Transactions</span>
            <div style={{ fontWeight: 700, color: 'var(--primary-light)', fontSize: '1rem' }}>{expenses.length}</div>
          </div>
        </div>
      </div>

      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 12 }}>Today's Expenses</h3>
      {todayExpenses.length === 0 ? (
        <div className="glass-card" style={{ padding: 20, textAlign: 'center', marginBottom: 24 }}>
          <span style={{ color: 'var(--on-surface-variant)', fontSize: '0.85rem' }}>No expenses logged today.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {todayExpenses.map((expense) => (
            <div key={expense.id} className="glass-card" style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 22 }}>{CATEGORIES.find((c) => c.id === expense.category)?.emoji || '📌'}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--on-background)' }}>{expense.title}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>{expense.category}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 700, color: 'var(--on-background)' }}>{formatLKR(expense.amount)}</span>
                <button onClick={() => handleDelete(expense.id)} style={{ background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 12 }}>Personal History</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {expenses.filter((e) => e.date !== todayStr).map((expense) => (
          <div key={expense.id} className="glass-card" style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 22 }}>{CATEGORIES.find((c) => c.id === expense.category)?.emoji || '📌'}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--on-background)' }}>{expense.title}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>{expense.date}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 700, color: 'var(--on-background)' }}>{formatLKR(expense.amount)}</span>
              <button onClick={() => handleDelete(expense.id)} style={{ background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 16 }}>Log Daily Expense</h3>
            <form onSubmit={handleAddExpense} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <input
                type="text"
                placeholder="Title (e.g. Lunch)"
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
              <input
                type="date"
                className="input-field"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />

              <button type="submit" className="btn-primary" style={{ height: 50, marginTop: 8 }}>
                Save Expense
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
