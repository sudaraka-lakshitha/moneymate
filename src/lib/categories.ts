import { ExpenseCategory } from '../types';

export interface CategoryMeta {
  id: ExpenseCategory;
  name: string;
  emoji: string;
  /** Fixed categorical slot — assigned by position, never by rank or value. */
  color: string;
}

/**
 * Colours come from a categorical palette validated for the dark chart surface
 * (#1C1C33): every adjacent pair clears the colour-vision-deficiency separation
 * floor and the 3:1 contrast floor. The previous ad-hoc set failed both — its
 * HEALTH green and SHOPPING red were indistinguishable to red-green colourblind
 * users. Order is fixed; do not sort or recycle these.
 */
export const CATEGORIES: CategoryMeta[] = [
  { id: 'FOOD',          name: 'Food & Drinks',  emoji: '🍔', color: '#3987e5' },
  { id: 'TRANSPORT',     name: 'Transport',      emoji: '🚗', color: '#d95926' },
  { id: 'ACCOMMODATION', name: 'Accommodation',  emoji: '🏠', color: '#199e70' },
  { id: 'ENTERTAINMENT', name: 'Entertainment',  emoji: '🎉', color: '#c98500' },
  { id: 'SHOPPING',      name: 'Shopping',       emoji: '🛍️', color: '#d55181' },
  { id: 'HEALTH',        name: 'Health',         emoji: '💊', color: '#008300' },
  { id: 'UTILITIES',     name: 'Utilities',      emoji: '💡', color: '#9085e9' },
  { id: 'OTHER',         name: 'Other',          emoji: '📌', color: '#e66767' },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const categoryMeta = (id?: string): CategoryMeta =>
  BY_ID.get((id || 'OTHER') as ExpenseCategory) || CATEGORIES[CATEGORIES.length - 1];
