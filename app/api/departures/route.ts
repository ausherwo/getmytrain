// /api/departures — bridge between the GetMyTrain app and Rail Data
// Marketplace's "Live Arrival and Departure Boards" (LDBWS) product.
//
// Accepts a from/to CRS pair, asks LDBWS for live departures *from*
// `from` filtered to services calling at `to`, then reshapes the
// upstream response into the Departure[] shape the Expo app expects.
//
// Auth: an `x-apikey` header sourced from the RDM_API_KEY environment
// variable. Set it in `.env.local` for local dev and in the Vercel
// project's environment variables for production. The key never
// appears in code.
//
// CORS: this endpoint is hosted at api.getmytrain.co.uk and called
// from the PWA at app.getmytrain.co.uk — different origins, so the
// browser requires CORS headers on the response. The endpoint serves
// read-only public train data with no auth, so a permissive
// Access-Control-Allow-Origin: * is fine. An OPTIONS preflight
// handler is also exported for completeness (most browsers won't
// send a preflight for a simple GET, but a few will).
//
// Caching: explicitly disabled (`cache: 'no-store'`) because
// departures change every minute — caching would surface stale
// information. We'll layer a short Vercel edge cache (~30s) later
// when traffic grows.
//
// Upstream spec — Swagger lives in the RDM product page under the
// Specification tab. The key endpoint we use:
//   GET /LDBWS/api/20220120/GetArrDepBoardWithDetails/{crs}
//   query params: filterCrs, filterType, numRows
//   response: StationBoardWithDetails (see swagger for schema)
//
// We use the combined Arrival+Departure variant rather than the
// departure-only one because our RDM product subscription only
// exposes the combined endpoint. `filterType=to` already narrows the
// result to departures heading to the target station, so the "Arr"
// half of the combined endpoint is effectively a no-op for us.

import { NextRequest, NextResponse } from "next/server";

/** Headers attached to every response so the PWA (different origin)
 *  can read the body. Read-only public data, no auth — permissive
 *  origin is fine. */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** Preflight handler. A simple GET with only an Accept header doesn't
 *  trigger preflight, but Safari has been known to send OPTIONS in
 *  edge cases (e.g. service-worker-intercepted fetches). Cheap insurance. */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const LDBWS_BASE =
  "https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards-arr-and-dep1_1";

/**
 * Output shape — must stay in sync with the Expo app's `Departure`
 * type in `App/src/types/index.ts`. If that type changes, mirror the
 * change here so the BFF and the app agree.
 */
type Departure = {
  scheduled: string; // HH:MM, 24-hour
  expected: string; // HH:MM, 24-hour — at the ORIGIN station
  /** Expected arrival time at the DESTINATION, HH:MM 24-hour. Sourced
   *  from the destination calling point's `et` (estimated) with `st`
   *  (scheduled) as fallback. Reflects mid-journey delay accumulation
   *  so the rider sees "actually arrives 09:46" rather than the app
   *  computing departExpected + scheduledDuration (which silently
   *  ignores delays incurred between origin and destination). */
  expectedArrival: string;
  status: "on_time" | "delayed" | "cancelled";
  delayMinutes: number;
  platform?: string;
  platformConfidence: "confirmed" | "likely" | "unknown";
  platformConfidencePercent: number;
  originCrs: string;
  destinationCrs: string;
  serviceId: string;
  /** Scheduled journey duration in minutes — origin std → destination st.
   *  This is the timetable promise, not the live expectation. The live
   *  arrival is in expectedArrival. */
  durationMinutes: number;
  /** Intermediate stops between origin and destination, exclusive of
   *  both. A direct service that calls nowhere else returns 0; a 13-
   *  calling-point service ending at the destination returns 12. UK rail
   *  parlance distinguishes "direct" (no change of train) from "stops",
   *  so a direct train can still have many stops. */
  stopCount: number;
  /** Historic Service Performance (HSP) — a separate RDM product
   *  we haven't wired yet. Left 0 so the app's reliability block
   *  stays hidden until we add it. */
  onTimePercent30d: number;
  /** Same as above — empty until HSP is wired. */
  recent14Days: never[];
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from")?.toUpperCase().trim();
  const to = url.searchParams.get("to")?.toUpperCase().trim();
  // numRows controls the size of the station-board fetch BEFORE the
  // filterCrs/filterType narrows results to services going to `to`.
  // For low-frequency stations like Dorking (hourly direct to WAT,
  // but multiple southbound services per hour mixed in on the same
  // board), asking for 8 rows might leave only 2-3 Waterloo-bound
  // departures after filtering. 20 (LDBWS's hard limit) gives the
  // app's 8-slot list enough headroom on low-frequency routes while
  // costing nothing on busy ones.
  const max = clamp(
    Number(url.searchParams.get("max")) || 20,
    1,
    20,
  );

  // ---- validate the request shape -----------------------------------------
  if (!from || !/^[A-Z]{3}$/.test(from)) {
    return jsonError(400, "`from` must be a 3-letter CRS code (e.g. SUR).");
  }
  if (!to || !/^[A-Z]{3}$/.test(to)) {
    return jsonError(400, "`to` must be a 3-letter CRS code (e.g. WAT).");
  }
  if (from === to) {
    return jsonError(400, "`from` and `to` must be different stations.");
  }

  // ---- read the API key from the env --------------------------------------
  const apiKey = process.env.RDM_API_KEY;
  if (!apiKey) {
    // Logged so a misconfigured deployment is visible in Vercel logs.
    // We don't leak the absence to the client beyond a generic message.
    console.error("[/api/departures] RDM_API_KEY env var not set");
    return jsonError(500, "Server configuration error.");
  }

  // ---- call LDBWS ---------------------------------------------------------
  // GetArrDepBoardWithDetails — combined arrivals + departures with
  // calling-point details. We need the details version so the response
  // includes subsequentCallingPoints (which we use for duration + stop
  // count). filterType=to narrows the result to departures-going-to.
  const ldbwsUrl =
    `${LDBWS_BASE}/LDBWS/api/20220120/GetArrDepBoardWithDetails/${from}` +
    `?filterCrs=${to}&filterType=to&numRows=${max}`;

  let upstream: unknown;
  try {
    const res = await fetch(ldbwsUrl, {
      headers: {
        "x-apikey": apiKey,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        "[/api/departures] LDBWS HTTP",
        res.status,
        text.slice(0, 200),
      );
      return jsonError(502, "Upstream error from rail data feed.");
    }
    upstream = await res.json();
  } catch (err) {
    console.error("[/api/departures] LDBWS fetch failed", err);
    return jsonError(502, "Couldn't reach the rail data feed.");
  }

  // ---- reshape ------------------------------------------------------------
  const trainServices = getArray(upstream, "trainServices");
  const departures: Departure[] = trainServices
    .map((s) => reshapeService(s, from, to))
    .filter((d): d is Departure => d !== null);

  return jsonOk({ ok: true, departures });
}

/* --------------------------- reshape one service -------------------------- */

function reshapeService(
  s: unknown,
  fromCrs: string,
  toCrs: string,
): Departure | null {
  if (!isObject(s)) return null;
  const serviceID = pickString(s, "serviceID");
  const std = pickString(s, "std");
  if (!serviceID || !std) return null;

  const etdRaw = pickString(s, "etd") ?? "On time";
  const isCancelled = s.isCancelled === true || etdRaw === "Cancelled";

  let status: Departure["status"];
  let expected: string;
  let delayMinutes: number;

  if (isCancelled) {
    status = "cancelled";
    expected = std;
    delayMinutes = 0;
  } else if (etdRaw === "On time" || etdRaw === std) {
    status = "on_time";
    expected = std;
    delayMinutes = 0;
  } else if (/^\d{2}:\d{2}$/.test(etdRaw)) {
    // etd is a clock time — late or running ahead by however much.
    const diff = diffMinutes(std, etdRaw);
    expected = etdRaw;
    delayMinutes = Math.max(0, diff);
    status = delayMinutes > 0 ? "delayed" : "on_time";
  } else {
    // "Delayed", "Starts here", anything else — assume delayed,
    // unknown magnitude.
    status = "delayed";
    expected = std;
    delayMinutes = 0;
  }

  const platform = pickString(s, "platform");

  // Find the destination calling point in subsequentCallingPoints.
  // The field is an array of arrays — one inner array per portion of
  // the train (e.g. a train that splits at a junction has two). We
  // take the first portion that contains toCrs.
  //
  // From the destination point we derive three things:
  //   - durationMinutes:   scheduled origin → scheduled dest (timetable)
  //   - expectedArrival:   live destination ETA, falls back to scheduled
  //                        if the destination point hasn't been issued
  //                        an estimate yet (common on early-in-journey
  //                        services). Critical: takes destination `et`
  //                        directly rather than computing origin
  //                        expected + duration, because delays absorbed
  //                        or accumulated mid-journey only show up in
  //                        the destination's `et`.
  //   - stopCount:         idx of destination in callingPoint = number
  //                        of intermediate stops between origin and
  //                        destination, exclusive of both. (idx 0 means
  //                        destination is the next stop = no
  //                        intermediate stations.)
  let durationMinutes = 0;
  let expectedArrival = expected; // sentinel: same as origin's expected
  let stopCount = 0;

  const groups = getArray(s, "subsequentCallingPoints");
  for (const group of groups) {
    const points = getArray(group, "callingPoint");
    const idx = points.findIndex(
      (p) => isObject(p) && p.crs === toCrs,
    );
    if (idx < 0) continue;

    const dest = points[idx] as Record<string, unknown>;
    const destSt = pickString(dest, "st");
    const destEt = pickString(dest, "et");

    // Scheduled duration uses `st` only — never `et`, since duration
    // is by definition the timetable distance from std→st.
    if (destSt && /^\d{2}:\d{2}$/.test(destSt)) {
      durationMinutes = diffMinutes(std, destSt);
    }

    // Expected arrival: prefer `et` if it's a real time. "On time" /
    // "No report" / "Delayed" et values mean the upstream hasn't
    // issued an estimate yet at the destination, so we fall back to
    // the scheduled arrival.
    if (destEt && /^\d{2}:\d{2}$/.test(destEt)) {
      expectedArrival = destEt;
    } else if (destSt && /^\d{2}:\d{2}$/.test(destSt)) {
      expectedArrival = destSt;
    }

    // For cancelled services there is no real arrival — keep the
    // scheduled time so the UI has something to show alongside the
    // cancelled badge, rather than a falsified ETA.
    if (isCancelled && destSt && /^\d{2}:\d{2}$/.test(destSt)) {
      expectedArrival = destSt;
    }

    stopCount = idx;
    break;
  }

  return {
    scheduled: std,
    expected,
    expectedArrival,
    status,
    delayMinutes,
    platform: platform || undefined,
    platformConfidence: platform ? "confirmed" : "unknown",
    platformConfidencePercent: platform ? 100 : 0,
    originCrs: fromCrs,
    destinationCrs: toCrs,
    serviceId: serviceID,
    durationMinutes,
    stopCount,
    onTimePercent30d: 0,
    recent14Days: [],
  };
}

/* --------------------------------- helpers -------------------------------- */

/** Success response wrapper — adds CORS headers so the cross-origin
 *  PWA can read the body. */
function jsonOk(body: unknown) {
  return NextResponse.json(body, { headers: CORS_HEADERS });
}

function jsonError(status: number, error: string) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: CORS_HEADERS },
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function pickString(o: unknown, key: string): string | undefined {
  if (!isObject(o)) return undefined;
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function getArray(o: unknown, key?: string): unknown[] {
  if (!key) {
    return Array.isArray(o) ? o : [];
  }
  if (!isObject(o)) return [];
  const v = o[key];
  return Array.isArray(v) ? v : [];
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function diffMinutes(fromHHMM: string, toHHMM: string): number {
  const a = hhmmToMinutes(fromHHMM);
  const b = hhmmToMinutes(toHHMM);
  let d = b - a;
  if (d < 0) d += 24 * 60; // crossed midnight
  return d;
}
