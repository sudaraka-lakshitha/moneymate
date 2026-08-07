import { DebtSimplification, User } from '../types';

export const simplifyDebts = (
  balances: Record<string, number>,
  userMap: Record<string, User>
): DebtSimplification[] => {
  const debtors: { userId: string; amount: number }[] = [];
  const creditors: { userId: string; amount: number }[] = [];

  for (const [userId, balance] of Object.entries(balances)) {
    if (balance < -0.01) debtors.push({ userId, amount: -balance });
    else if (balance > 0.01) creditors.push({ userId, amount: balance });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const result: DebtSimplification[] = [];

  while (debtors.length > 0 && creditors.length > 0) {
    const debtor = debtors[0];
    const creditor = creditors[0];

    const transferAmount = Math.min(debtor.amount, creditor.amount);

    if (transferAmount > 0.01) {
      const fromUser = userMap[debtor.userId] || { id: debtor.userId, display_name: 'Member', email: '' };
      const toUser = userMap[creditor.userId] || { id: creditor.userId, display_name: 'Member', email: '' };
      result.push({ from: fromUser, to: toUser, amount: transferAmount });
    }

    debtor.amount -= transferAmount;
    creditor.amount -= transferAmount;

    if (debtor.amount <= 0.01) debtors.shift();
    if (creditor.amount <= 0.01) creditors.shift();
  }

  return result;
};
