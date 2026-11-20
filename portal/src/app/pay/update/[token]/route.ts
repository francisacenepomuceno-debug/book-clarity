import { startPaymentUpdate } from "@/notify/paymentLink";
import { publicMessage } from "@/app/pay/publicPage";

export const dynamic = "force-dynamic";

/** Public link from reminders: update the card or switch to a bank account on a Stripe page. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const r = await startPaymentUpdate(token, process.env.PORTAL_BASE_URL ?? new URL(req.url).origin);
  return "url" in r ? Response.redirect(r.url, 303) : publicMessage(r.error);
}
