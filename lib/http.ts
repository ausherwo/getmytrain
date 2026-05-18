// Shared HTTP plumbing for the BFF routes.
//
// CORS headers — both /api/departures and /api/departures/day are
// called from the PWA at app.getmytrain.co.uk, which is a different
// origin. Read-only public train data with no auth, so a permissive
// Access-Control-Allow-Origin: * is fine.
//
// Response wrappers — keep the route handlers terse and ensure every
// response (success or error) carries the CORS headers consistently.

import { NextResponse } from "next/server";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** Empty 204 reply for OPTIONS preflight, with the CORS headers. */
export function corsPreflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Success JSON wrapper — adds CORS headers. */
export function jsonOk(body: unknown) {
  return NextResponse.json(body, { headers: CORS_HEADERS });
}

/** Error JSON wrapper — fixed `{ ok: false, error }` shape, CORS-aware. */
export function jsonError(status: number, error: string) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: CORS_HEADERS },
  );
}
