import { ExpenseCategory } from '../types';
import type { ResolvedTheme } from './theme';

export interface CategoryMeta {
  id: ExpenseCategory;
  name: string;
  emoji: string;
  /** Fixed categorical slot — assigned by position, never by rank or value. */
  color: Record<ResolvedTheme, string>;
}

/**
 * Two selected palettes, not one palette auto-flipped: each is stepped for its
 * own surface and validated there (light on #FFFFFF, dark on #1C1C33). Every
 * adjacent pair clears the colour-vision-deficiency separation floor.
 *
 * The previous ad-hoc set failed four of five checks — its HEALTH green and
 * SHOPPING red were ΔE 2.5 apart under deuteranopia, i.e. the same colour to a
 * red-green colourblind reader.
 *
 * Three light slots sit just under 3:1 contrast on white; that is allowed only
 * because every chart row carries a visible emoji + name + value label, so
 * identity never rests on colour alone. Keep those labels if you touch the
 * breakdown. Order is fixed — do not sort or recycle these.
 */
export const CATEGORIES: CategoryMeta[] = [
  { id: 'FOOD',          name: 'Food & Drinks', emoji: '🍔', color: { light: '#2a78d6', dark: '#3987e5' } },
  { id: 'TRANSPORT',     name: 'Transport',     emoji: '🚗', color: { light: '#eb6834', dark: '#d95926' } },
  { id: 'ACCOMMODATION', name: 'Accommodation', emoji: '🏠', color: { light: '#1baf7a', dark: '#199e70' } },
  { id: 'ENTERTAINMENT', name: 'Entertainment', emoji: '🎉', color: { light: '#eda100', dark: '#c98500' } },
  { id: 'SHOPPING',      name: 'Shopping',      emoji: '🛍️', color: { light: '#e87ba4', dark: '#d55181' } },
  { id: 'HEALTH',        name: 'Health',        emoji: '💊', color: { light: '#008300', dark: '#008300' } },
  { id: 'UTILITIES',     name: 'Utilities',     emoji: '💡', color: { light: '#4a3aa7', dark: '#9085e9' } },
  { id: 'OTHER',         name: 'Other',         emoji: '📌', color: { light: '#e34948', dark: '#e66767' } },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const categoryMeta = (id?: string): CategoryMeta =>
  BY_ID.get((id || 'OTHER') as ExpenseCategory) || CATEGORIES[CATEGORIES.length - 1];

export const categoryColor = (id: string | undefined, theme: ResolvedTheme): string =>
  categoryMeta(id).color[theme];
