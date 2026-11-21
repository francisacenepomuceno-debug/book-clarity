import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { executedContractPdf } from "@/onboarding/contractCopies";

/** Owners and Super Admin: download a fully signed agreement from the portal. */
export async function GET(_: Request, ctx: { params: Promise<{ onboardingId: string }> }) {
  try {
    await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw e;
  }
  const { onboardingId } = await ctx.params;
  const pdf = await executedContractPdf(onboardingId);
  if (!pdf) return new Response("This agreement isn't fully signed yet.", { status: 404 });
  return new Response(Buffer.from(pdf.bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${pdf.filename}"`, "cache-control": "private, no-store" },
  });
}
