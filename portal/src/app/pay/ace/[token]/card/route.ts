import { startAceCardCheckout } from "@/ace/cardPay";
import { publicMessage } from "@/app/pay/publicPage";

export const dynamic = "force-dynamic";

/** ACE chose card: open a fresh Stripe page to enter the card. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const r = await startAceCardCheckout(token, process.env.PORTAL_BASE_URL ?? new URL(req.url).origin);
  return "url" in r ? Response.redirect(r.url, 303) : publicMessage(r.error);
}
