import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLiveRefresh } from '../lib/realtime';
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
import { DonutChart } from '../components/Charts';
import {
  ArrowLeft, ArrowRight, AtSign, Archive, ArchiveRestore, Check, ChevronRight, Copy, Eraser, Lock, Mail, Pencil, PieChart, Plus,
  LogOut, RefreshCw, Settings2, Share2, Trash2, UserCheck, X,
} from 'lucide-react';

interface GroupDetailPageProps {
  groupId: string;
  user: User;
  onBack: () => void;
}

type Tab = 'expenses' | 'balances' | 'activity';

/** Distinct hues for the contribution donut, readable in both themes. */
const SLICE_COLORS = ['#6C63FF', '#1baf7a', '#eda100', '#eb6834', '#e87ba4', '#2a78d6', '#9085e9', '#008300'];

/** Same set the create-group sheet offers, so editing cannot pick an odd one. */
const GROUP_EMOJIS = ['💰', '🏠', '🎉', '✈️', '🍔', '🚗', '🎓', '💼', '🏖️', '🎮', '🛍️', '💊'];

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
  const [friends, setFriends] = useState<User[]>([]);
  const [invitingFriend, setInvitingFriend] = useState<string | null>(null);

  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<any[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [busyErase, setBusyErase] = useState<string | null>(null);

  const [showEdit, setShowEdit] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftEmoji, setDraftEmoji] = useState('💰');
  const [savingEdit, setSavingEdit] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);

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

      // Non-admins are filtered to zero rows by RLS, which is an empty array and
      // not an error — so a real error here means the query itself is wrong and
      // must be logged, never swallowed.
      //
      // The !group_join_requests_user_id_fkey hint is required: this table has
      // two foreign keys into users (user_id and reviewed_by), so a bare
      // `users(*)` embed is ambiguous and PostgREST rejects the whole request
      // rather than picking one.
      const { data: requestData, error: requestError } = await supabase
        .from('group_join_requests')
        .select('id, user_id, requested_at, users!group_join_requests_user_id_fkey(*)')
        .eq('group_id', groupId)
        .eq('status', 'PENDING');
      if (requestError) console.error('Join requests failed to load:', requestError);
      setRequests((requestData ?? []) as unknown as JoinRequest[]);

      // Same visibility rule as join requests — RLS filters, errors are bugs.
      const { data: invitationData, error: invitationError } = await supabase
        .from('group_invitations')
        .select('*, inviter:users!group_invitations_invited_by_fkey(*)')
        .eq('group_id', groupId)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });
      if (invitationError) console.error('Group invitations failed to load:', invitationError);
      setInvitations((invitationData ?? []) as unknown as GroupInvitation[]);

      // Your connections, so inviting somebody you already know does not mean
      // retyping an address the app already has.
      const { data: friendData } = await supabase
        .from('friend_requests')
        .select('requester:users!friend_requests_requester_id_fkey(*), addressee:users!friend_requests_addressee_id_fkey(*), requester_id, addressee_id')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
        .eq('status', 'ACCEPTED');
      setFriends(
        (friendData ?? [])
          .map((row: any) => (row.requester_id === user.id ? row.addressee : row.requester))
          .filter(Boolean) as User[]
      );
    } catch (error) {
      setLoadError(friendlyDbError(error, 'Could not load this group.'));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh(`group-detail:${groupId}`, ['expenses','expense_splits','ledger_entries','group_settlements','group_members','group_invitations','group_join_requests'], load);

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
  // Deleted records are kept so the reversal that balances the ledger stays
  // readable. Once the group is square that is no longer holding anything up.
  const deletedExpenses = expenses.filter((e) => e.is_deleted);

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

  const handleEraseOne = async (expense: Expense) => {
    const ok = await confirm({
      title: 'Erase this record for good?',
      message: `"${expense.title}" was already deleted and counts towards nobody's balance. Erasing it removes it permanently and cannot be undone.`,
      confirmLabel: 'Erase',
      danger: true,
    });
    if (!ok) return;

    setBusyErase(expense.id);
    try {
      const { error } = await supabase.rpc('purge_deleted_expense', { p_expense_id: expense.id });
      if (error) throw error;
      toast.success('Erased.');
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not erase that record.'));
    } finally {
      setBusyErase(null);
    }
  };

  const handleClearDeleted = async () => {
    const count = deletedExpenses.length;
    const ok = await confirm({
      title: `Clear ${count} deleted ${count === 1 ? 'record' : 'records'}?`,
      message:
        'These were already deleted and count towards nobody\'s balance. Erasing them frees the space for good. Live expenses are left alone.',
      confirmLabel: 'Erase',
      danger: true,
    });
    if (!ok) return;

    setCleaning(true);
    try {
      const { data, error } = await supabase.rpc('purge_deleted_expenses', { p_group_id: groupId });
      if (error) throw error;
      const cleared = Number(data ?? 0);
      toast.success(`Cleared ${cleared} deleted ${cleared === 1 ? 'record' : 'records'}.`);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not clear those records.'));
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

  const openEdit = () => {
    setDraftName(group?.name ?? '');
    setDraftDesc(group?.description ?? '');
    setDraftEmoji(group?.icon_emoji ?? '💰');
    setShowManage(false);
    setShowEdit(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEdit(true);
    try {
      const { error } = await supabase.rpc('update_group', {
        p_group_id: groupId,
        p_name: draftName.trim(),
        p_description: draftDesc.trim(),
        p_icon_emoji: draftEmoji,
      });
      if (error) throw error;
      toast.success('Group updated.');
      setShowEdit(false);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not update the group.'));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteGroup = async () => {
    const ok = await confirm({
      title: 'Delete this group?',
      message:
        'The group and every expense, settlement and balance in it are erased for everyone, permanently. This cannot be undone.',
      confirmLabel: 'Delete group',
      danger: true,
    });
    if (!ok) return;

    setCleaning(true);
    try {
      const { error } = await supabase.rpc('delete_group', { p_group_id: groupId });
      if (error) throw error;
      toast.success('Group deleted.');
      onBack();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not delete the group.'));
      setCleaning(false);
    }
  };

  const handleRemoveMember = async (member: GroupMember) => {
    const name = member.user?.display_name ?? 'this member';
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: `${name} loses access to this group. Their past expenses stay on the record.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;

    setBusyMember(member.user_id);
    try {
      const { error } = await supabase.rpc('remove_group_member', {
        p_group_id: groupId,
        p_user_id: member.user_id,
      });
      if (error) throw error;
      toast.success(`${name} removed.`);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not remove that member.'));
    } finally {
      setBusyMember(null);
    }
  };

  const handleLeave = async () => {
    const ok = await confirm({
      title: 'Leave this group?',
      message: 'You lose access to its expenses. Your past entries stay on the record for everyone else.',
      confirmLabel: 'Leave',
      danger: true,
    });
    if (!ok) return;

    setCleaning(true);
    try {
      const { data, error } = await supabase.rpc('leave_group', { p_group_id: groupId });
      if (error) throw error;

      if (data === 'DELETED_EMPTY') toast.info('You were the last member — the group was removed.');
      else if (data === 'LEFT_AND_PROMOTED') toast.success('You left. Another member is now admin.');
      else toast.success('You left the group.');
      onBack();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not leave the group.'));
      setCleaning(false);
    }
  };

  const openStats = async () => {
    setShowStats(true);
    setStatsLoading(true);
    try {
      const { data, error } = await supabase.rpc('group_contribution_stats', { p_group_id: groupId });
      if (error) throw error;
      setStats((data ?? []) as any[]);
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not load the group stats.'));
      setShowStats(false);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleInviteFriend = async (friend: User) => {
    setInvitingFriend(friend.id);
    try {
      const { data, error } = await supabase.rpc('invite_friend_to_group', {
        p_group_id: groupId,
        p_friend_id: friend.id,
      });
      if (error) throw error;

      const status = (data as { out_status: string }[])?.[0]?.out_status;
      if (status === 'INVITED') toast.success(`Invited ${friend.display_name}.`);
      else if (status === 'ALREADY_INVITED') toast.info(`${friend.display_name} already has an invite.`);
      else if (status === 'ALREADY_MEMBER') toast.info(`${friend.display_name} is already in this group.`);
      await load();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not send that invite.'));
    } finally {
      setInvitingFriend(null);
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
          {/* Open to every member: admins get the management controls, everyone
              gets the members list and a way to leave. */}
          <button type="button" className="btn-icon" onClick={openStats} aria-label="Group stats">
            <PieChart size={18} />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setShowManage(true)}
            aria-label="Manage group"
          >
            <Settings2 size={18} />
          </button>
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

          {activeExpenses.length === 0 ? (
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
              {activeExpenses.some((e) => e.settled_at) && (
                <span className="hint" style={{ marginBottom: 2 }}>
                  Bills marked Settled are locked, so paid-up balances cannot reopen. To correct one, add a
                  new expense.
                </span>
              )}
              {activeExpenses.map((expense) => {
                const meta = categoryMeta(expense.category);
                // Frozen once a payment covered it — the server refuses the edit
                // either way, this just stops offering a button that cannot work.
                const isSettled = Boolean(expense.settled_at);
                const canManage = (expense.created_by === user.id || isAdmin) && !isSettled;
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
                        {isSettled && !expense.is_deleted && (
                          <span className="badge" title="Settled — locked so balances stay correct">
                            <Lock size={10} /> Settled
                          </span>
                        )}
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

          {/* Deleted records get their own section rather than sitting greyed
              out among the live ones. They were unreachable there: nothing to
              tap, and the count above says zero expenses while four rows show. */}
          {deletedExpenses.length > 0 && (
            <>
              <div className="row-between" style={{ marginTop: 'var(--sp-5)', marginBottom: 'var(--sp-3)' }}>
                <h2 className="section-title" style={{ margin: 0 }}>
                  Deleted ({deletedExpenses.length})
                </h2>
                {isAdmin && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleClearDeleted}
                    disabled={cleaning || !allSettled}
                  >
                    {cleaning ? <Spinner /> : <Eraser size={14} />} Erase all
                  </button>
                )}
              </div>

              <span className="hint" style={{ display: 'block', marginBottom: 'var(--sp-2)' }}>
                {allSettled
                  ? 'Kept so the correction stays on record. They count towards nobody\'s balance and can be erased for good.'
                  : 'Kept so the correction stays on record. They can be erased once everyone in this group is settled up.'}
              </span>

              <div className="stack-sm">
                {deletedExpenses.map((expense) => {
                  const meta = categoryMeta(expense.category);
                  return (
                    <div key={expense.id} className="card row" style={{ opacity: 0.6, gap: 'var(--sp-3)' }}>
                      <span className="icon-tile" style={{ width: 36, height: 36, fontSize: 17 }}>
                        {meta.emoji}
                      </span>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span
                          className="truncate"
                          style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}
                        >
                          {expense.title}
                        </span>
                        <span className="hint" style={{ display: 'block' }}>
                          {expense.paid_by_user?.display_name ?? 'Someone'} paid ·{' '}
                          {friendlyDate(expense.created_at.slice(0, 10))}
                        </span>
                      </span>
                      <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                        {formatLKR(expense.amount)}
                      </span>
                      {isAdmin && allSettled && (
                        <button
                          type="button"
                          className="btn-icon"
                          style={{ width: 30, height: 30, color: 'var(--negative)', flexShrink: 0 }}
                          onClick={() => handleEraseOne(expense)}
                          disabled={busyErase === expense.id}
                          aria-label={`Erase ${expense.title} permanently`}
                        >
                          {busyErase === expense.id ? <Spinner /> : <Trash2 size={13} />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'balances' && (
        <>
          {/* The chart was only reachable from an unlabelled icon in the header,
              which is not somewhere anyone looks for it. This is the screen you
              are on when you want to know who has been paying. */}
          <button
            type="button"
            className="card card-interactive row"
            style={{ width: '100%', textAlign: 'left', marginBottom: 'var(--sp-4)' }}
            onClick={openStats}
          >
            <span
              className="icon-tile"
              style={{ width: 38, height: 38, background: 'var(--primary-container)', color: 'var(--primary)' }}
            >
              <PieChart size={18} />
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 700, fontSize: '0.9rem' }}>Who paid what</span>
              <span className="hint">
                Each person&rsquo;s share of everything this group has spent, as a chart.
              </span>
            </span>
            <ChevronRight size={16} color="var(--on-surface-faint)" />
          </button>

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

      {showStats && group && (
        <Sheet title={`${group.icon_emoji} ${group.name} · stats`} onClose={() => setShowStats(false)}>
          {statsLoading ? (
            <SkeletonRows count={4} />
          ) : (
            (() => {
              const contributors = stats.filter((r: any) => Number(r.out_paid) > 0);
              const total = contributors.reduce((sum: number, r: any) => sum + Number(r.out_paid), 0);
              const slices = contributors.map((r: any, i: number) => ({
                label: r.out_display_name as string,
                value: Number(r.out_paid),
                color: SLICE_COLORS[i % SLICE_COLORS.length],
              }));

              if (total <= 0) {
                return (
                  <EmptyState
                    icon="📊"
                    title="Nothing spent yet"
                    text="Add a bill and this will show who has been fronting the money."
                  />
                );
              }

              return (
                <div className="stack">
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <DonutChart data={slices} total={total} centerLabel={formatLKR(total)} />
                  </div>
                  <span className="hint" style={{ textAlign: 'center' }}>
                    Who has paid out on the group&rsquo;s behalf, as a share of {formatLKR(total)} spent.
                    Settling up is not counted — paying someone back is not group spending.
                  </span>

                  <span className="label label-block">Contributions</span>
                  <div className="stack-sm">
                    {contributors.map((row: any, i: number) => {
                      const paid = Number(row.out_paid);
                      const share = Number(row.out_share);
                      const net = Number(row.out_net);
                      const pct = Math.round((paid / total) * 100);
                      return (
                        // Spending by a deleted account has no user id — it is
                        // one aggregate row, so a fixed key is unique.
                        <div key={row.out_user_id ?? 'former'} className="card row">
                          <span
                            aria-hidden="true"
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              flexShrink: 0,
                              background: SLICE_COLORS[i % SLICE_COLORS.length],
                            }}
                          />
                          <Avatar name={row.out_display_name} url={row.out_avatar_url} size={32} />
                          <span className="grow" style={{ minWidth: 0 }}>
                            {/* display:block on both — .truncate and .hint set no
                                display, so as bare spans the name and the figures
                                run together on one line. */}
                            <span
                              className="truncate"
                              style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600 }}
                            >
                              {row.out_user_id === user.id ? 'You' : row.out_display_name}
                            </span>
                            <span className="hint" style={{ display: 'block' }}>
                              paid {formatLKR(paid)} · own share {formatLKR(share)}
                            </span>
                          </span>
                          <span style={{ textAlign: 'right', flexShrink: 0 }}>
                            <span className="amount-md tabular" style={{ display: 'block' }}>
                              {pct}%
                            </span>
                            <span
                              className={`hint ${net > 0 ? 'text-positive' : net < 0 ? 'text-negative' : ''}`}
                            >
                              {Math.abs(net) < 0.01
                                ? 'even'
                                : net > 0
                                  ? `+${formatLKR(net)}`
                                  : `-${formatLKR(Math.abs(net))}`}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {stats.some((r: any) => Number(r.out_paid) === 0) && (
                    <span className="hint">
                      {stats
                        .filter((r: any) => Number(r.out_paid) === 0)
                        .map((r: any) => (r.out_user_id === user.id ? 'You' : r.out_display_name))
                        .join(', ')}{' '}
                      {stats.filter((r: any) => Number(r.out_paid) === 0).length === 1 ? 'has' : 'have'} not
                      paid for anything yet.
                    </span>
                  )}
                </div>
              );
            })()
          )}
        </Sheet>
      )}

      {showManage && group && (
        <Sheet title="Manage group" onClose={() => setShowManage(false)}>
          <div className="stack">
            {isAdmin && (
              <button type="button" className="btn btn-secondary btn-block" onClick={openEdit}>
                <Pencil size={15} /> Edit name, description & icon
              </button>
            )}

            {/* ---- Members ---- */}
            <div>
              <span className="label label-block">Members</span>
              <div className="card card-flush">
                {members.map((member) => {
                  const balance = balances[member.user_id] ?? 0;
                  const isMe = member.user_id === user.id;
                  const owes = Math.abs(balance) >= 0.01;
                  return (
                    <div key={member.id} className="list-row">
                      <Avatar name={member.user?.display_name} url={member.user?.avatar_url} size={32} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="row" style={{ gap: 5 }}>
                          <span className="truncate" style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                            {isMe ? 'You' : member.user?.display_name ?? 'Member'}
                          </span>
                          {member.role === 'ADMIN' && <span className="badge badge-warning">Admin</span>}
                        </span>
                        <span className={`hint ${owes ? 'text-negative' : ''}`}>
                          {owes ? `${formatLKRSigned(balance)} — must settle first` : 'Settled'}
                        </span>
                      </span>
                      {isAdmin && !isMe && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleRemoveMember(member)}
                          disabled={owes || busyMember === member.user_id}
                          title={owes ? 'Settle up with them first' : 'Remove from group'}
                        >
                          {busyMember === member.user_id ? <Spinner /> : 'Remove'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {isAdmin && (
              <>
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

              {/* ---- Clear only what was already deleted ---- */}
              <div className="card">
                <span className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <Eraser size={16} color="var(--primary)" />
                  <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>Clear deleted records</span>
                </span>
                <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                  Expenses somebody deleted are kept until the group is settled, so the correction stays on
                  record. Erasing them afterwards frees the space and leaves every live expense untouched.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-block"
                  onClick={handleClearDeleted}
                  disabled={cleaning || !allSettled || deletedExpenses.length === 0}
                >
                  {cleaning && <Spinner />}
                  {deletedExpenses.length === 0
                    ? 'Nothing deleted to clear'
                    : `Clear ${deletedExpenses.length} deleted record${deletedExpenses.length === 1 ? '' : 's'}`}
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

              {/* ---- Delete the whole group ---- */}
              <div className="card" style={{ borderColor: 'var(--negative)' }}>
                <span className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <Trash2 size={16} color="var(--negative)" />
                  <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>Delete group</span>
                </span>
                <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                  Removes the group and everything in it, for every member. <strong>This cannot be undone.</strong>
                </p>
                <button
                  type="button"
                  className="btn btn-danger btn-block"
                  onClick={handleDeleteGroup}
                  disabled={cleaning || !allSettled}
                >
                  {cleaning && <Spinner />}
                  Delete group
                </button>
              </div>
              </>
            )}

            {/* ---- Leave: available to every member ---- */}
            <div className="card">
              <span className="row" style={{ gap: 8, marginBottom: 6 }}>
                <LogOut size={16} />
                <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>Leave group</span>
              </span>
              <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                {Math.abs(myBalance) >= 0.01
                  ? 'Settle your own balance first — leaving with money outstanding would strand the debt.'
                  : 'You lose access to this group. Your past expenses stay on the record for everyone else.'}
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={handleLeave}
                disabled={cleaning || Math.abs(myBalance) >= 0.01}
              >
                {cleaning && <Spinner />}
                Leave group
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {showEdit && group && (
        <Sheet title="Edit group" onClose={() => setShowEdit(false)}>
          <form onSubmit={handleSaveEdit} className="stack">
            <div className="field">
              <span className="label label-block">Icon</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                {GROUP_EMOJIS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`emoji-btn ${draftEmoji === option ? 'is-selected' : ''}`}
                    onClick={() => setDraftEmoji(option)}
                    aria-label={`Icon ${option}`}
                    aria-pressed={draftEmoji === option}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="text"
              className="input"
              placeholder="Group name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={60}
              required
              autoFocus
            />
            <input
              type="text"
              className="input"
              placeholder="Description (optional)"
              value={draftDesc}
              onChange={(e) => setDraftDesc(e.target.value)}
              maxLength={140}
            />

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={savingEdit || !draftName.trim()}
            >
              {savingEdit && <Spinner />}
              {savingEdit ? 'Saving…' : 'Save changes'}
            </button>
          </form>
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

                {(() => {
                  const memberIds = new Set(members.map((m) => m.user_id));
                  const invitedIds = new Set(invitations.map((i) => i.invited_user_id).filter(Boolean));
                  const available = friends.filter(
                    (f) => !memberIds.has(f.id) && !invitedIds.has(f.id)
                  );
                  if (available.length === 0) return null;
                  return (
                    <div style={{ textAlign: 'left' }}>
                      <span className="label label-block">Your friends</span>
                      <div className="stack-sm">
                        {available.map((f) => (
                          <div key={f.id} className="card row">
                            <Avatar name={f.display_name} url={f.avatar_url} size={32} />
                            <span className="grow truncate" style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                              {f.display_name}
                            </span>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => handleInviteFriend(f)}
                              disabled={invitingFriend === f.id}
                            >
                              {invitingFriend === f.id ? <Spinner /> : 'Invite'}
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="row" style={{ margin: 'var(--sp-3) 0' }}>
                        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                        <span className="hint">or by email</span>
                        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                      </div>
                    </div>
                  );
                })()}

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
