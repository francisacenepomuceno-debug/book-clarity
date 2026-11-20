import { headers } from "next/headers";
import { db } from "@/lib/db";
import { SetupForm } from "./SetupForm";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const done = (await db.user.count()) > 0;
  const h = await headers();
  const loginUrl = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}/login`;
  return (
    <main className="auth">
      <div className="card wide">
        <h1>Set up the portal</h1>
        {done ? <p>The portal is already set up. <a href="/login">Sign in</a>.</p> : <SetupForm loginUrl={loginUrl} />}
      </div>
    </main>
  );
}
