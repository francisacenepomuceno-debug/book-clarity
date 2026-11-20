import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  BUSINESS_TZ: z.string().default("America/New_York"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
/** Validated environment. Throws with the names of missing variables. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
