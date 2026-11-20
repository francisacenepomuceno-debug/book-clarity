import { execSync } from "node:child_process";

/** Applies migrations to the test database once per run. */
export default function setup() {
  process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5432/portal_test";
  process.env.DATABASE_URL_UNPOOLED ??= process.env.DATABASE_URL;
  execSync("npx prisma migrate deploy", { stdio: "ignore", env: process.env });
}
