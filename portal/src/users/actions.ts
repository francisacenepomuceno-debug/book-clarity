"use server";

import type { Role } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { bootstrapSuperAdmin, provisionUser, type Provisioned } from "@/users/provision";

export type CreateUserState = { error?: string; created?: Provisioned };

export async function createUserAction(_: CreateUserState, form: FormData): Promise<CreateUserState> {
  let actor;
  try {
    actor = await requirePermission("users.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "You don't have permission to do that." };
    throw e;
  }
  try {
    const created = await provisionUser(
      { email: String(form.get("email") ?? ""), name: String(form.get("name") ?? ""), role: String(form.get("role") ?? "") as Role },
      { actorId: actor.id },
    );
    revalidatePath("/settings/users");
    return { created };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function setupAction(_: CreateUserState, form: FormData): Promise<CreateUserState> {
  const r = await bootstrapSuperAdmin(String(form.get("token") ?? ""), {
    email: String(form.get("email") ?? ""),
    name: String(form.get("name") ?? ""),
  });
  if (!r.ok) return { error: r.error };
  const { ok: _ok, ...created } = r;
  return { created };
}
