import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Expense, Group, GroupInvitation, GroupMember, GroupSettlement, SplitMethod, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';
import { simplifyDebts } from '../lib/debtSimplifier';
import { netByUser } from '../lib/balances';
import { categoryMeta } from '../lib/categories';
import { friendlyDate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, EmptyState, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { AddExpenseModal } from './AddExpenseModal';
import { SettleUpSheet, SettleTarget } from '../components/SettleUpSheet';
import {
  ArrowLeft, ArrowRight, AtSign, Archive, ArchiveRestore, Check, Copy, Eraser, Mail, Pencil, Plus,
  RefreshCw, Settings2, Share2, Trash2, UserCheck, X,
} from 'lucide-react';

interface GroupDetailPageProps {
  groupId: string;
  user: User;
  onBack: () => void;
}

type Tab = 'expenses' | 'balances' | 'activity';

interface JoinRequest {
  id: string;
  user_id: string;
  requested_at: string;
  users?: User;
}

export const GroupDetailPage: React.FC<GroupDetailPageProps> = ({ groupId, user, onBack }) => {
  const toast = useToast();
  const confirm = useConfirm();

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<GroupSettlement[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [invitations, setInvitations] = useState<GroupInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('expenses');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [settleTarget, setSettleTarget] = useState<SettleTarget | null>(null);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [busyRequest, setBusyRequest] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [invitingByEmail, setInvitingByEmail] = useState(false);
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [cancellingInvite, setCancellingInvite] = useState<string | null>(null);

  const [showManage, setShowManage] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [groupRes, memberRes, expenseRes, ledgerRes, settlementRes] = await Promise.all([
        supabase.from('groups').select('*').eq('id', groupId).single(),
        supabase.from('group_members').select('*, users(*)').eq('group_id', groupId),
        supabase
          .from('expenses')
          .select('*, paid_by_user:users!expenses_paid_by_fkey(*)')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false }),
        supabase.from('ledger_entries').select('user_id, amount').eq('group_id', groupId),
        supabase
          .from('group_settlements')
          .select('*, payer:users!group_settlements_from_user_fkey(*), payee:users!group_settlements_to_user_fkey(*)')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false }),
      ]);

      if (groupRes.error) throw groupRes.error;
      setGroup(groupRes.data as Group);

      if (memberRes.error) throw memberRes.error;
      setMembers((memberRes.data ?? []).map((m: any) => ({ ...m, user: m.users })));

      if (expenseRes.error) throw expenseRes.error;
      setExpenses((expenseRes.data ?? []) as Expense[]);

      if (ledgerRes.error) throw ledgerRes.error;
      setBalances(netByUser(ledgerRes.data ?? []));

      if (!settlementRes.error) setSettlements((settlementRes.data ?? []) as GroupSettlement[]);

      // Only admins can read these; a failure here is not worth surfacing.
      const { data: requestData } = await supabase
        .from('group_join_requests')
        .select('id, user_id, requested_at, users(*)')
        .eq('group_id', groupId)
        .eq('status', 'PENDING');
      setRequests((requestData ?? []) as unknown as JoinRequest[]);

      // Same visibility rule as join requests — admin-only, quiet on failure.
      const { data: invitationData } = await supabase
        .from('group_invitations')
        .select('*, inviter:users!group_invitations_invited_by_fkey(*)')
        .eq('group_id', groupId)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });
      setInvitations((invitationData ?? []) as unknown as GroupInvitation[]);
    } catch (error) {
      setLoadError(friendlyDbError(error, 'Could not load this group.'));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const userMap = useMemo(() => {
    const map: Record<string, User> = {};
    for (const m of members) if (m.user) map[m.user_id] = m.user;
    return map;
  }, [members]);

  // Saved split arrangement for this group, used to pre-fill each new bill.
  const splitDefaults = useMemo(
    () => ({
      method: (group?.default_split_method ?? 'EQUAL') as SplitMethod,
      shares: Object.fromEntries(members.map((m) => [m.user_id, m.default_split_share ?? 1])),
      included: Object.fromEntries(members.map((m) => [m.user_id, m.include_by_default ?? true])),
    }),
    [group?.default_split_method, members]
  );

  const isAdmin = members.some((m) => m.user_id === user.id && m.role === 'ADMIN');
  const myBalance = balances[user.id] ?? 0;
  const simplified = useMemo(() => simplifyDebts(balances, userMap), [balances, userMap]);
  const myDebts = simplified.filter((d) => d.from.id === user.id);
  const activeExpenses = expenses.filter((e) => !e.is_deleted);

  const handleApprove = async (request: JoinRequest) => {
    setBusyRequest(request.id);
    try {
      const { error: memberError } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: request.user_id, role: 'MEMBER' });
      if (memberError) throw memberError;

      const { error: updateError } = await supabase
        .from('group_join_requests')
        .update({ status: 'APPROVED', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', request.id);
      if (updateError) throw updateError;

      toast.success(`${request.users?.display_name ?? 'Member'} joined the group.`);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not approve the request.'));
    } finally {
      setBusyRequest(null);
    }
  };

  const handleReject = async (request: JoinRequest) => {
    setBusyRequest(request.id);
    try {
      const { error } = await supabase
        .from('group_join_requests')
        .update({ status: 'REJECTED', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', request.id);
      if (error) throw error;
      toast.info('Request declined.');
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not decline the request.'));
    } finally {
      setBusyRequest(null);
    }
  };

  const handleDeleteExpense = async (expense: Expense) => {
    const ok = await confirm({
      title: 'Delete this expense?',
      message: `"${expense.title}" will be marked deleted and a reversal entry keeps everyone's balance correct. The ledger history is preserved.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      const { error } = await supabase.rpc('delete_expense', {
        p_expense_id: expense.id,
        p_reason: 'Deleted from the app',
      });
      if (error) throw error;
      toast.success('Expense deleted and balances reversed.');
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not delete the expense.'));
    }
  };

  /**
   * Everyone at exactly zero. This is the gate for both cleanup paths — the
   * server enforces it too, this copy just keeps the buttons honest and lets the
   * sheet explain *why* it is disabled instead of failing on tap.
   */
  const allSettled = useMemo(
    () => Object.values(balances).every((amount) => Math.abs(amount) < 0.01),
    [balances]
  );

  const handleToggleArchive = async () => {
    const archiving = !group?.archived_at;

    if (archiving) {
      const ok = await confirm({
        title: 'Archive this group?',
        message:
          'It moves out of your main list but nothing is deleted — every expense and balance stays, and you can restore it any time.',
        confirmLabel: 'Archive',
      });
      if (!ok) return;
    }

    setCleaning(true);
    try {
      const { error } = await supabase.rpc('archive_group', {
        p_group_id: groupId,
        p_archive: archiving,
      });
      if (error) throw error;
      toast.success(archiving ? 'Group archived.' : 'Group restored.');
      setShowManage(false);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not update the group.'));
    } finally {
      setCleaning(false);
    }
  };

  const handlePurge = async () => {
    const ok = await confirm({
      title: 'Permanently delete this history?',
      message:
        'Every expense, split, receipt link, settlement and ledger entry in this group is erased for good. This cannot be undone and the record of who paid what will be gone. The group and its members stay, ready to use from scratch.',
      confirmLabel: 'Delete for good',
      danger: true,
    });
    if (!ok) return;

    setCleaning(true);
    try {
      const { data, error } = await supabase.rpc('purge_group_history', { p_group_id: groupId });
      if (error) throw error;

      const result = (data as { out_expenses: number; out_settlements: number }[])?.[0];
      const count = result?.out_expenses ?? 0;
      toast.success(
        count > 0
          ? `Cleared ${count} expense${count === 1 ? '' : 's'} and their history.`
          : 'History cleared.'
      );
      setShowManage(false);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not clear the history.'));
    } finally {
      setCleaning(false);
    }
  };

  const handleRegenerateCode = async () => {
    setRegenerating(true);
    try {
      const { data, error } = await supabase.rpc('regenerate_invite_code', {
        p_group_id: groupId,
        p_days: 7,
      });
      if (error) throw error;
      setGroup((current) => (current ? { ...current, invite_code: data as string } : current));
      toast.success('New invite code generated.');
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not regenerate the code.'));
    } finally {
      setRegenerating(false);
    }
  };

  const copyInvite = async () => {
    if (!group) return;
    try {
      await navigator.clipboard.writeText(group.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the code and copy it manually.');
    }
  };

  const codeExpired = group ? new Date(group.invite_code_expires_at).getTime() < Date.now() : false;

  const handleInviteByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteEmailError(null);
    setInvitingByEmail(true);

    try {
      const { data, error } = await supabase.rpc('invite_to_group_by_email', {
        p_group_id: groupId,
        p_email: inviteEmail.trim(),
      });
      if (error) throw error;

      const result = (data as { out_status: string }[])?.[0];
      switch (result?.out_status) {
        case 'INVITED':
          toast.success(`Invited ${inviteEmail.trim()} — they'll see it next time they sign in.`);
          setInviteEmail('');
          await load();
          break;
        case 'INVITED_PENDING_SIGNUP':
          toast.success(`Invited ${inviteEmail.trim()}. No account yet — it'll wait for them to sign up.`);
          setInviteEmail('');
          await load();
          break;
        case 'ALREADY_MEMBER':
          setInviteEmailError('That person is already in this group.');
          break;
        case 'ALREADY_INVITED':
          setInviteEmailError('Already invited — waiting on a response.');
          break;
        case 'INVALID_EMAIL':
          setInviteEmailError('Enter a valid email address.');
          break;
        default:
          setInviteEmailError('Could not send the invite.');
      }
    } catch (error) {
      setInviteEmailError(friendlyDbError(error, 'Could not send the invite.'));
    } finally {
      setInvitingByEmail(false);
    }
  };

  const handleCancelInvitation = async (invitation: GroupInvitation) => {
    setCancellingInvite(invitation.id);
    try {
      const { error } = await supabase.rpc('cancel_group_invitation', {
        p_invitation_id: invitation.id,
      });
      if (error) throw error;
      toast.info(`Invite to ${invitation.invited_email} withdrawn.`);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not withdraw the invite.'));
    } finally {
      setCancellingInvite(null);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <Skeletonish onBack={onBack} />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
        <button type="button" className="btn-icon" onClick={onBack} aria-label="Back to groups">
          <ArrowLeft size={18} />
        </button>
        <div style={{ textAlign: 'center', minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 800, fontSize: '1.05rem' }}>
            {group?.icon_emoji} {group?.name ?? 'Group'}
          </div>
          <div className="hint">
            {members.length} members{group?.archived_at ? ' · archived' : ''}
          </div>
        </div>
        <span className="row" style={{ gap: 2, flexShrink: 0 }}>
          <button type="button" className="btn-icon" onClick={() => setShowInvite(true)} aria-label="Invite members">
            <Share2 size={18} color="var(--primary-light)" />
          </button>
          {isAdmin && (
            <button
              type="button"
              className="btn-icon"
              onClick={() => setShowManage(true)}
              aria-label="Manage group"
            >
              <Settings2 size={18} />
            </button>
          )}
        </span>
      </header>

      {group?.archived_at && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="info">
            This group is archived. Nothing has been deleted — restore it from Manage to bring it back to
            your list.
          </Alert>
        </div>
      )}

      {loadError && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{loadError}</Alert>
        </div>
      )}

      <section
        className={`card-hero ${Math.abs(myBalance) < 0.01 ? 'is-neutral' : myBalance > 0 ? 'is-positive' : 'is-negative'}`}
        style={{ marginBottom: 'var(--sp-5)' }}
      >
        <span className="label">Your balance here</span>
        <div
          className={`amount-xl tabular ${Math.abs(myBalance) < 0.01 ? '' : myBalance > 0 ? 'text-positive' : 'text-negative'}`}
          style={{ margin: '6px 0 4px' }}
        >
          {formatLKRSigned(myBalance)}
        </div>
        <span className="hint">
          {Math.abs(myBalance) < 0.01
            ? 'You are all square in this group'
            : myBalance > 0
              ? 'You are owed by the group'
              : 'You owe the group'}
        </span>

        {myDebts.length > 0 && (
          <div className="stack-sm card-divider" style={{ marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}>
            {myDebts.map((debt) => (
              <div key={debt.to.id} className="row-between">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <Avatar name={debt.to.display_name} url={debt.to.avatar_url} size={26} />
                  <span className="truncate" style={{ fontSize: '0.85rem' }}>
                    Pay {debt.to.display_name}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    setSettleTarget({
                      groupId,
                      groupName: group?.name,
                      payee: debt.to,
                      suggestedAmount: debt.amount,
                    })
                  }
                >
                  Settle {formatLKR(debt.amount)}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {isAdmin && requests.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--warning)', marginBottom: 'var(--sp-5)' }}>
          <h2 className="row text-warning" style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 'var(--sp-3)' }}>
            <UserCheck size={16} /> {requests.length} pending join request{requests.length === 1 ? '' : 's'}
          </h2>
          <div className="stack-sm">
            {requests.map((request) => (
              <div key={request.id} className="row-between">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <Avatar name={request.users?.display_name} url={request.users?.avatar_url} size={30} />
                  <span className="truncate" style={{ fontSize: '0.87rem' }}>
                    {request.users?.display_name ?? request.users?.email ?? 'Someone'}
                  </span>
                </span>
                <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleReject(request)}
                    disabled={busyRequest === request.id}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handleApprove(request)}
                    disabled={busyRequest === request.id}
                  >
                    {busyRequest === request.id ? <Spinner /> : 'Approve'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="chip-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 'var(--sp-4)' }}>
        {(['expenses', 'balances', 'activity'] as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`chip ${tab === id ? 'is-selected' : ''}`}
            style={{ display: 'flex', justifyContent: 'center', textTransform: 'capitalize' }}
            onClick={() => setTab(id)}
          >
            {id}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <>
          <div className="row-between" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              {activeExpenses.length} expense{activeExpenses.length === 1 ? '' : 's'}
            </h2>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
              <Plus size={15} /> Add
            </button>
          </div>

          {expenses.length === 0 ? (
            <EmptyState
              icon="🧾"
              title="No expenses yet"
              text="Add the first bill and MoneyMate will work out who owes what."
              action={
                <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
                  Add an expense
                </button>
              }
            />
          ) : (
            <div className="stack-sm">
              {expenses.map((expense) => {
                const meta = categoryMeta(expense.category);
                const canManage = expense.created_by === user.id || isAdmin;
                return (
                  <div
                    key={expense.id}
                    className="card row"
                    style={{ opacity: expense.is_deleted ? 0.5 : 1, gap: 'var(--sp-3)' }}
                  >
                    <span className="icon-tile" style={{ width: 40, height: 40, fontSize: 19 }}>
                      {meta.emoji}
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="truncate" style={{ fontWeight: 600, fontSize: '0.92rem' }}>
                          {expense.title}
                        </span>
                        {expense.is_deleted && <span className="badge badge-negative">Deleted</span>}
                        {expense.split_method === 'ITEMIZED' && !expense.is_deleted && (
                          <span className="badge badge-primary">Itemized</span>
                        )}
                      </span>
                      <span className="hint">
                        {expense.paid_by_user?.display_name ?? 'Someone'} paid ·{' '}
                        {friendlyDate(expense.created_at.slice(0, 10))}
                        {expense.updated_at && expense.updated_at !== expense.created_at ? ' · edited' : ''}
                      </span>
                    </span>
                    <span className="row" style={{ gap: 'var(--sp-2)', flexShrink: 0 }}>
                      <span className="amount-md tabular">{formatLKR(expense.amount)}</span>
                      {canManage && !expense.is_deleted && (
                        <>
                          <button
                            type="button"
                            className="btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => setEditing(expense)}
                            aria-label={`Edit ${expense.title}`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => handleDeleteExpense(expense)}
                            aria-label={`Delete ${expense.title}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'balances' && (
        <>
          <h2 className="section-title" style={{ marginTop: 0 }}>Who owes whom</h2>
          {simplified.length === 0 ? (
            <EmptyState icon="✅" title="Everyone is square" text="No outstanding balances in this group." />
          ) : (
            <div className="stack-sm">
              {simplified.map((debt, index) => (
                <div key={`${debt.from.id}-${debt.to.id}-${index}`} className="card row">
                  <Avatar name={debt.from.display_name} url={debt.from.avatar_url} size={30} />
                  <span className="truncate" style={{ fontSize: '0.85rem', maxWidth: 84 }}>
                    {debt.from.id === user.id ? 'You' : debt.from.display_name}
                  </span>
                  <ArrowRight size={14} color="var(--on-surface-faint)" style={{ flexShrink: 0 }} />
                  <Avatar name={debt.to.display_name} url={debt.to.avatar_url} size={30} />
                  <span className="truncate grow" style={{ fontSize: '0.85rem' }}>
                    {debt.to.id === user.id ? 'You' : debt.to.display_name}
                  </span>
                  <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                    {formatLKR(debt.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Members</h2>
          <div className="card card-flush">
            {members.map((member) => {
              const balance = balances[member.user_id] ?? 0;
              return (
                <div key={member.id} className="list-row">
                  <Avatar name={member.user?.display_name} url={member.user?.avatar_url} size={34} />
                  <span className="grow truncate" style={{ fontSize: '0.9rem' }}>
                    {member.user_id === user.id ? 'You' : member.user?.display_name ?? 'Member'}
                  </span>
                  {member.role === 'ADMIN' && <span className="badge badge-warning">Admin</span>}
                  <span
                    className={`tabular ${Math.abs(balance) < 0.01 ? 'text-neutral' : balance > 0 ? 'text-positive' : 'text-negative'}`}
                    style={{ fontSize: '0.85rem', fontWeight: 700 }}
                  >
                    {formatLKRSigned(balance)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === 'activity' && (
        <>
          <h2 className="section-title" style={{ marginTop: 0 }}>Settlements</h2>
          {settlements.length === 0 ? (
            <EmptyState icon="🤝" title="No settlements yet" text="Payments between members show up here." />
          ) : (
            <div className="stack-sm">
              {settlements.map((settlement) => (
                <div key={settlement.id} className="card row">
                  <span className="icon-tile" style={{ width: 36, height: 36, fontSize: 16 }}>
                    💸
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600 }}>
                      {settlement.from_user === user.id ? 'You' : settlement.payer?.display_name ?? 'Someone'} paid{' '}
                      {settlement.to_user === user.id ? 'you' : settlement.payee?.display_name ?? 'someone'}
                    </span>
                    <span className="hint">
                      {friendlyDate(settlement.created_at.slice(0, 10))} · {settlement.payment_method.toLowerCase()}
                      {settlement.note ? ` · ${settlement.note}` : ''}
                    </span>
                  </span>
                  <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                    {formatLKR(settlement.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {showAdd && (
        <AddExpenseModal
          groupId={groupId}
          user={user}
          members={members}
          defaults={splitDefaults}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}

      {editing && (
        <AddExpenseModal
          groupId={groupId}
          user={user}
          members={members}
          expense={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {settleTarget && (
        <SettleUpSheet
          target={settleTarget}
          onClose={() => setSettleTarget(null)}
          onSettled={() => {
            setSettleTarget(null);
            void load();
          }}
        />
      )}

      {showManage && group && (
        <Sheet title="Manage group" onClose={() => setShowManage(false)}>
          <div className="stack">
            {!allSettled && (
              <Alert variant="warning">
                Someone in this group is still up or down. Settle every balance before archiving or clearing
                the history — otherwise those debts would be silently written off.
              </Alert>
            )}

            {/* ---- Archive: reversible ---- */}
            <div className="card">
              <span className="row" style={{ gap: 8, marginBottom: 6 }}>
                {group.archived_at ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>
                  {group.archived_at ? 'Restore group' : 'Archive group'}
                </span>
              </span>
              <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                {group.archived_at
                  ? 'Bring this group back into your main list. Everything is exactly as you left it.'
                  : 'Tidies a finished trip out of your list. Nothing is deleted and you can restore it any time — the safe option.'}
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={handleToggleArchive}
                disabled={cleaning || (!group.archived_at && !allSettled)}
              >
                {cleaning && <Spinner />}
                {group.archived_at ? 'Restore group' : 'Archive group'}
              </button>
            </div>

            {/* ---- Purge: irreversible ---- */}
            <div className="card" style={{ borderColor: 'var(--negative)' }}>
              <span className="row" style={{ gap: 8, marginBottom: 6 }}>
                <Eraser size={16} color="var(--negative)" />
                <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>Clear history permanently</span>
              </span>
              <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                Frees up storage by erasing every expense, split, settlement and ledger entry in this group.
                The group and its members stay, ready to reuse. <strong>This cannot be undone</strong> — the
                record of who paid what will be gone for good, so archive instead if you might ever need it.
              </p>
              <button
                type="button"
                className="btn btn-danger btn-block"
                onClick={handlePurge}
                disabled={cleaning || !allSettled || activeExpenses.length === 0}
              >
                {cleaning && <Spinner />}
                {activeExpenses.length === 0 ? 'Nothing to clear' : 'Clear history permanently'}
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {showInvite && group && (
        <Sheet title="Invite to group" onClose={() => setShowInvite(false)}>
          <div className="stack" style={{ textAlign: 'center' }}>
            <p className="text-muted" style={{ fontSize: '0.87rem' }}>
              Share this code so friends can request to join "{group.name}". You approve each request.
            </p>

            <div className="card-hero is-neutral">
              <div
                className="tabular"
                style={{ fontSize: '2.1rem', fontWeight: 800, letterSpacing: 8, color: 'var(--primary-light)' }}
              >
                {group.invite_code}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {codeExpired
                  ? 'This code has expired'
                  : `Valid until ${new Date(group.invite_code_expires_at).toLocaleDateString()}`}
              </div>
            </div>

            {codeExpired && (
              <Alert variant="warning">
                Expired codes are rejected on join. Generate a new one to keep inviting.
              </Alert>
            )}

            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={copyInvite}>
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? 'Copied' : 'Copy code'}
            </button>

            {isAdmin && (
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={handleRegenerateCode}
                disabled={regenerating}
              >
                {regenerating ? <Spinner /> : <RefreshCw size={15} />}
                {regenerating ? 'Generating…' : 'Generate a new code'}
              </button>
            )}

            {isAdmin && (
              <>
                <div className="row" style={{ margin: 'var(--sp-2) 0' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                  <span className="hint">or invite directly</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                </div>

                <form onSubmit={handleInviteByEmail} className="stack" style={{ textAlign: 'left' }}>
                  <div className="input-prefixed">
                    <span className="input-prefix" style={{ left: 14 }}>
                      <AtSign size={15} />
                    </span>
                    <input
                      type="email"
                      className="input"
                      style={{ paddingLeft: 40 }}
                      placeholder="friend@email.com"
                      value={inviteEmail}
                      onChange={(e) => {
                        setInviteEmail(e.target.value);
                        setInviteEmailError(null);
                      }}
                      required
                    />
                  </div>
                  {inviteEmailError && <Alert variant="error">{inviteEmailError}</Alert>}
                  <button
                    type="submit"
                    className="btn btn-secondary btn-block"
                    disabled={invitingByEmail || !inviteEmail.trim()}
                  >
                    {invitingByEmail ? <Spinner /> : <Mail size={15} />}
                    {invitingByEmail ? 'Sending…' : 'Send invite'}
                  </button>
                  <span className="hint" style={{ textAlign: 'center', display: 'block' }}>
                    They need to accept before they can see the group. If they don't have an account yet,
                    the invite waits until they sign up with that email.
                  </span>
                </form>

                {invitations.length > 0 && (
                  <div className="stack-sm" style={{ textAlign: 'left', marginTop: 'var(--sp-2)' }}>
                    <span className="label">Pending invites</span>
                    {invitations.map((inv) => (
                      <div key={inv.id} className="card row-between" style={{ padding: 'var(--sp-3)' }}>
                        <span className="truncate" style={{ fontSize: '0.85rem', minWidth: 0 }}>
                          {inv.invited_email}
                          {!inv.invited_user_id && (
                            <span className="hint" style={{ display: 'block' }}>
                              waiting on signup
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="btn-icon"
                          style={{ width: 30, height: 30, flexShrink: 0 }}
                          onClick={() => handleCancelInvitation(inv)}
                          disabled={cancellingInvite === inv.id}
                          aria-label={`Withdraw invite to ${inv.invited_email}`}
                        >
                          {cancellingInvite === inv.id ? <Spinner size={13} /> : <X size={14} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
};

/** Header-shaped placeholder so the page does not jump when data lands. */
const Skeletonish: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <>
    <header className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
      <button type="button" className="btn-icon" onClick={onBack} aria-label="Back to groups">
        <ArrowLeft size={18} />
      </button>
      <div className="skeleton" style={{ height: 20, width: 140, borderRadius: 8 }} />
      <div style={{ width: 40 }} />
    </header>
    <div className="skeleton" style={{ height: 150, borderRadius: 24, marginBottom: 20 }} />
    <SkeletonRows count={4} />
  </>
);
