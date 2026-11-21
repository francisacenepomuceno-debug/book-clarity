import { executedContractPdf, onboardingIdFromCopyToken } from "@/onboarding/contractCopies";

/** Public: the fully signed agreement PDF, from the signed link emailed to the client and staff. */
export async function GET(_: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const id = onboardingIdFromCopyToken(token);
  const pdf = id ? await executedContractPdf(id) : null;
  if (!pdf) return new Response("This link isn't valid, or the agreement isn't fully signed yet.", { status: 404 });
  return new Response(Buffer.from(pdf.bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${pdf.filename}"`, "cache-control": "private, no-store" },
  });
}
