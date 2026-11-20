import { db } from "@/lib/db";

/** Empties every table between tests. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE "AuditLog","Discount","Invoice","Client","Package","StripeEvent","Setting","User" RESTART IDENTITY CASCADE',
  );
}
