import { startAceCardCheckout } from "@/ace/cardPay";

export const dynamic = "force-dynamic";

/** Public link for ACE to pay a batch by card: opens a fresh Stripe page to enter the card. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const base = process.env.PORTAL_BASE_URL ?? new URL(req.url).origin;
  const r = await startAceCardCheckout(token, base);
  if ("url" in r) return Response.redirect(r.url, 303);
  const msg = r.error.replace(/[<>&]/g, "");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book Clarity</title><body style="font:16px system-ui;max-width:480px;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">Book Clarity</h1><p>${msg}</p></body>`,
    { status: 410, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
