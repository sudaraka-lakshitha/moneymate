import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ExpenseCategory, User } from '../types';
import { formatLKR, parseAmount, roundMoney } from '../lib/currency';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { friendlyDate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, SkeletonRows } from '../components/ui';
import { Filter, Search, X } from 'lucide-react';

interface SearchPageProps {
  user: User;
  onNavigate: (route: string) => void;
}

interface Hit {
  id: string;
  kind: 'group' | 'personal';
  title: string;
  amount: number;
  category: ExpenseCategory;
  date: string;
  groupId?: string;
  groupName?: string;
  payerName?: string;
  note?: string;
}

type SortKey = 'recent' | 'amount';

export const SearchPage: React.FC<SearchPageProps> = ({ user, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showFilters, setShowFilters] = useState(false);
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<'all' | 'group' | 'personal'>('all');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');

  /**
   * Everything is loaded once and filtered in memory. A personal expense app
   * has hundreds of rows, not millions, so this keeps typing instant and works
   * from the offline cache without a round trip per keystroke.
   */
  const load = useCallback(async () => {
    setError(null);
    try {
      const [groupRes, personalRes] = await Promise.all([
        supabase
          .from('expenses')
          .select('id, title, amount, category, created_at, notes, group_id, groups(name, is_direct), paid_by_user:users!expenses_paid_by_fkey(display_name)')
          .eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('daily_expenses')
          .select('id, title, amount, category, date, note')
          .eq('user_id', user.id)
          .eq('is_deleted', false)
          .order('date', { ascending: false })
          .limit(500),
      ]);

      if (groupRes.error) throw groupRes.error;
      if (personalRes.error) throw personalRes.error;

      const groupHits: Hit[] = (groupRes.data ?? []).map((row: any) => ({
        id: row.id,
        kind: 'group',
        title: row.title,
        amount: Number(row.amount),
        category: (row.category || 'OTHER') as ExpenseCategory,
        date: String(row.created_at).slice(0, 10),
        groupId: row.group_id,
        // Direct pair groups are an implementation detail of friend loans;
        // showing "Between you and X" as a group label just confuses the result.
        groupName: row.groups?.is_direct ? undefined : row.groups?.name,
        payerName: row.paid_by_user?.display_name,
        note: row.notes,
      }));

      const personalHits: Hit[] = (personalRes.data ?? []).map((row: any) => ({
        id: row.id,
        kind: 'personal',
        title: row.title,
        amount: Number(row.amount),
        category: (row.category || 'OTHER') as ExpenseCategory,
        date: row.date,
        note: row.note,
      }));

      setHits([...groupHits, ...personalHits]);
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your expenses.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const min = minAmount ? parseAmount(minAmount) : null;
    const max = maxAmount ? parseAmount(maxAmount) : null;

    const filtered = hits.filter((hit) => {
      if (source !== 'all' && hit.kind !== source) return false;
      if (categories.size > 0 && !categories.has(hit.category)) return false;
      if (min !== null && hit.amount < min) return false;
      if (max !== null && hit.amount > max) return false;
      if (fromDate && hit.date < fromDate) return false;
      if (toDate && hit.date > toDate) return false;

      if (needle) {
        const haystack = [hit.title, hit.note, hit.groupName, hit.payerName, categoryMeta(hit.category).name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    return filtered.sort((a, b) =>
      sort === 'amount' ? b.amount - a.amount : b.date.localeCompare(a.date)
    );
  }, [hits, query, source, categories, minAmount, maxAmount, fromDate, toDate, sort]);

  const total = useMemo(
    () => roundMoney(results.reduce((sum, hit) => sum + hit.amount, 0)),
    [results]
  );

  const activeFilterCount =
    (categories.size > 0 ? 1 : 0) +
    (source !== 'all' ? 1 : 0) +
    (minAmount || maxAmount ? 1 : 0) +
    (fromDate || toDate ? 1 : 0);

  const clearFilters = () => {
    setCategories(new Set());
    setSource('all');
    setMinAmount('');
    setMaxAmount('');
    setFromDate('');
    setToDate('');
  };

  const toggleCategory = (id: string) =>
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Search</h1>
          <p className="page-subtitle">Every bill and tracker entry</p>
        </div>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="card row" style={{ padding: '4px var(--sp-4)', marginBottom: 'var(--sp-3)' }}>
        <Search size={17} color="var(--on-surface-variant)" />
        <input
          type="search"
          className="grow"
          placeholder="Search by name, note, group or person…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          style={{ background: 'none', border: 'none', outline: 'none', padding: '10px 0', fontSize: '0.92rem' }}
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear search" style={{ display: 'flex' }}>
            <X size={16} color="var(--on-surface-faint)" />
          </button>
        )}
      </div>

      <div className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
        <button
          type="button"
          className={`btn btn-sm ${activeFilterCount > 0 ? 'btn-outline' : 'btn-ghost'}`}
          onClick={() => setShowFilters((v) => !v)}
        >
          <Filter size={14} /> Filters
          {activeFilterCount > 0 && <span className="badge badge-primary">{activeFilterCount}</span>}
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setSort(sort === 'recent' ? 'amount' : 'recent')}
        >
          {sort === 'recent' ? 'Newest first' : 'Largest first'}
        </button>
      </div>

      {showFilters && (
        <div className="card stack" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="field">
            <span className="label label-block">Source</span>
            <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {(['all', 'group', 'personal'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`chip ${source === option ? 'is-selected' : ''}`}
                  style={{ display: 'flex', justifyContent: 'center', textTransform: 'capitalize' }}
                  onClick={() => setSource(option)}
                >
                  {option === 'all' ? 'Both' : option}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="label label-block">Categories</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`chip ${categories.has(cat.id) ? 'is-selected' : ''}`}
                  style={{ padding: '5px 10px', fontSize: '0.76rem' }}
                  onClick={() => toggleCategory(cat.id)}
                >
                  {cat.emoji} {cat.name}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="label label-block">Amount range</span>
            <div className="row">
              <input
                type="text"
                inputMode="decimal"
                className="input input-sm tabular grow"
                placeholder="Min"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                className="input input-sm tabular grow"
                placeholder="Max"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <span className="label label-block">Date range</span>
            <div className="row">
              <input
                type="date"
                className="input input-sm grow"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
              <input
                type="date"
                className="input input-sm grow"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>

          {activeFilterCount > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
              Clear all filters
            </button>
          )}
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="row-between" style={{ marginBottom: 'var(--sp-3)' }}>
          <span className="label">
            {results.length} result{results.length === 1 ? '' : 's'}
          </span>
          <span className="amount-md tabular">{formatLKR(total)}</span>
        </div>
      )}

      {loading ? (
        <SkeletonRows count={5} height={62} />
      ) : results.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={query || activeFilterCount > 0 ? 'Nothing matched' : 'Search your spending'}
          text={
            query || activeFilterCount > 0
              ? 'Try a different word, or loosen the filters.'
              : 'Find any bill or tracker entry by name, note, group, person, category, amount or date.'
          }
        />
      ) : (
        <div className="card card-flush">
          {results.map((hit) => {
            const meta = categoryMeta(hit.category);
            return (
              <button
                key={`${hit.kind}-${hit.id}`}
                type="button"
                className="list-row list-row-interactive"
                onClick={() => hit.groupId && onNavigate(`group-detail/${hit.groupId}`)}
                disabled={hit.kind === 'personal'}
              >
                <span className="icon-tile" style={{ width: 36, height: 36, fontSize: 17 }}>
                  {meta.emoji}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: 'block', fontSize: '0.89rem', fontWeight: 600 }}>
                    {hit.title}
                  </span>
                  <span className="hint truncate" style={{ display: 'block' }}>
                    {hit.kind === 'group'
                      ? `${hit.groupName ?? 'Group'} · ${hit.payerName ?? 'someone'} paid`
                      : 'Personal'}
                    {' · '}
                    {friendlyDate(hit.date)}
                  </span>
                </span>
                <span className="amount-md tabular">{formatLKR(hit.amount)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
