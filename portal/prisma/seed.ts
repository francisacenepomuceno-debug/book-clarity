/**
 * Creates (or resets the password of) the first Super Admin.
 * Usage: SEED_SUPER_ADMIN_EMAIL=... SEED_SUPER_ADMIN_PASSWORD=... npx tsx prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth/password";

async function main() {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error("Set SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD (12+ characters).");
  }
  const db = new PrismaClient();
  const passwordHash = await hashPassword(password);
  await db.user.upsert({
    where: { email },
    update: { passwordHash, role: "SUPER_ADMIN" },
    create: { email, name: "Super Admin", role: "SUPER_ADMIN", passwordHash },
  });
  await db.$disconnect();
  console.log(`Super Admin ready: ${email}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
