/**
 * Saves the repo contract templates (portal/contracts/*.txt) on every package that has none yet, matched by name:
 * Essentials, Growth, Enterprise, and Enterprise Custom / Custom. Edited contracts are never overwritten.
 *
 *   npx tsx scripts/load-contracts.ts
 */
import { loadDefaultContracts } from "../src/packages/contracts";

loadDefaultContracts()
  .then((names) => console.log(names.length ? `Loaded contracts for: ${names.join(", ")}` : "Every matching package already has a contract."))
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
