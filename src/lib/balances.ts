import { FriendBalance, User } from '../types';
import { simplifyDebts } from './debtSimplifier';
import { roundMoney } from './currency';

export interface GroupLedger {
  groupId: string;
  groupName: string;
  /**
   * A hidden one-to-one group backing direct loans. It carries real balances,
   * but it is not a group the two people "share" in any sense they would
   * recognise, so it must not be counted or named as one.
   */
  isDirect?: boolean;
  /** userId -> net position in this group (positive = is owed). */
  balances: Record<string, number>;
  members: Record<string, User>;
}

/** Per-group split of a friend balance, so settling knows which group to post to. */
export interface FriendGroupBalance {
  groupId: string;
  groupName: string;
  /** Positive: they owe you. Negative: you owe them. */
  net: number;
}

export interface FriendBalanceDetail extends FriendBalance {
  perGroup: FriendGroupBalance[];
  /**
   * Every group you are both in, direct pair records included and settled ones
   * kept. perGroup drops anything that nets to zero, which is right for a
   * balance breakdown and wrong for finding the history behind it.
   */
  groupIds: string[];
}

/**
 * Nets out what each friend owes *you* specifically.
 *
 * The previous version summed each friend's own group-wide balance, which
 * answers "how is Bob doing in this group" — not "what is between Bob and me".
 * A friend who is square with you but owed money by a third member showed up as
 * owing you. This runs the same per-group debt simplification the group screen
 * shows and keeps only the edges you are part of, so the two screens agree.
 */
export const computeFriendBalances = (groups: GroupLedger[], meId: string): FriendBalanceDetail[] => {
  const accumulator = new Map<
    string,
    {
      friend: User;
      net: number;
      owedToMe: number;
      owedByMe: number;
      groups: Set<string>;
      allGroups: Set<string>;
      perGroup: Map<string, FriendGroupBalance>;
    }
  >();

  const ensure = (user: User) => {
    let entry = accumulator.get(user.id);
    if (!entry) {
      entry = {
        friend: user,
        net: 0,
        owedToMe: 0,
        owedByMe: 0,
        groups: new Set(),
        allGroups: new Set(),
        perGroup: new Map(),
      };
      accumulator.set(user.id, entry);
    }
    return entry;
  };

  const addGroupEdge = (
    entry: ReturnType<typeof ensure>,
    group: GroupLedger,
    delta: number
  ) => {
    const existing = entry.perGroup.get(group.groupId);
    if (existing) {
      existing.net = roundMoney(existing.net + delta);
    } else {
      entry.perGroup.set(group.groupId, {
        groupId: group.groupId,
        groupName: group.groupName,
        net: roundMoney(delta),
      });
    }
  };

  for (const group of groups) {
    // Everyone you share a group with is a friend, settled or not.
    for (const [userId, user] of Object.entries(group.members)) {
      if (userId === meId) continue;
      const entry = ensure(user);
      // A direct pair group still creates the friend row and carries their
      // balance, but must not count toward "N shared groups" — lending someone
      // money does not put you in a group together, and saying otherwise
      // contradicts the whole point of the direct flow.
      entry.allGroups.add(group.groupId);
      if (!group.isDirect) entry.groups.add(group.groupId);
    }

    for (const edge of simplifyDebts(group.balances, group.members)) {
      if (edge.from.id === meId && edge.to.id !== meId) {
        const entry = ensure(edge.to);
        entry.net -= edge.amount;
        entry.owedByMe += edge.amount;
        addGroupEdge(entry, group, -edge.amount);
      } else if (edge.to.id === meId && edge.from.id !== meId) {
        const entry = ensure(edge.from);
        entry.net += edge.amount;
        entry.owedToMe += edge.amount;
        addGroupEdge(entry, group, edge.amount);
      }
    }
  }

  return Array.from(accumulator.values())
    .map<FriendBalanceDetail>((entry) => ({
      friend: entry.friend,
      net_balance: roundMoney(entry.net),
      total_they_owe_me: roundMoney(entry.owedToMe),
      total_i_owe_them: roundMoney(entry.owedByMe),
      shared_group_count: entry.groups.size,
      perGroup: Array.from(entry.perGroup.values()).filter((g) => Math.abs(g.net) > 0.005),
      groupIds: Array.from(entry.allGroups),
    }))
    // Live balances first, largest magnitude at the top; settled friends after.
    .sort((a, b) => Math.abs(b.net_balance) - Math.abs(a.net_balance));
};

/** Reduces raw ledger rows to a userId -> net map. */
export const netByUser = (rows: { user_id: string; amount: number | string }[]): Record<string, number> => {
  const balances: Record<string, number> = {};
  for (const row of rows) {
    balances[row.user_id] = (balances[row.user_id] || 0) + Number(row.amount);
  }
  return balances;
};
