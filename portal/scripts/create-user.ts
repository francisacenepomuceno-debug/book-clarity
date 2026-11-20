/**
 * Super Admin tool: create a portal user (or reset one) and print their sign-in details ONCE.
 * Owners and Super Admins also get an authenticator (TOTP) setup key + QR link to scan.
 *
 *   npx tsx scripts/create-user.ts <email> "<Full Name>" <SUPER_ADMIN|OWNER|ADMIN>
 *
 * Hand the password and setup key to the person privately; they are not stored in readable form.
 */
import { provisionUser } from "../src/users/provision";
import type { Role } from "@prisma/client";

async function main() {
  const [email, name, role] = process.argv.slice(2);
  if (!email || !name || !role) {
    throw new Error('Usage: npx tsx scripts/create-user.ts <email> "<Full Name>" <SUPER_ADMIN|OWNER|ADMIN>');
  }
  const c = await provisionUser({ email, name, role: role as Role }, { reset: true });
  console.log(`\nUser ready: ${c.email} (${c.role})`);
  console.log(`Temporary password: ${c.password}`);
  if (c.totpSecret) {
    console.log(`Authenticator setup key: ${c.totpSecret}`);
    console.log(`Or open this link on the phone with the authenticator app: ${c.otpauthUrl}`);
  }
  console.log("Share these privately. They won't be shown again.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
