import { answerContinuation } from "@/ace/continuation";
import { publicMessage } from "@/app/pay/publicPage";

export const dynamic = "force-dynamic";

/** The ACE client chose "No thanks": recorded only; Book Clarity follows up and they can still say Yes. */
/** POST only: email link scanners follow GET links, and must never record an answer. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const r = await answerContinuation(token, "NO", process.env.PORTAL_BASE_URL ?? new URL(req.url).origin);
  return publicMessage(r.error ?? r.message ?? "", r.error ? 410 : 200);
}
