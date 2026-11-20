/**
 * Super Admin tool: create a portal user (or reset one) and print their sign-in details ONCE.
 * Owners and Super Admins also get an authenticator (TOTP) setup key + QR link to scan.
 *
 *   npx tsx scripts/create-user.ts <email> "<Full Name>" <SUPER_ADMIN|OWNER|ADMIN>
 *
 * Hand the password and setup key to the person privately; they are not stored in readable form.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient, type Role } from "@prisma/client";
import { hashPassword } from "../src/auth/password";
import { generateTotpSecret } from "../src/auth/totp";

async function main() {
  const [emailArg, name, roleArg] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  const role = roleArg as Role;
  if (!email || !name || !["SUPER_ADMIN", "OWNER", "ADMIN"].includes(role)) {
    throw new Error('Usage: npx tsx scripts/create-user.ts <email> "<Full Name>" <SUPER_ADMIN|OWNER|ADMIN>');
  }
  const password = randomBytes(12).toString("base64url");
  const needsTotp = role !== "ADMIN";
  const totp = needsTotp ? generateTotpSecret(email) : null;

  const db = new PrismaClient();
  const data = {
    name,
    role,
    passwordHash: await hashPassword(password),
    totpSecret: totp?.secret ?? null,
    totpEnabled: false,
    totpLastStep: null,
  };
  await db.user.upsert({ where: { email }, update: data, create: { email, ...data } });
  await db.$disconnect();

  console.log(`\nUser ready: ${email} (${role})`);
  console.log(`Temporary password: ${password}`);
  if (totp) {
    console.log(`Authenticator setup key: ${totp.secret}`);
    console.log(`Or open this link on the phone with the authenticator app: ${totp.otpauthUrl}`);
  }
  console.log("Share these privately. They won't be shown again.\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
