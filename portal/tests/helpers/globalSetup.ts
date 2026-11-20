import { execSync } from "node:child_process";

/** Applies migrations to the test database once per run. */
export default function setup() {
  process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5432/portal_test";
  execSync("npx prisma migrate deploy", { stdio: "ignore", env: process.env });
}
