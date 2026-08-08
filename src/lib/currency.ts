/** Sri Lankan rupee formatting and exact money arithmetic. */

export const formatLKR = (amount: number): string => {
  const formatted = Math.abs(amount).toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
};

export const formatLKRSigned = (amount: number): string => {
  if (amount > 0.005) return `+${formatLKR(amount)}`;
  if (amount < -0.005) return `-${formatLKR(amount)}`;
  return 'Rs. 0.00';
};

/** Axis ticks and stat tiles: 12,900 -> "12.9K", 5,000 -> "5K". */
export const formatCompact = (amount: number): string => {
  const abs = Math.abs(amount);
  // Drop a trailing ".0" so an axis does not read "5.0K" beside "10K".
  const trim = (value: string) => value.replace(/\.0$/, '');

  if (abs >= 1_000_000) return `${trim((amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1))}M`;
  if (abs >= 1_000) return `${trim((amount / 1_000).toFixed(abs >= 10_000 ? 0 : 1))}K`;
  return String(Math.round(amount));
};

/** Parses user input, tolerating grouping separators and stray currency text. */
export const parseAmount = (input: string): number => {
  const cleaned = input.replace(/[^0-9.-]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
};

export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => cents / 100;

/** Rounds to whole cents, killing accumulated float noise (0.1 + 0.2 etc). */
export const roundMoney = (amount: number): number => fromCents(toCents(amount));

/**
 * Splits `total` across `weights` so the parts sum back to EXACTLY `total`.
 *
 * Plain `total / n` leaves a remainder — Rs. 100 across 3 people is
 * 33.333… each, which stores as 33.33 and loses a cent, so the ledger stops
 * netting to zero and balances drift. This distributes the leftover cents to
 * the largest fractional parts (largest-remainder method).
 */
export const allocate = (total: number, weights: number[]): number[] => {
  if (weights.length === 0) return [];

  const totalCents = toCents(total);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const floored = exact.map((v) => Math.floor(v));
  const distributed = floored.reduce((sum, v) => sum + v, 0);
  let remainder = totalCents - distributed;

  // Hand out the leftover cents, biggest fractional part first.
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const result = [...floored];
  let cursor = 0;
  while (remainder > 0 && byFraction.length > 0) {
    result[byFraction[cursor % byFraction.length].index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return result.map(fromCents);
};

/** Equal split with the remainder distributed rather than dropped. */
export const splitEvenly = (total: number, count: number): number[] =>
  allocate(total, new Array(count).fill(1));
