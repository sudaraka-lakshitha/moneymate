import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLiveRefresh } from '../lib/realtime';
import { Expense, ExpenseCategory, FriendRequest, Group, GroupMember, GroupSettlement, User } from '../types';
import { formatLKR, formatLKRSigned, parseAmount, roundMoney } from '../lib/currency';
import { computeFriendBalances, FriendBalanceDetail, GroupLedger, netByUser } from '../lib/balances';
import { friendlyDbError } from '../lib/authErrors';
import { CATEGORIES, categoryMeta } from '../lib/categories';
import { friendlyDate } from '../lib/dates';
import { Alert, Avatar, EmptyState, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { SettleUpSheet, SettleTarget } from '../components/SettleUpSheet';
import { AddExpenseModal } from './AddExpenseModal';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { Check, Clock, Eraser, HandCoins, Pencil, Trash2, UserMinus, UserPlus, Search, X, Pin } from 'lucide-react';

interface FriendsPageProps {
  user: User;
}

/**
 * One transaction the two of you are both on. A friend's balance is the sum of
 * these, and a total on its own is not something anybody can check or correct —
 * so the sheet lists them.
 */
interface PairRecord {
  expense: Expense;
  groupId: string;
  groupName?: string;
  isDirect: boolean;
  /** What this expense charged you, and what it charged them. */
  myShare: number;
  theirShare: number;
}

/** A row shown in the list — either shared-balance data, a direct connection, or both. */
interface DisplayFriend extends FriendBalanceDetail {
  isConnected: boolean;
  isPinned: boolean;
}

const emailOf = (row: FriendRequest, meId: string): string =>
  (row.requester_id === meId ? row.addressee?.display_name : row.requester?.display_name) ||
  row.addressee_email;

export const FriendsPage: React.FC<FriendsPageProps> = ({ user }) => {
  const toast = useToast();
  const confirm = useConfirm();

  const [friends, setFriends] = useState<DisplayFriend[]>([]);
  const [settlements, setSettlements] = useState<GroupSettlement[]>([]);
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [directGroupIds, setDirectGroupIds] = useState<Set<string>>(new Set());
  /** friendId -> the id of the hidden 1:1 group holding our direct records. */
  const [directGroupByFriend, setDirectGroupByFriend] = useState<Record<string, string>>({});
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DisplayFriend | null>(null);
  const [settleTarget, setSettleTarget] = useState<SettleTarget | null>(null);
  const [settleChoices, setSettleChoices] = useState<SettleTarget[]>([]);

  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);

  const [lendTo, setLendTo] = useState<User | null>(null);
  const [lendAmount, setLendAmount] = useState('');
  const [lendNote, setLendNote] = useState('');
  const [lendCategory, setLendCategory] = useState<ExpenseCategory>('OTHER');
  const [lendMode, setLendMode] = useState<'LENT' | 'BORROWED' | 'SHARED'>('LENT');
  const [iPaid, setIPaid] = useState(true);
  const [theirShare, setTheirShare] = useState('');
  const [lending, setLending] = useState(false);
  const [lendError, setLendError] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<Expense | null>(null);
  const [directEntries, setDirectEntries] = useState<Expense[]>([]);
  /** expenseId -> friendId -> their stored share, so editing never guesses. */
  const [directShares, setDirectShares] = useState<Record<string, Record<string, number>>>({});
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [removingFriend, setRemovingFriend] = useState(false);
  const [clearingDeleted, setClearingDeleted] = useState(false);
  /** groupId -> its members, so a group bill can be edited from here. */
  const [membersByGroup, setMembersByGroup] = useState<Record<string, GroupMember[]>>({});
  /** Every expense the two of you are both on, direct or in a shared group. */
  const [pairRecords, setPairRecords] = useState<PairRecord[]>([]);
  const [pairLoading, setPairLoading] = useState(false);
  const [editingGroupExpense, setEditingGroupExpense] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: memberships, error: membershipError } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);
      if (membershipError) throw membershipError;

      const groups = (memberships ?? []).map((row: any) => row.groups).filter(Boolean) as Group[];
      const groupIds = groups.map((g) => g.id);

      const [memberRes, ledgerRes, requestRes, pinRes, settlementRes] = await Promise.all([
        groupIds.length > 0
          ? supabase.from('group_members').select('group_id, user_id, users(*)').in('group_id', groupIds)
          : Promise.resolve({ data: [], error: null }),
        groupIds.length > 0
          ? supabase.from('ledger_entries').select('group_id, user_id, amount').in('group_id', groupIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('friend_requests')
          .select(
            '*, requester:users!friend_requests_requester_id_fkey(*), addressee:users!friend_requests_addressee_id_fkey(*)'
          )
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
          .in('status', ['PENDING', 'ACCEPTED']),
        supabase.from('friend_pins').select('friend_id').eq('user_id', user.id),
        // Payments you have made or received. Settlements live on a group, so
        // this is the only place a friend-to-friend payment history can come
        // from — the friend sheet filters it down to the pair.
        groupIds.length > 0
          ? supabase
              .from('group_settlements')
              .select('*')
              .in('group_id', groupIds)
              .or(`from_user.eq.${user.id},to_user.eq.${user.id}`)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (memberRes.error) throw memberRes.error;
      if (ledgerRes.error) throw ledgerRes.error;
      if (requestRes.error) throw requestRes.error;

      const pinnedIds = new Set((pinRes.data ?? []).map((row: any) => row.friend_id as string));
      setSettlements((settlementRes.data ?? []) as GroupSettlement[]);

      // Individual loans and shared bills recorded directly with a friend.
      // Without these the friend sheet could show a balance nobody could open,
      // correct or remove.
      const directIds = groups.filter((g) => g.is_direct).map((g) => g.id);
      if (directIds.length > 0) {
        const { data: directData } = await supabase
          .from('expenses')
          .select('*')
          .in('group_id', directIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: false });
        const entries = (directData ?? []) as Expense[];
        setDirectEntries(entries);

        // The stored split, not a guess. Opening an edit without it would fall
        // back to an even split and silently halve a loan on save.
        if (entries.length > 0) {
          const { data: splitData } = await supabase
            .from('expense_splits')
            .select('expense_id, user_id, amount')
            .in('expense_id', entries.map((x) => x.id));
          const map: Record<string, Record<string, number>> = {};
          for (const row of (splitData ?? []) as any[]) {
            (map[row.expense_id] ||= {})[row.user_id] = Number(row.amount);
          }
          setDirectShares(map);
        } else {
          setDirectShares({});
        }
      } else {
        setDirectEntries([]);
        setDirectShares({});
      }
      const byGroup: Record<string, GroupMember[]> = {};
      for (const row of (memberRes.data ?? []) as any[]) {
        (byGroup[row.group_id] ||= []).push({ ...row, user: row.users } as GroupMember);
      }
      setMembersByGroup(byGroup);

      setGroupNames(Object.fromEntries(groups.map((g) => [g.id, g.name])));
      const directIdSet = new Set(groups.filter((g) => g.is_direct).map((g) => g.id));
      setDirectGroupIds(directIdSet);
      setDirectGroupByFriend(
        Object.fromEntries(
          (memberRes.data ?? [])
            .filter((row: any) => directIdSet.has(row.group_id) && row.user_id !== user.id)
            .map((row: any) => [row.user_id as string, row.group_id as string])
        )
      );

      const ledgers: GroupLedger[] = groups.map((group) => ({
        groupId: group.id,
        groupName: group.name,
        isDirect: Boolean(group.is_direct),
        balances: netByUser((ledgerRes.data ?? []).filter((row: any) => row.group_id === group.id)),
        members: Object.fromEntries(
          (memberRes.data ?? [])
            .filter((row: any) => row.group_id === group.id && row.users)
            .map((row: any) => [row.user_id, row.users as User])
        ),
      }));

      const balanceFriends = computeFriendBalances(ledgers, user.id);
      const requests = (requestRes.data ?? []) as unknown as FriendRequest[];

      const accepted = requests.filter((r) => r.status === 'ACCEPTED');
      const connectedIds = new Set(
        accepted.map((r) => (r.requester_id === user.id ? r.addressee_id : r.requester_id)).filter(Boolean)
      );

      const merged: DisplayFriend[] = balanceFriends.map((f) => ({
        ...f,
        isConnected: connectedIds.has(f.friend.id),
        isPinned: pinnedIds.has(f.friend.id),
      }));

      // Every accepted friend appears, whether or not you share a group and
      // whether or not there is money between you — a friend you added should
      // never be invisible just because you are square. Falls back to the stored
      // email when the profile row is unreadable, so the row still renders.
      for (const row of accepted) {
        const friendUser = row.requester_id === user.id ? row.addressee : row.requester;
        const friendId = row.requester_id === user.id ? row.addressee_id : row.requester_id;
        if (merged.some((m) => m.friend.id === (friendUser?.id ?? friendId))) continue;

        const resolved: User = friendUser ?? {
          id: friendId ?? row.id,
          display_name: row.addressee_email,
          email: row.addressee_email,
        };

        merged.push({
          friend: resolved,
          net_balance: 0,
          total_they_owe_me: 0,
          total_i_owe_them: 0,
          shared_group_count: 0,
          perGroup: [],
          groupIds: [],
          isConnected: true,
          isPinned: pinnedIds.has(resolved.id),
        });
      }

      // A row earns its place by being a connection or by having money
      // outstanding. Sharing a group makes somebody a group-mate, not a friend —
      // they are already listed inside that group, and keeping them here is why
      // people who are no longer friends never left the list.
      const visible = merged.filter(
        (f) => f.isConnected || Math.abs(f.net_balance) >= 0.01
      );

      // Pinned first, then by how much money is at stake, then settled friends.
      visible.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return Math.abs(b.net_balance) - Math.abs(a.net_balance);
      });
      setFriends(visible);
      setIncoming(requests.filter((r) => r.status === 'PENDING' && r.addressee_id === user.id));
      setOutgoing(requests.filter((r) => r.status === 'PENDING' && r.requester_id === user.id));
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your friends.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh('friends', ['expenses','ledger_entries','group_settlements','friend_requests','group_members'], load);

  const totals = useMemo(() => {
    let owedToMe = 0;
    let owedByMe = 0;
    for (const friend of friends) {
      if (friend.net_balance > 0) owedToMe += friend.net_balance;
      else owedByMe += Math.abs(friend.net_balance);
    }
    return { owedToMe, owedByMe, net: owedToMe - owedByMe };
  }, [friends]);

  const filtered = friends.filter((f) =>
    f.friend.display_name.toLowerCase().includes(search.trim().toLowerCase())
  );

  /**
   * Everything the two of you are both on — the direct records plus every bill
   * in a shared group that charged you both. Fetched when the sheet opens
   * rather than up front, because it is per friend and the list screen never
   * needs it.
   */
  const loadPairRecords = useCallback(
    async (friendId: string, groupIds: string[]) => {
      if (groupIds.length === 0) {
        setPairRecords([]);
        return;
      }
      setPairLoading(true);
      try {
        const { data, error: pairError } = await supabase
          .from('expenses')
          .select('*, paid_by_user:users!expenses_paid_by_fkey(*), expense_splits(user_id, amount, is_included)')
          .in('group_id', groupIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(200);
        if (pairError) throw pairError;

        const rows: PairRecord[] = [];
        for (const row of (data ?? []) as any[]) {
          const splits = (row.expense_splits ?? []) as { user_id: string; amount: number; is_included: boolean }[];
          const mine = splits.find((sp) => sp.user_id === user.id && sp.is_included);
          const theirs = splits.find((sp) => sp.user_id === friendId && sp.is_included);

          // Both of you have to be on it, as a payer or as a share. A bill your
          // flatmate split with somebody else is not a transaction between you.
          const iAmOn = Boolean(mine) || row.paid_by === user.id;
          const theyAreOn = Boolean(theirs) || row.paid_by === friendId;
          if (!iAmOn || !theyAreOn) continue;

          rows.push({
            expense: row as Expense,
            groupId: row.group_id,
            groupName: groupNames[row.group_id],
            isDirect: directGroupIds.has(row.group_id),
            myShare: Number(mine?.amount ?? 0),
            theirShare: Number(theirs?.amount ?? 0),
          });
        }
        setPairRecords(rows);
      } catch (err) {
        toast.error(friendlyDbError(err, 'Could not load the records between you.'));
        setPairRecords([]);
      } finally {
        setPairLoading(false);
      }
    },
    [user.id, groupNames, directGroupIds, toast]
  );

  useEffect(() => {
    if (!selected) {
      setPairRecords([]);
      return;
    }
    const direct = directGroupByFriend[selected.friend.id];
    const ids = Array.from(new Set([...(direct ? [direct] : []), ...selected.groupIds]));
    void loadPairRecords(selected.friend.id, ids);
  }, [selected?.friend.id, loadPairRecords, directGroupByFriend]);

  /** Every outstanding part of this friend's balance, largest first. */
  const settleOptions = useMemo<SettleTarget[]>(() => {
    if (!selected) return [];
    return selected.perGroup
      .filter((entry) => Math.abs(entry.net) >= 0.01)
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .map((entry) => ({
        groupId: entry.groupId,
        // The pair group's internal name would read "Between you and X" on X's
        // own settle sheet.
        groupName: directGroupIds.has(entry.groupId) ? undefined : entry.groupName,
        payee: selected.friend,
        suggestedAmount: Math.abs(entry.net),
        // Positive means they owe me, so the payment comes from them.
        direction: entry.net > 0 ? ('THEY_PAY' as const) : ('I_PAY' as const),
      }));
  }, [selected, directGroupIds]);

  /**
   * Settlements post against one group, so the single button opens on the
   * largest outstanding balance; the sheet lets you switch to another.
   */
  const settleablePart = useMemo(() => {
    if (!selected) return null;
    const live = selected.perGroup.filter((g) => Math.abs(g.net) >= 0.01);
    if (live.length === 0) return null;
    return live.reduce((biggest, g) => (Math.abs(g.net) > Math.abs(biggest.net) ? g : biggest));
  }, [selected]);

  /** Payments between me and the friend whose sheet is open, newest first. */
  const selectedHistory = useMemo(() => {
    if (!selected) return [];
    const friendId = selected.friend.id;
    return settlements.filter(
      (s) =>
        (s.from_user === user.id && s.to_user === friendId) ||
        (s.from_user === friendId && s.to_user === user.id)
    );
  }, [selected, settlements, user.id]);

  const isPositive = totals.net >= 0;

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setSending(true);

    try {
      const { data, error: rpcError } = await supabase.rpc('send_friend_request', {
        p_email: addEmail.trim(),
      });
      if (rpcError) throw rpcError;

      const result = (data as { out_status: string }[])?.[0];
      switch (result?.out_status) {
        case 'SENT':
          toast.success('Friend request sent.');
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'SENT_PENDING_SIGNUP':
          toast.success("Sent — they'll see it once they sign up with that email.");
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'ACCEPTED_EXISTING':
          toast.success("You're now friends — they had already added you!");
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'ALREADY_FRIENDS':
          setAddError("You're already friends with them.");
          break;
        case 'ALREADY_PENDING':
          setAddError('Already sent — waiting on a response.');
          break;
        case 'SELF':
          setAddError("That's your own email.");
          break;
        case 'INVALID_EMAIL':
          setAddError('Enter a valid email address.');
          break;
        default:
          setAddError('Could not send the request.');
      }
    } catch (err) {
      setAddError(friendlyDbError(err, 'Could not send the request.'));
    } finally {
      setSending(false);
    }
  };

  const handleRespond = async (request: FriendRequest, accept: boolean) => {
    setRespondingTo(request.id);
    try {
      const { error: rpcError } = await supabase.rpc('respond_to_friend_request', {
        p_request_id: request.id,
        p_accept: accept,
      });
      if (rpcError) throw rpcError;
      toast[accept ? 'success' : 'info'](
        accept ? `You and ${request.requester?.display_name ?? 'they'} are now friends.` : 'Request declined.'
      );
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not respond to the request.'));
    } finally {
      setRespondingTo(null);
    }
  };

  const handleCancel = async (request: FriendRequest) => {
    setRespondingTo(request.id);
    try {
      const { error: rpcError } = await supabase.rpc('cancel_friend_request', {
        p_request_id: request.id,
      });
      if (rpcError) throw rpcError;
      toast.info('Request withdrawn.');
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not withdraw the request.'));
    } finally {
      setRespondingTo(null);
    }
  };

  const openLend = (friend: User) => {
    setLendTo(friend);
    setEditingEntry(null);
    setLendAmount('');
    setLendNote('');
    setLendMode('LENT');
    setIPaid(true);
    setTheirShare('');
    setLendCategory('OTHER');
    setLendError(null);
    setSelected(null);
  };

  const openEditEntry = (entry: Expense, friend: User) => {
    const iPaidIt = entry.paid_by === user.id;
    const theirs = directShares[entry.id]?.[friend.id] ?? roundMoney(Number(entry.amount) / 2);
    const total = roundMoney(Number(entry.amount));

    setLendTo(friend);
    setEditingEntry(entry);
    setLendAmount(String(entry.amount));
    setLendNote(entry.title === 'Loan' || entry.title === 'Shared expense' ? '' : entry.title);
    setIPaid(iPaidIt);
    setTheirShare(String(theirs));
    setLendCategory((entry.category ?? 'OTHER') as ExpenseCategory);

    // Reopen as it was recorded, so saving without touching anything cannot
    // quietly change what the record means. The stored flag decides, not the
    // numbers: "I lent you 5,000" and "I paid your 5,000 bill" look the same.
    if (entry.is_loan === false) setLendMode('SHARED');
    else if (iPaidIt && Math.abs(theirs - total) < 0.01) setLendMode('LENT');
    else if (!iPaidIt && Math.abs(theirs) < 0.01) setLendMode('BORROWED');
    else setLendMode('SHARED');

    setLendError(null);
    setSelected(null);
  };

  const handleDeleteEntry = async (entry: Expense) => {
    const ok = await confirm({
      title: 'Delete this record?',
      message: `"${entry.title}" will be removed and your balance updated.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    setBusyEntry(entry.id);
    try {
      const { error: rpcError } = await supabase.rpc('delete_expense', {
        p_expense_id: entry.id,
        p_reason: 'Removed from Friends',
      });
      if (rpcError) throw rpcError;
      toast.success('Record deleted.');
      await load();
      if (selected) await loadPairRecords(selected.friend.id, selected.groupIds);
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not delete that record.'));
    } finally {
      setBusyEntry(null);
    }
  };

  const handleLend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lendTo) return;

    const amount = roundMoney(parseAmount(lendAmount));
    if (amount <= 0) {
      setLendError('Enter an amount greater than zero.');
      return;
    }

    // Every case is "who paid" plus "how much of it is theirs".
    //   lent     -> I paid, all of it is theirs
    //   borrowed -> they paid, none of it is theirs
    //   shared   -> whoever paid, split (evenly unless overridden)
    const paidByMe = lendMode === 'SHARED' ? iPaid : lendMode === 'LENT';
    // Lending and paying somebody's bill produce identical numbers and mean
    // opposite things, so the choice made here travels with the record instead
    // of being guessed back out of the split later.
    const isLoan = lendMode !== 'SHARED';
    let share: number;
    if (lendMode === 'LENT') share = amount;
    else if (lendMode === 'BORROWED') share = 0;
    else share = theirShare.trim() ? roundMoney(parseAmount(theirShare)) : roundMoney(amount / 2);

    if (share < 0 || share > amount) {
      setLendError(`Their share must be between Rs. 0 and ${formatLKR(amount)}.`);
      return;
    }

    setLending(true);
    try {
      const { error: rpcError } = editingEntry
        ? await supabase.rpc('update_direct_expense', {
            p_expense_id: editingEntry.id,
            p_amount: amount,
            p_note: lendNote.trim(),
            p_i_paid: paidByMe,
            p_their_share: share,
            p_is_loan: isLoan,
            p_category: isLoan ? 'OTHER' : lendCategory,
          })
        : await supabase.rpc('add_direct_expense', {
            p_friend_id: lendTo.id,
            p_amount: amount,
            p_note: lendNote.trim(),
            p_i_paid: paidByMe,
            p_their_share: share,
            p_is_loan: isLoan,
            p_category: isLoan ? 'OTHER' : lendCategory,
          });
      if (rpcError) throw rpcError;

      // What changes hands is their share when I paid, my share when they did.
      const delta = paidByMe ? share : amount - share;
      toast.success(
        delta === 0
          ? 'Recorded.'
          : paidByMe
            ? `Recorded — ${lendTo.display_name} owes you ${formatLKR(delta)}.`
            : `Recorded — you owe ${lendTo.display_name} ${formatLKR(delta)}.`
      );
      setLendTo(null);
      setEditingEntry(null);
      await load();
      if (selected) await loadPairRecords(selected.friend.id, selected.groupIds);
    } catch (err) {
      setLendError(friendlyDbError(err, 'Could not record that.'));
    } finally {
      setLending(false);
    }
  };

  const handleRemoveFriend = async (friend: DisplayFriend) => {
    const owing = Math.abs(friend.net_balance) >= 0.01;

    // How much shared history removal would leave behind, asked before the
    // confirmation so it can name a number rather than warn vaguely.
    let records = 0;
    if (!owing) {
      const { data } = await supabase.rpc('friend_record_count', { p_friend_id: friend.friend.id });
      records = Number(data ?? 0);
    }

    const ok = await confirm({
      title: `Remove ${friend.friend.display_name}?`,
      message: owing
        ? `There is still ${formatLKR(Math.abs(friend.net_balance))} between you. Settle up first.`
        : records > 0
          ? `They will leave your friends list. The ${records} ${records === 1 ? 'record' : 'records'} between you stay saved on both sides — you will be asked next whether to erase those too.`
          : 'They will leave your friends list. You can add them again later.',
      confirmLabel: owing ? 'OK' : 'Remove',
      danger: !owing,
    });
    if (!ok || owing) return;

    // Erasing is a separate answer because it is the destructive half: it takes
    // the records off the other person's screen as well, and they never agreed
    // to that. Saying no still removes the friend.
    let purge = false;
    if (records > 0) {
      purge = await confirm({
        title: 'Erase the records too?',
        message: `This permanently deletes the ${records} ${records === 1 ? 'record' : 'records'} between you, for both of you. It cannot be undone. Choose Keep to remove the friend but leave the history in place.`,
        confirmLabel: 'Erase',
        cancelLabel: 'Keep',
        danger: true,
      });
    }

    setRemovingFriend(true);
    try {
      const { error: rpcError } = await supabase.rpc('remove_friend', {
        p_friend_id: friend.friend.id,
        p_purge_history: purge,
      });
      if (rpcError) throw rpcError;
      toast.info(
        purge
          ? `${friend.friend.display_name} removed and the shared records erased.`
          : `${friend.friend.display_name} removed.`
      );
      setSelected(null);
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not remove that friend.'));
    } finally {
      setRemovingFriend(false);
    }
  };

  /**
   * Permanently erases records between the two of you that were already
   * deleted. A deleted record is kept so the reversal that balances the ledger
   * stays readable; once you are square that is no longer holding anything up,
   * and the rows are pure storage.
   */
  const handleClearDeleted = async (friend: DisplayFriend) => {
    const groupId = directGroupByFriend[friend.friend.id];
    if (!groupId) return;

    setClearingDeleted(true);
    try {
      const { data, error: countError } = await supabase.rpc('deleted_expense_count', {
        p_group_id: groupId,
      });
      if (countError) throw countError;

      const count = Number(data ?? 0);
      if (count === 0) {
        toast.info('Nothing to clear — no deleted records between you.');
        return;
      }

      const ok = await confirm({
        title: `Clear ${count} deleted ${count === 1 ? 'record' : 'records'}?`,
        message:
          'These were already deleted and are not part of any balance. Erasing them frees the space for good and cannot be undone.',
        confirmLabel: 'Erase',
        danger: true,
      });
      if (!ok) return;

      const { data: cleared, error: purgeError } = await supabase.rpc('purge_deleted_expenses', {
        p_group_id: groupId,
      });
      if (purgeError) throw purgeError;
      toast.success(`Cleared ${Number(cleared ?? 0)} deleted ${Number(cleared) === 1 ? 'record' : 'records'}.`);
      await load();
    } catch (err) {
      // The commonest refusal is an unsettled balance, and the server says so.
      toast.error(friendlyDbError(err, 'Could not clear those records.'));
    } finally {
      setClearingDeleted(false);
    }
  };

  const handleTogglePin = async (friend: DisplayFriend) => {
    setPinningId(friend.friend.id);

    // Flip locally first: pinning is a list-ordering preference, and waiting on
    // a round trip to reorder makes the tap feel broken.
    const wasPinned = friend.isPinned;
    setFriends((current) =>
      current
        .map((f) => (f.friend.id === friend.friend.id ? { ...f, isPinned: !wasPinned } : f))
        .sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return Math.abs(b.net_balance) - Math.abs(a.net_balance);
        })
    );

    try {
      if (wasPinned) {
        const { error: unpinError } = await supabase
          .from('friend_pins')
          .delete()
          .eq('user_id', user.id)
          .eq('friend_id', friend.friend.id);
        if (unpinError) throw unpinError;
      } else {
        const { error: pinError } = await supabase
          .from('friend_pins')
          .insert({ user_id: user.id, friend_id: friend.friend.id });
        if (pinError) throw pinError;
      }
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not update the pin.'));
      await load(); // put the list back the way the server sees it
    } finally {
      setPinningId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Friends</h1>
          <p className="page-subtitle">What you owe, and what you are owed</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
          <UserPlus size={15} /> Add
        </button>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {incoming.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="label">
            {incoming.length} friend request{incoming.length === 1 ? '' : 's'}
          </span>
          {incoming.map((req) => (
            <div key={req.id} className="card row">
              <Avatar name={req.requester?.display_name} url={req.requester?.avatar_url} size={40} />
              <span className="grow truncate" style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                {req.requester?.display_name ?? req.addressee_email}
              </span>
              <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 32, height: 32 }}
                  onClick={() => handleRespond(req, false)}
                  disabled={respondingTo === req.id}
                  aria-label="Decline"
                >
                  <X size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleRespond(req, true)}
                  disabled={respondingTo === req.id}
                >
                  {respondingTo === req.id ? <Spinner /> : <Check size={14} />}
                  Accept
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="label">Waiting on a response</span>
          {outgoing.map((req) => (
            <div key={req.id} className="card row">
              <span className="icon-tile" style={{ width: 40, height: 40 }}>
                <Clock size={16} color="var(--on-surface-variant)" />
              </span>
              <span className="grow truncate" style={{ fontSize: '0.9rem' }}>
                {emailOf(req, user.id)}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleCancel(req)}
                disabled={respondingTo === req.id}
              >
                {respondingTo === req.id ? <Spinner /> : 'Cancel'}
              </button>
            </div>
          ))}
        </div>
      )}

      <section
        className={`card-hero ${Math.abs(totals.net) < 0.01 ? 'is-neutral' : isPositive ? 'is-positive' : 'is-negative'}`}
        style={{ marginBottom: 'var(--sp-5)' }}
      >
        <span className="label">Net across all friends</span>
        <div
          className={`amount-xl tabular ${Math.abs(totals.net) < 0.01 ? '' : isPositive ? 'text-positive' : 'text-negative'}`}
          style={{ margin: '6px 0 4px' }}
        >
          {formatLKRSigned(totals.net)}
        </div>
        <span className="hint">
          {Math.abs(totals.net) < 0.01
            ? 'Everyone is square'
            : isPositive
              ? 'You are owed overall'
              : 'You owe overall'}
        </span>

        <div className="row card-divider" style={{ gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}>
          <div>
            <div className="label">You are owed</div>
            <div className="amount-md tabular text-positive">{formatLKR(totals.owedToMe)}</div>
          </div>
          <div>
            <div className="label">You owe</div>
            <div className="amount-md tabular text-negative">{formatLKR(totals.owedByMe)}</div>
          </div>
        </div>
      </section>

      {friends.length > 4 && (
        <div className="card row" style={{ padding: '6px var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
          <Search size={17} color="var(--on-surface-variant)" />
          <input
            type="search"
            className="grow"
            placeholder="Search friends…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ background: 'none', border: 'none', outline: 'none', padding: '8px 0', fontSize: '0.9rem' }}
          />
        </div>
      )}

      {loading ? (
        <SkeletonRows count={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🤝"
          title={search ? 'No matches' : 'No friends yet'}
          text={
            search
              ? 'Try a different name.'
              : 'Add a friend by email, or join a group and split a bill — everyone you share a group with shows up here.'
          }
          action={
            !search && (
              <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <UserPlus size={15} /> Add a friend
              </button>
            )
          }
        />
      ) : (
        <div className="stack-sm">
          {filtered.map((friend) => {
            const settled = Math.abs(friend.net_balance) < 0.01;
            return (
              // A div, not a button: the pin is its own control and a button
              // cannot legally nest inside another button.
              <div key={friend.friend.id} className="card card-interactive row">
                <button
                  type="button"
                  className="row grow"
                  onClick={() => setSelected(friend)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    minWidth: 0,
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <Avatar name={friend.friend.display_name} url={friend.friend.avatar_url} size={42} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="row" style={{ gap: 5 }}>
                      <span className="truncate" style={{ fontWeight: 700, fontSize: '0.93rem' }}>
                        {friend.friend.display_name}
                      </span>
                      {friend.isConnected && <span className="badge badge-info">Friend</span>}
                    </span>
                    <span className="hint">
                      {friend.shared_group_count > 0
                        ? `${friend.shared_group_count} shared group${friend.shared_group_count === 1 ? '' : 's'}`
                        : Math.abs(friend.net_balance) >= 0.01
                          ? 'Direct — no shared group'
                          : 'No shared groups yet'}
                    </span>
                  </span>
                  <span style={{ textAlign: 'right', flexShrink: 0 }}>
                    <span
                      className={`amount-md tabular ${settled ? 'text-neutral' : friend.net_balance > 0 ? 'text-positive' : 'text-negative'}`}
                      style={{ display: 'block' }}
                    >
                      {settled ? 'Settled' : formatLKR(Math.abs(friend.net_balance))}
                    </span>
                    <span className="hint">
                      {settled ? 'all square' : friend.net_balance > 0 ? 'owes you' : 'you owe'}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 30, height: 30, flexShrink: 0 }}
                  onClick={() => handleTogglePin(friend)}
                  disabled={pinningId === friend.friend.id}
                  aria-pressed={friend.isPinned}
                  aria-label={
                    friend.isPinned
                      ? `Unpin ${friend.friend.display_name}`
                      : `Pin ${friend.friend.display_name} to the top`
                  }
                  title={friend.isPinned ? 'Unpin' : 'Pin to top'}
                >
                  {/* Same icon either way, filled when pinned. A crossed-out pin
                      here would read as "pinning is disabled" rather than
                      "tap to pin". */}
                  <Pin
                    size={14}
                    fill={friend.isPinned ? 'currentColor' : 'none'}
                    color={friend.isPinned ? 'var(--primary)' : 'var(--on-surface-faint)'}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <Sheet title={selected.friend.display_name} onClose={() => setSelected(null)}>
          <div className="stack">
            <div className="row" style={{ justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              <Avatar name={selected.friend.display_name} url={selected.friend.avatar_url} size={64} />
              {selected.isConnected && <span className="badge badge-info">Friend</span>}
              <span
                className={`amount-lg tabular ${
                  Math.abs(selected.net_balance) < 0.01
                    ? 'text-neutral'
                    : selected.net_balance > 0
                      ? 'text-positive'
                      : 'text-negative'
                }`}
              >
                {formatLKRSigned(selected.net_balance)}
              </span>
              <span className="hint">
                {Math.abs(selected.net_balance) < 0.01
                  ? 'You are all square'
                  : selected.net_balance > 0
                    ? `${selected.friend.display_name} owes you`
                    : `You owe ${selected.friend.display_name}`}
              </span>
            </div>

            {Math.abs(selected.net_balance) >= 0.01 && settleablePart && (
              <button
                type="button"
                className="btn btn-primary btn-block btn-lg"
                onClick={() => {
                  setSettleTarget(settleOptions[0] ?? null);
                  setSettleChoices(settleOptions);
                  setSelected(null);
                }}
              >
                <HandCoins size={17} />
                {settleablePart.net > 0
                  ? `Record ${formatLKR(Math.abs(settleablePart.net))} received`
                  : `Settle ${formatLKR(Math.abs(settleablePart.net))}`}
              </button>
            )}

            <button
              type="button"
              className={`btn btn-block ${
                Math.abs(selected.net_balance) >= 0.01 && settleablePart ? 'btn-secondary' : 'btn-primary'
              }`}
              onClick={() => openLend(selected.friend)}
            >
              <HandCoins size={16} /> Add expense or loan
            </button>

            {selected.perGroup.length === 0 ? (
              <EmptyState
                icon="✅"
                title="All square"
                text="Nothing is owed either way. Whatever you have recorded together is still listed below."
              />
            ) : (
              <>
                <span className="label label-block">Breakdown by group</span>
                <div className="stack-sm">
                  {selected.perGroup.map((entry) => (
                    // The group name gets the full width; the figure and the
                    // button sit underneath. Side by side, all three fought over
                    // a 390px row and the name lost — "Boarding …".
                    <div key={entry.groupId} className="card">
                      <span style={{ minWidth: 0 }}>
                        <span className="truncate" style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>
                          {/* Inside this friend's own sheet the pair group's name
                              ("Between you and X") just repeats the heading. */}
                          {directGroupIds.has(entry.groupId) ? 'Money lent directly' : entry.groupName}
                        </span>
                        <span className="hint">{entry.net > 0 ? 'owes you' : 'you owe'}</span>
                      </span>
                      <span
                        className="row-between"
                        style={{ gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}
                      >
                        <span
                          className={`amount-md tabular ${entry.net > 0 ? 'text-positive' : 'text-negative'}`}
                        >
                          {formatLKR(Math.abs(entry.net))}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <span className="hint">
                  Settlements are recorded against a group so the group ledger stays balanced.
                </span>
              </>
            )}

            <span className="label label-block">
              Records between you{pairRecords.length > 0 ? ` (${pairRecords.length})` : ''}
            </span>
            {pairLoading ? (
              <SkeletonRows count={3} height={58} />
            ) : pairRecords.length === 0 ? (
              <EmptyState
                icon="🧾"
                title="Nothing recorded yet"
                text="Loans, shared bills and anything you have split in a group together will be listed here."
              />
            ) : (
              <>
                <div className="stack-sm">
                  {pairRecords.map((record) => {
                    const entry = record.expense;
                    const iPaidIt = entry.paid_by === user.id;
                    const locked = Boolean(entry.settled_at);
                    const meta = categoryMeta(entry.category);
                    // Same rule the server enforces: the person who added it, or
                    // an admin of the group it lives in. Showing the buttons to
                    // anyone else only produces a refusal.
                    const myRole = (membersByGroup[record.groupId] ?? []).find(
                      (m) => m.user_id === user.id
                    )?.role;
                    const canEdit = entry.created_by === user.id || myRole === 'ADMIN';
                    return (
                      // Amount on the title line and the buttons on the last one,
                      // rather than all three competing for the right-hand edge:
                      // on a phone that squeezed the title down to a few letters
                      // and wrapped the date onto three lines.
                      <div key={entry.id} className="card row" style={{ alignItems: 'flex-start' }}>
                        <span
                          className="icon-tile"
                          style={{ width: 34, height: 34, fontSize: 15, flexShrink: 0 }}
                        >
                          {record.isDirect ? '🤝' : meta.emoji}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="row-between" style={{ gap: 'var(--sp-2)' }}>
                            <span className="row" style={{ gap: 5, minWidth: 0 }}>
                              <span className="truncate" style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                                {entry.title}
                              </span>
                              {locked && <span className="badge">Settled</span>}
                            </span>
                            <span className="amount-md tabular" style={{ flexShrink: 0 }}>
                              {formatLKR(entry.amount)}
                            </span>
                          </span>
                          <span className="hint" style={{ display: 'block' }}>
                            {friendlyDate(entry.created_at.slice(0, 10))} ·{' '}
                            {iPaidIt ? 'you paid' : `${selected.friend.display_name} paid`}
                            {!record.isDirect && record.groupName ? ` · ${record.groupName}` : ''}
                          </span>
                          {/* The totals people actually argue about: not what the
                              bill came to, but what each of you carried of it. */}
                          <span className="row-between" style={{ gap: 'var(--sp-2)' }}>
                            <span className="hint truncate">
                              your share {formatLKR(record.myShare)} · theirs {formatLKR(record.theirShare)}
                            </span>
                        {!locked && canEdit && (
                          <span className="row" style={{ gap: 4, flexShrink: 0 }}>
                            <button
                              type="button"
                              className="btn-icon"
                              style={{ width: 30, height: 30 }}
                              onClick={() =>
                                record.isDirect
                                  ? openEditEntry(entry, selected.friend)
                                  : setEditingGroupExpense(entry)
                              }
                              aria-label={`Edit ${entry.title}`}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn-icon"
                              style={{ width: 30, height: 30 }}
                              onClick={() => handleDeleteEntry(entry)}
                              disabled={busyEntry === entry.id}
                              aria-label={`Delete ${entry.title}`}
                            >
                              {busyEntry === entry.id ? <Spinner /> : <Trash2 size={13} />}
                            </button>
                          </span>
                        )}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <span className="hint">
                  Settled records are locked, so a paid-up balance cannot reopen. Add a new record to
                  correct one after settling.
                </span>
              </>
            )}

            {directGroupByFriend[selected.friend.id] && (
              <button
                type="button"
                className="btn btn-ghost btn-block btn-sm"
                onClick={() => handleClearDeleted(selected)}
                disabled={clearingDeleted}
              >
                {clearingDeleted ? <Spinner /> : <Eraser size={15} />} Clear deleted records
              </button>
            )}

            {selected.isConnected && (
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => handleRemoveFriend(selected)}
                disabled={removingFriend}
                style={{ color: 'var(--negative)' }}
              >
                {removingFriend ? <Spinner /> : <UserMinus size={15} />} Remove friend
              </button>
            )}

            {selectedHistory.length > 0 && (
              <>
                <span className="label label-block">Payment history</span>
                <div className="stack-sm">
                  {selectedHistory.map((payment) => {
                    const iPaid = payment.from_user === user.id;
                    return (
                      <div key={payment.id} className="card row">
                        <span className="icon-tile" style={{ width: 34, height: 34, fontSize: 15 }}>
                          {iPaid ? '↑' : '↓'}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span
                            className="truncate"
                            style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600 }}
                          >
                            {iPaid
                              ? `You paid ${selected.friend.display_name}`
                              : `${selected.friend.display_name} paid you`}
                          </span>
                          <span className="hint">
                            {friendlyDate(payment.created_at.slice(0, 10))}
                            {!directGroupIds.has(payment.group_id) && groupNames[payment.group_id]
                              ? ` · ${groupNames[payment.group_id]}`
                              : ''}
                            {payment.payment_method ? ` · ${payment.payment_method.toLowerCase()}` : ''}
                            {payment.note ? ` · ${payment.note}` : ''}
                          </span>
                        </span>
                        <span
                          className={`amount-md tabular ${iPaid ? 'text-negative' : 'text-positive'}`}
                          style={{ flexShrink: 0 }}
                        >
                          {formatLKR(payment.amount)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </Sheet>
      )}

      {/* A bill from a shared group opens the group's own editor: it has the
          whole membership and every split method, which a two-person form does
          not. Deleting is handled here; editing needs the full picture. */}
      {editingGroupExpense && membersByGroup[editingGroupExpense.group_id ?? ''] && (
        <AddExpenseModal
          groupId={editingGroupExpense.group_id as string}
          user={user}
          members={membersByGroup[editingGroupExpense.group_id as string]}
          expense={editingGroupExpense}
          onClose={() => setEditingGroupExpense(null)}
          onSaved={async () => {
            setEditingGroupExpense(null);
            await load();
            if (selected) await loadPairRecords(selected.friend.id, selected.groupIds);
          }}
        />
      )}

      {settleTarget && (
        <SettleUpSheet
          target={settleTarget}
          options={settleChoices}
          onPick={setSettleTarget}
          onClose={() => setSettleTarget(null)}
          onSettled={() => {
            setSettleTarget(null);
            setLoading(true);
            void load();
          }}
        />
      )}

      {lendTo && (
        <Sheet
          title={editingEntry ? 'Edit record' : `You and ${lendTo.display_name}`}
          onClose={() => {
            setLendTo(null);
            setEditingEntry(null);
          }}
        >
          <form onSubmit={handleLend} className="stack">
            <div className="segmented" role="group" aria-label="What happened">
              {([
                ['LENT', 'I lent'],
                ['BORROWED', 'I borrowed'],
                ['SHARED', 'Shared'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`segmented-option ${lendMode === id ? 'is-active' : ''}`}
                  onClick={() => {
                    setLendMode(id);
                    setLendError(null);
                  }}
                  aria-pressed={lendMode === id}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="hint">
              {lendMode === 'LENT'
                ? `You gave ${lendTo.display_name} money — they will owe you all of it.`
                : lendMode === 'BORROWED'
                  ? `${lendTo.display_name} gave you money — you will owe them all of it.`
                  : 'A bill the two of you shared. Split evenly unless you say otherwise.'}
            </p>

            <div className="input-prefixed">
              <span className="input-prefix">Rs.</span>
              <input
                type="text"
                inputMode="decimal"
                className="input tabular"
                placeholder="0.00"
                value={lendAmount}
                onChange={(e) => {
                  setLendAmount(e.target.value);
                  setLendError(null);
                }}
                autoFocus
                required
              />
            </div>

            <input
              type="text"
              className="input"
              placeholder="What was it for? (optional)"
              value={lendNote}
              onChange={(e) => setLendNote(e.target.value)}
              maxLength={140}
            />

            {/* Only a shared bill has a category. Lending is money moving
                between two people, not a kind of spending. */}
            {lendMode === 'SHARED' && (
              <div className="field">
                <span className="label label-block">Category</span>
                <div className="rail">
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      className={`chip ${lendCategory === cat.id ? 'is-selected' : ''}`}
                      onClick={() => setLendCategory(cat.id)}
                    >
                      {cat.emoji} {cat.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {lendMode === 'SHARED' && (
              <>
                <div className="segmented" role="group" aria-label="Who paid">
                  <button
                    type="button"
                    className={`segmented-option ${iPaid ? 'is-active' : ''}`}
                    onClick={() => setIPaid(true)}
                    aria-pressed={iPaid}
                  >
                    I paid
                  </button>
                  <button
                    type="button"
                    className={`segmented-option ${!iPaid ? 'is-active' : ''}`}
                    onClick={() => setIPaid(false)}
                    aria-pressed={!iPaid}
                  >
                    {lendTo.display_name.split(' ')[0]} paid
                  </button>
                </div>

                <div className="field">
                  <label className="label label-block" htmlFor="their-share">
                    {lendTo.display_name.split(' ')[0]}&rsquo;s share
                  </label>
                  <div className="input-prefixed">
                    <span className="input-prefix">Rs.</span>
                    <input
                      id="their-share"
                      type="text"
                      inputMode="decimal"
                      className="input tabular"
                      placeholder={
                        parseAmount(lendAmount) > 0
                          ? (roundMoney(parseAmount(lendAmount) / 2)).toFixed(2)
                          : 'Half'
                      }
                      value={theirShare}
                      onChange={(e) => {
                        setTheirShare(e.target.value);
                        setLendError(null);
                      }}
                    />
                  </div>
                  <SplitPreview
                    total={roundMoney(parseAmount(lendAmount))}
                    theirShareRaw={theirShare}
                    friendName={lendTo.display_name.split(' ')[0]}
                    iPaid={iPaid}
                  />
                </div>
              </>
            )}

            {lendError && <Alert variant="error">{lendError}</Alert>}

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={lending || !lendAmount.trim()}
            >
              {lending && <Spinner />}
              {lending ? 'Saving…' : editingEntry ? 'Save changes' : 'Record it'}
            </button>

            <span className="hint">
              Kept just between the two of you — this does not appear in any group.
            </span>
          </form>
        </Sheet>
      )}

      {showAdd && (
        <Sheet
          title="Add a friend"
          onClose={() => {
            setShowAdd(false);
            setAddError(null);
          }}
        >
          <form onSubmit={handleSendRequest} className="stack">
            <p className="text-muted" style={{ fontSize: '0.87rem' }}>
              Enter their email. If they're already on MoneyMate, they'll get a request to accept. If not,
              it'll wait and connect automatically the moment they sign up with that address.
            </p>
            <input
              type="email"
              className="input"
              placeholder="friend@email.com"
              value={addEmail}
              onChange={(e) => {
                setAddEmail(e.target.value);
                setAddError(null);
              }}
              autoFocus
              required
            />
            {addError && <Alert variant="error">{addError}</Alert>}
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={sending || !addEmail.trim()}>
              {sending && <Spinner />}
              {sending ? 'Sending…' : 'Send friend request'}
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
};

/**
 * Live read-out of how a shared bill divides, shown while typing.
 *
 * Entering one side and having to work out the other in your head is exactly
 * where an uneven split goes wrong, so the remainder is computed and displayed
 * before the record is saved — including when it does not add up.
 */
const SplitPreview: React.FC<{
  total: number;
  theirShareRaw: string;
  friendName: string;
  iPaid: boolean;
}> = ({ total, theirShareRaw, friendName, iPaid }) => {
  if (total <= 0) {
    return <span className="hint">Leave blank to split it down the middle.</span>;
  }

  const typed = theirShareRaw.trim();
  const theirs = typed ? roundMoney(parseAmount(typed)) : roundMoney(total / 2);
  const mine = roundMoney(total - theirs);
  const invalid = theirs < 0 || theirs > total;

  // What actually changes hands: their share if I paid, my share if they did.
  // This is the line that moves when you flip who paid — the shares alone do
  // not, which made the payer toggle look like it did nothing.
  const owed = iPaid ? theirs : mine;

  return (
    <div className="stack-sm" style={{ marginTop: 'var(--sp-2)' }}>
      <div className="row-between">
        <span className="hint">{friendName}&rsquo;s share</span>
        <span
          className={`tabular ${invalid ? 'text-negative' : ''}`}
          style={{ fontSize: '0.85rem', fontWeight: 700 }}
        >
          {formatLKR(theirs)}
        </span>
      </div>
      <div className="row-between">
        <span className="hint">Your share</span>
        <span
          className={`tabular ${invalid ? 'text-negative' : ''}`}
          style={{ fontSize: '0.85rem', fontWeight: 700 }}
        >
          {formatLKR(mine)}
        </span>
      </div>

      {!invalid && (
        <div
          className="row-between card-divider"
          style={{ paddingTop: 'var(--sp-2)', marginTop: 2 }}
        >
          <span className="hint">Result</span>
          <span
            className={`tabular ${owed < 0.01 ? 'text-neutral' : iPaid ? 'text-positive' : 'text-negative'}`}
            style={{ fontSize: '0.85rem', fontWeight: 700 }}
          >
            {owed < 0.01
              ? 'Nothing owed'
              : iPaid
                ? `${friendName} owes you ${formatLKR(owed)}`
                : `You owe ${friendName} ${formatLKR(owed)}`}
          </span>
        </div>
      )}

      <span className="hint">
        {invalid
          ? `That is more than the bill — ${friendName}'s share must be between Rs. 0 and ${formatLKR(total)}.`
          : typed
            ? `Adds up to ${formatLKR(total)}.`
            : 'Split down the middle. Type a number to change it.'}
      </span>
    </div>
  );
};
