import { requirePermission } from "@/auth/permissions";
import { db } from "@/lib/db";
import { getOnboardingSettings } from "@/settings/onboarding";
import { PortalHeader } from "@/app/PortalHeader";
import { OnboardingSettingsForm } from "./Form";

export const dynamic = "force-dynamic";

export default async function OnboardingSettingsPage() {
  const viewer = await requirePermission("ace.manage");
  const [s, owners] = await Promise.all([getOnboardingSettings(), db.user.findMany({ where: { role: { in: ["OWNER", "SUPER_ADMIN"] } }, orderBy: { createdAt: "asc" } })]);
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/onboarding">← Onboarding</a></p>
        <h2>Onboarding settings</h2>
        <section className="panel pad">
          <OnboardingSettingsForm settings={s} owners={owners.map((o) => ({ id: o.id, name: o.name }))} />
        </section>
      </main>
    </>
  );
}
