/** Percentage of an integer cent amount, in basis points (300 = 3%), rounded half-up. Integer math only. */
export function percentOfCents(cents: number, basisPoints: number): number {
  return Math.floor((cents * basisPoints + 5000) / 10000);
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
