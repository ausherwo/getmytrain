// /api/departures — single 2-hour window of live departures.
//
// Most-used endpoint, hit on every Trains-screen load in the app.
// Returns the next services from `from` to `to` that LDBWS knows about
// in its 120-minute look-ahead window. For low-frequency stations
// (Dorking → Waterloo, ~hourly direct) that's typically 2 services.
// The companion /api/departures/day stitches multiple 2-hour windows
// for the "View all" full-day view.
//
// CORS, response shape, and LDBWS plumbing live in /lib so this file
// stays focused on the request-validation + single-call contract.

import { NextRequest } from "next/server";

import { corsPreflight, jsonError, jsonOk } from "@/lib/http";
import { fetchWindow, LdbwsError } from "@/lib/ldbws";

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from")?.toUpperCase().trim();
  const to = url.searchParams.get("to")?.toUpperCase().trim();

  // numRows controls how many services the upstream returns. Bumped to
  // 50 (from LDBWS's earlier-perceived 20 cap) so the app's 8-slot list
  // can fill on busier routes. Note: LDBWS also enforces a 120-min time
  // window, so on hourly-direct routes you'll still see 1-2 services
  // regardless of numRows. The day endpoint handles the broader view.
  const max = clamp(Number(url.searchParams.get("max")) || 50, 1, 50);

  if (!from || !/^[A-Z]{3}$/.test(from)) {
    return jsonError(400, "`from` must be a 3-letter CRS code (e.g. SUR).");
  }
  if (!to || !/^[A-Z]{3}$/.test(to)) {
    return jsonError(400, "`to` must be a 3-letter CRS code (e.g. WAT).");
  }
  if (from === to) {
    return jsonError(400, "`from` and `to` must be different stations.");
  }

  const apiKey = process.env.RDM_API_KEY;
  if (!apiKey) {
    console.error("[/api/departures] RDM_API_KEY env var not set");
    return jsonError(500, "Server configuration error.");
  }

  try {
    const { departures, stationMessages } = await fetchWindow(
      from,
      to,
      apiKey,
      max,
    );
    return jsonOk({ ok: true, departures, stationMessages });
  } catch (err) {
    if (err instanceof LdbwsError) {
      console.error("[/api/departures] LDBWS HTTP", err.httpStatus, err.message);
      return jsonError(502, "Upstream error from rail data feed.");
    }
    console.error("[/api/departures] LDBWS fetch failed", err);
    return jsonError(502, "Couldn't reach the rail data feed.");
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
