import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { formatLKR } from '../lib/currency';

interface AnalyticsPageProps {
  user: User;
}

const CATEGORY_COLORS: Record<string, string> = {
  FOOD: '#FF6B35',
  TRANSPORT: '#4ECDC4',
  ACCOMMODATION: '#6C63FF',
  ENTERTAINMENT: '#FFBE0B',
  SHOPPING: '#FF6B6B',
  HEALTH: '#2ECC71',
  UTILITIES: '#3498DB',
  OTHER: '#95A5A6',
};

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ user }) => {
  const [categoryTotals, setCategoryTotals] = useState<Record<string, number>>({});
  const [grandTotal, setGrandTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAnalytics();
  }, [user.id]);

  const loadAnalytics = async () => {
    try {
      const { data } = await supabase
        .from('daily_expenses')
        .select('category, amount')
        .eq('user_id', user.id)
        .eq('is_deleted', false);

      if (data) {
        const catMap: Record<string, number> = {};
        let total = 0;

        data.forEach((row) => {
          const cat = row.category || 'OTHER';
          const amt = Number(row.amount);
          catMap[cat] = (catMap[cat] || 0) + amt;
          total += amt;
        });

        setCategoryTotals(catMap);
        setGrandTotal(total);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const sortedCategories = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)', marginBottom: 20 }}>
        Analytics & Insights
      </h2>

      <div className="glass-card-primary" style={{ padding: 20, marginBottom: 24 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>Total Tracked Expenses</span>
        <h2 style={{ fontSize: '2.2rem', fontWeight: 800, color: 'var(--on-background)', margin: '6px 0 4px' }}>
          {formatLKR(grandTotal)}
        </h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
          {Object.keys(categoryTotals).length} categories active
        </span>
      </div>

      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 16 }}>
        Spending by Category
      </h3>

      {sortedCategories.length === 0 && !loading ? (
        <div className="glass-card" style={{ padding: 36, textAlign: 'center' }}>
          <span style={{ fontSize: 44 }}>📊</span>
          <p style={{ marginTop: 12, color: 'var(--on-surface-variant)', fontSize: '0.85rem' }}>
            No spending data recorded yet.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {sortedCategories.map(([category, amount]) => {
            const pct = grandTotal > 0 ? (amount / grandTotal) * 100 : 0;
            const barColor = CATEGORY_COLORS[category] || '#6C63FF';

            return (
              <div key={category} className="glass-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: '0.9rem' }}>
                  <span style={{ fontWeight: 600, color: 'var(--on-background)' }}>{category}</span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>{pct.toFixed(1)}%</span>
                    <span style={{ fontWeight: 700, color: 'var(--on-background)' }}>{formatLKR(amount)}</span>
                  </div>
                </div>

                <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'var(--surface-variant)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: barColor, borderRadius: 4 }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
