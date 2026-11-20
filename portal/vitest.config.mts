import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/globalSetup.ts"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/portal_test",
      DATABASE_URL_UNPOOLED: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/portal_test",
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
      AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
    },
    fileParallelism: false,
  },
});
