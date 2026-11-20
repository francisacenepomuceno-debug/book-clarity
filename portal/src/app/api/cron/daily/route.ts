import { runDaily } from "@/notify/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily job (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await runDaily());
}
