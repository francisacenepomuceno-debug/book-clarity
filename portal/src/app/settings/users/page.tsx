import { headers } from "next/headers";
import { can, requirePermission } from "@/auth/permissions";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { NewUserForm } from "./NewUserForm";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const viewer = await requirePermission("users.manage");
  const users = await db.user.findMany({ orderBy: [{ role: "asc" }, { name: "asc" }] });
  const h = await headers();
  const loginUrl = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}/login`;
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Users</h2>
        <section className="panel pad">
          <h3>Add a user</h3>
          <p className="muted">A temporary password (and, for Owners and Super Admins, an authenticator key) is shown once.</p>
          <NewUserForm loginUrl={loginUrl} />
        </section>
        <section className="panel">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Authenticator</th><th>Added</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{u.role.replace("_", " ").toLowerCase()}</td>
                  <td>{u.role === "ADMIN" ? "not needed" : u.totpEnabled ? "in use" : "not used yet"}</td>
                  <td>{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
