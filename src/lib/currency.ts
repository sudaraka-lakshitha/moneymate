export const formatLKR = (amount: number): string => {
  const formatted = Math.abs(amount).toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
};

export const formatLKRSigned = (amount: number): string => {
  if (amount > 0.01) return `+Rs. ${formatLKR(amount).replace('Rs. ', '')}`;
  if (amount < -0.01) return `-Rs. ${formatLKR(-amount).replace('Rs. ', '')}`;
  return 'Rs. 0.00';
};
