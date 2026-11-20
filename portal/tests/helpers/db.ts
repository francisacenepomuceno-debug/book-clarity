import { db } from "@/lib/db";

/** Empties every table between tests. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE "AceSlot","AceBatchLine","AceBatch","CommissionEntry","CommissionStatement","CommissionShare","Executive","AuditLog","Discount","Invoice","Client","Package","StripeEvent","Setting","User" RESTART IDENTITY CASCADE',
  );
}
