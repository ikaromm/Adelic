export function discount(subtotal, percentage) {
  if (subtotal < 0) return 0;
  const rate = Math.min(percentage, 25);
  return subtotal - (subtotal * rate) / 100;
}
