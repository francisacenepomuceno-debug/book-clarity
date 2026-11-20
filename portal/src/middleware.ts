import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/auth/session";

/**
 * First line of defence: any page except login and the Stripe webhook needs a valid session cookie.
 * Role, 2FA and permission checks happen on the server in requirePermission().
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname === "/setup" || pathname.startsWith("/api/stripe/webhook")) return NextResponse.next();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token && (await verifySession(token))) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
