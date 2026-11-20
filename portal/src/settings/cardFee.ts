import { db } from "@/lib/db";
import { DEFAULT_FEE_SETTINGS, type FeeSettings } from "@/domain/cardFee";

/** Card-fee settings; OFF until the launch checklist is done (spec §14.3). */
export async function getFeeSettings(): Promise<FeeSettings> {
  const row = await db.setting.findUnique({ where: { key: "cardFee" } });
  return { ...DEFAULT_FEE_SETTINGS, ...((row?.value as Partial<FeeSettings> | null) ?? {}) };
}
