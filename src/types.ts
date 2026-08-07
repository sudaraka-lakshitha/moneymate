export interface User {
  id: string;
  display_name: string;
  email: string;
  avatar_url?: string;
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
  my_balance?: number;
  members_count?: number;
  created_at: string;
}

export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  role: 'ADMIN' | 'MEMBER';
  joined_at: string;
  user?: User;
}

export interface Expense {
  id: string;
  group_id?: string;
  title: string;
  amount: number;
  paid_by?: string;
  created_by?: string;
  on_behalf_of?: string;
  category: ExpenseCategory;
  split_method: 'EQUAL' | 'UNEQUAL' | 'PERCENTAGE' | 'SHARES' | 'ITEMIZED';
  notes?: string;
  is_deleted: boolean;
  created_at: string;
  paid_by_user?: User;
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

export type ExpenseCategory =
  | 'FOOD'
  | 'TRANSPORT'
  | 'ACCOMMODATION'
  | 'ENTERTAINMENT'
  | 'SHOPPING'
  | 'HEALTH'
  | 'UTILITIES'
  | 'OTHER';

export interface DailyExpense {
  id: string;
  user_id: string;
  title: string;
  amount: number;
  category: ExpenseCategory;
  date: string;
  note?: string;
  is_deleted: boolean;
  created_at: string;
}

export interface Budget {
  id: string;
  user_id: string;
  category: ExpenseCategory;
  monthly_limit: number;
  month: string;
  spent?: number;
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
