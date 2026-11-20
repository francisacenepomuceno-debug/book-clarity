import { db } from "@/lib/db";

/** Empties every table between tests. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE "Onboarding","Notification","AceSlot","AceBatchLine","AceBatch","CommissionEntry","CommissionStatement","CommissionShare","Executive","AuditLog","Discount","Invoice","Client","Package","StripeEvent","Setting","User" RESTART IDENTITY CASCADE',
  );
  // Most tests exercise sending: start with client notices turned on (the real default is off until launch).
  await db.setting.create({ data: { key: "launch", value: { noticesOn: true, checks: {} } } });
}
