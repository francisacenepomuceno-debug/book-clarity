import { NextResponse, type NextRequest } from "next/server";

/**
 * Temporary protection for live financial data until real logins (Plan 1 Task 2).
 * HTTP basic auth, user "bookclarity", password from DASHBOARD_PASSWORD.
 * With no password configured, every request is refused.
 */
export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return new NextResponse("Dashboard is locked: DASHBOARD_PASSWORD is not set.", { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = atob(encoded).split(":");
    if (user === "bookclarity" && pass === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Book Clarity Portal"' },
  });
}

export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
