/** Minimal branded HTML response for public payment links. */
export function publicMessage(message: string, status = 410): Response {
  const msg = message.replace(/[<>&]/g, "");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book Clarity</title><body style="font:16px system-ui;max-width:480px;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">Book Clarity</h1><p>${msg}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
