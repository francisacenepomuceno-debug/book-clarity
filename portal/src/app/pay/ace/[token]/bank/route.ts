import { startAceBankPayment } from "@/ace/cardPay";
import { publicMessage } from "@/app/pay/publicPage";

export const dynamic = "force-dynamic";

/** ACE chose bank transfer / ACH: go to the Stripe invoice page (no fee). */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const r = await startAceBankPayment(token);
  return "url" in r ? Response.redirect(r.url, 303) : publicMessage(r.error);
}
