/** Local-time date helpers. Using toISOString() directly would shift the day
 *  for anyone east or west of UTC — Sri Lanka is UTC+5:30, so "today" would
 *  flip over at 6:30pm. */

const pad = (n: number) => String(n).padStart(2, '0');

export const toISODate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const todayISO = (): string => toISODate(new Date());

/** yyyy-MM, the key the budgets table uses. */
export const monthKey = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

export const startOfMonthISO = (date: Date = new Date()): string =>
  toISODate(new Date(date.getFullYear(), date.getMonth(), 1));

export const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

/** Ascending list of the last `count` days, ending today. */
export const lastNDays = (count: number): string[] => {
  const today = new Date();
  return Array.from({ length: count }, (_, i) => toISODate(addDays(today, i - (count - 1))));
};

export const formatDayMonth = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "Today" / "Yesterday" / "12 Aug" for list grouping. */
export const friendlyDate = (iso: string): string => {
  const today = todayISO();
  const yesterday = toISODate(addDays(new Date(), -1));
  if (iso === today) return 'Today';
  if (iso === yesterday) return 'Yesterday';
  return formatDayMonth(iso);
};

export const monthLabel = (key: string): string => {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
