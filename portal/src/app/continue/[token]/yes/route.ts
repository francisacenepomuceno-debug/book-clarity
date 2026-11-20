import { answerContinuation } from "@/ace/continuation";
import { publicMessage } from "@/app/pay/publicPage";

export const dynamic = "force-dynamic";

/** The ACE client chose "Yes, continue": record it and open Stripe to save their card or bank account. */
/** POST only: email link scanners follow GET links, and must never record an answer. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const r = await answerContinuation(token, "YES", process.env.PORTAL_BASE_URL ?? new URL(req.url).origin);
  if (r.url) return Response.redirect(r.url, 303);
  return publicMessage(r.error ?? r.message ?? "", r.error ? 410 : 200);
}
