export interface User {
  id: string;
  display_name: string;
  email: string;
  avatar_url?: string | null;
}

export interface Group {
  id: string;
  name: string;
  description?: string;
  created_by?: string;
  icon_emoji: string;
  invite_code: string;
  invite_code_expires_at: string;
  status: 'ACTIVE' | 'SETTLING' | 'SETTLED';
  current_cycle_id?: string;
  created_at: string;
  /** Set when hidden from the main list; null means active. Reversible. */
  archived_at?: string | null;
  archived_by?: string | null;
  /** Last time the group's financial history was permanently cleared. */
  purged_at?: string | null;
  /**
   * A hidden one-to-one group backing direct loans between two friends. Kept
   * out of the Groups list — it is a ledger, not somewhere you add bills.
   */
  is_direct?: boolean;
  /** Saved split arrangement, applied to each new bill. */
  default_split_method?: SplitMethod;
  /** Derived client-side. */
  my_balance?: number;
  members_count?: number;
}

export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  role: 'ADMIN' | 'MEMBER';
  joined_at: string;
  default_split_share?: number;
  include_by_default?: boolean;
  user?: User;
}

export type SplitMethod = 'EQUAL' | 'UNEQUAL' | 'PERCENTAGE' | 'SHARES' | 'ITEMIZED';

export interface Expense {
  id: string;
  group_id?: string;
  /**
   * Which run of the group this belongs to. Null until somebody starts a fresh
   * balance; after that, records from before the line carry the closed cycle
   * and drop out of the current view without being destroyed.
   */
  cycle_id?: string | null;
  title: string;
  amount: number;
  paid_by?: string;
  created_by?: string;
  on_behalf_of?: string;
  category: ExpenseCategory;
  split_method: SplitMethod;
  notes?: string;
  is_deleted: boolean;
  created_at: string;
  updated_at?: string;
  paid_by_user?: User;
  /**
   * Set when a settlement covered this bill, which freezes it. Editing it after
   * that would reverse the expense while leaving the payment in place, so a
   * settled group would silently show a debt again.
   */
  settled_at?: string | null;
  /** A record between two people that is lending rather than a shared bill. */
  is_loan?: boolean;
}

export interface ExpenseSplit {
  id: string;
  expense_id: string;
  user_id: string;
  is_included: boolean;
  amount: number;
  percentage: number;
  shares: number;
  user?: User;
}

export interface ExpenseItem {
  id: string;
  expense_id: string;
  name: string;
  amount: number;
  shared_by: string[];
}

export interface ExpenseEdit {
  id: string;
  expense_id: string;
  edited_by?: string;
  edited_at: string;
  change_summary: string;
  editor?: User;
}

export type ExpenseCategory =
  | 'FOOD'
  | 'TRANSPORT'
  | 'ACCOMMODATION'
  | 'ENTERTAINMENT'
  | 'SHOPPING'
  | 'HEALTH'
  | 'UTILITIES'
  | 'OTHER';

export interface GroupSettlement {
  id: string;
  group_id: string;
  cycle_id: string;
  from_user: string;
  to_user: string;
  amount: number;
  note?: string;
  payment_method: string;
  is_confirmed: boolean;
  confirmed_at?: string;
  created_at: string;
  payer?: User;
  payee?: User;
}

export type SocialStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

export interface GroupInvitation {
  id: string;
  group_id: string;
  invited_email: string;
  invited_user_id?: string;
  invited_by?: string;
  status: SocialStatus;
  created_at: string;
  responded_at?: string;
  groups?: { name: string; icon_emoji: string };
  inviter?: User;
}

export interface FriendRequest {
  id: string;
  requester_id: string;
  addressee_id?: string;
  addressee_email: string;
  status: SocialStatus;
  created_at: string;
  responded_at?: string;
  requester?: User;
  addressee?: User;
}

export interface DebtSimplification {
  from: User;
  to: User;
  amount: number;
}

export interface FriendBalance {
  friend: User;
  net_balance: number;
  total_they_owe_me: number;
  total_i_owe_them: number;
  shared_group_count: number;
}

/** Shape returned by the find_group_by_invite_code RPC. */
export interface InviteLookup {
  group_id: string;
  name: string;
  description: string;
  icon_emoji: string;
  member_count: number;
  is_expired: boolean;
  already_member: boolean;
  has_pending_request: boolean;
}
