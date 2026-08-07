import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, GroupMember, Expense, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';
import { simplifyDebts } from '../lib/debtSimplifier';
import { Plus, Share2, ArrowLeft, Check, UserCheck, Trash2, ArrowRight } from 'lucide-react';
import { AddExpenseModal } from './AddExpenseModal';

interface GroupDetailPageProps {
  groupId: string;
  user: User;
  onBack: () => void;
}

export const GroupDetailPage: React.FC<GroupDetailPageProps> = ({ groupId, user, onBack }) => {
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [myBalance, setMyBalance] = useState(0);

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    loadGroupDetails();
  }, [groupId, user.id]);

  const loadGroupDetails = async () => {
    try {
      const { data: gData } = await supabase.from('groups').select('*').eq('id', groupId).single();
      if (gData) setGroup(gData);

      const { data: mData } = await supabase
        .from('group_members')
        .select('*, users(*)')
        .eq('group_id', groupId);

      if (mData) {
        const mList = mData.map((m: any) => ({ ...m, user: m.users }));
        setMembers(mList);
        const adminCheck = mList.some((m: any) => m.user_id === user.id && m.role === 'ADMIN');
        setIsAdmin(adminCheck);
      }

      const { data: eData } = await supabase
        .from('expenses')
        .select('*, paid_by_user:users!expenses_paid_by_fkey(*)')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false });

      if (eData) setExpenses(eData);

      const { data: lData } = await supabase
        .from('ledger_entries')
        .select('user_id, amount')
        .eq('group_id', groupId);

      if (lData) {
        const bMap: Record<string, number> = {};
        lData.forEach((row: any) => {
          bMap[row.user_id] = (bMap[row.user_id] || 0) + Number(row.amount);
        });
        setBalances(bMap);
        setMyBalance(bMap[user.id] || 0);
      }

      const { data: reqData } = await supabase
        .from('group_join_requests')
        .select('*, users(*)')
        .eq('group_id', groupId)
        .eq('status', 'PENDING');

      if (reqData) setPendingRequests(reqData);
    } catch (err) {
      console.error('Group detail error:', err);
    }
  };

  const userMap: Record<string, User> = {};
  members.forEach((m) => {
    if (m.user) userMap[m.user_id] = m.user;
  });

  const simplified = simplifyDebts(balances, userMap);

  const handleApproveRequest = async (requestId: string, requesterUserId: string) => {
    await supabase.from('group_join_requests').update({ status: 'APPROVED', reviewed_by: user.id }).eq('id', requestId);
    await supabase.from('group_members').insert({ group_id: groupId, user_id: requesterUserId, role: 'MEMBER' });
    loadGroupDetails();
  };

  const handleRejectRequest = async (requestId: string) => {
    await supabase.from('group_join_requests').update({ status: 'REJECTED', reviewed_by: user.id }).eq('id', requestId);
    loadGroupDetails();
  };

  const handleDeleteExpense = async (expenseId: string) => {
    if (!confirm('Delete expense? A reversal entry will be created to keep balance accurate.')) return;

    await supabase.from('expenses').update({ is_deleted: true, deleted_by: user.id }).eq('id', expenseId);

    const { data: existing } = await supabase.from('ledger_entries').select('*').eq('reference_id', expenseId);
    if (existing) {
      const reversals = existing.map((e: any) => ({
        group_id: groupId,
        user_id: e.user_id,
        entry_type: 'DELETE_REVERSAL',
        amount: -Number(e.amount),
        reference_id: expenseId,
        description: 'Reversal of deleted expense'
      }));
      await supabase.from('ledger_entries').insert(reversals);
    }

    loadGroupDetails();
  };

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={onBack} className="btn-icon">
          <ArrowLeft size={20} />
        </button>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--on-background)' }}>{group?.name || 'Group'}</h2>
        <button onClick={() => setShowInviteModal(true)} className="btn-icon">
          <Share2 size={20} color="var(--primary-light)" />
        </button>
      </div>

      <div className={myBalance >= 0 ? 'glass-card-primary' : 'glass-card-negative'} style={{ padding: 20, marginBottom: 20 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>Your Balance in Group</span>
        <h2 style={{ fontSize: '2rem', fontWeight: 800, color: myBalance >= 0 ? 'var(--positive)' : 'var(--negative)', margin: '6px 0 4px' }}>
          {formatLKRSigned(myBalance)}
        </h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
          {myBalance >= 0 ? 'You are owed in this group' : 'You owe in this group'}
        </span>
      </div>

      {isAdmin && pendingRequests.length > 0 && (
        <div className="glass-card" style={{ padding: 16, marginBottom: 20, border: '1px solid var(--warning)' }}>
          <h4 style={{ color: 'var(--warning)', fontSize: '0.9rem', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <UserCheck size={18} /> Pending Join Requests ({pendingRequests.length})
          </h4>
          {pendingRequests.map((req) => (
            <div key={req.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--divider)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--on-background)' }}>{req.users?.display_name || req.users?.email}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => handleApproveRequest(req.id, req.user_id)} className="badge badge-positive" style={{ border: 'none', cursor: 'pointer' }}>Approve</button>
                <button onClick={() => handleRejectRequest(req.id)} className="badge badge-negative" style={{ border: 'none', cursor: 'pointer' }}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {simplified.length > 0 && (
        <div className="glass-card" style={{ padding: 16, marginBottom: 20 }}>
          <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 12 }}>Simplified Debts</h4>
          {simplified.map((debt, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', padding: '6px 0' }}>
              <span style={{ color: 'var(--negative)' }}>{debt.from.display_name}</span>
              <ArrowRight size={14} color="var(--on-surface-variant)" />
              <span style={{ color: 'var(--positive)' }}>{debt.to.display_name}</span>
              <span style={{ fontWeight: 700, color: 'var(--on-background)' }}>{formatLKR(debt.amount)}</span>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 12 }}>Members ({members.length})</h3>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 24 }}>
        {members.map((m) => (
          <div key={m.id} className="glass-card" style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--primary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', color: 'var(--primary-light)', fontWeight: 700 }}>
              {m.user?.display_name?.charAt(0).toUpperCase() || '?'}
            </div>
            <span style={{ fontSize: '0.85rem', color: 'var(--on-background)' }}>{m.user?.display_name}</span>
            {m.role === 'ADMIN' && <span className="badge badge-warning">Admin</span>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--on-background)' }}>Expenses</h3>
        <button onClick={() => setShowAddExpense(true)} className="btn-primary" style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
          <Plus size={16} /> Add Expense
        </button>
      </div>

      {expenses.length === 0 ? (
        <div className="glass-card" style={{ padding: 28, textAlign: 'center' }}>
          <span style={{ fontSize: 36 }}>📋</span>
          <p style={{ marginTop: 8, color: 'var(--on-surface-variant)', fontSize: '0.85rem' }}>No expenses recorded yet.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {expenses.map((expense) => (
            <div key={expense.id} className="glass-card" style={{ padding: 14, opacity: expense.is_deleted ? 0.5 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--on-background)' }}>
                    {expense.title} {expense.is_deleted && <span className="badge badge-negative">Deleted</span>}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>
                    Paid by {expense.paid_by_user?.display_name || 'Member'} · {new Date(expense.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontWeight: 700, color: 'var(--on-background)' }}>{formatLKR(expense.amount)}</span>
                  {!expense.is_deleted && (
                    <button onClick={() => handleDeleteExpense(expense.id)} style={{ background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}>
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddExpense && (
        <AddExpenseModal
          groupId={groupId}
          user={user}
          members={members}
          onClose={() => setShowAddExpense(false)}
          onSaved={() => { setShowAddExpense(false); loadGroupDetails(); }}
        />
      )}

      {showInviteModal && group && (
        <div className="modal-overlay" onClick={() => setShowInviteModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 8 }}>Invite Code</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)', marginBottom: 20 }}>
              Share this code with friends so they can join "{group.name}":
            </p>
            <div className="glass-card-primary" style={{ padding: '16px 32px', marginBottom: 20, display: 'inline-block' }}>
              <span style={{ fontSize: '2rem', fontWeight: 800, letterSpacing: 8, color: 'var(--primary-light)' }}>
                {group.invite_code}
              </span>
            </div>
            <div>
              <button
                onClick={() => { navigator.clipboard.writeText(group.invite_code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="btn-primary" style={{ width: '100%', height: 48 }}
              >
                {copied ? <Check size={18} /> : <Share2 size={18} />} {copied ? 'Copied!' : 'Copy Code'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
