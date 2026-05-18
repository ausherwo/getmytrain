// /api/departures/day — full-day schedule by stitching multiple
// 2-hour LDBWS windows.
//
// Why this exists:
// LDBWS's GetArrDepBoardWithDetails has a hard 120-minute time window
// (timeWindow=120 is the upstream max). Asking for numRows=50 only
// returns services in that 2-hour window — for hourly-direct routes
// (e.g. Dorking → Waterloo) that's 1-2 trains regardless of numRows.
// To power the app's "View all" full-day view we make several parallel
// calls with rolling timeOffset values, then merge.
//
// Cost: one app fetch becomes 6 LDBWS calls per origin/destination
// pair. Parallel via Promise.allSettled so latency stays close to a
// single call. If a single window fails we still return what landed
// (LDBWS occasionally hiccups); only when ALL windows fail do we 502.
//
// Cache: like the single endpoint, no caching — schedules change
// minute-to-minute. Edge caching with ~30s TTL is a future enhancement.

import { NextRequest } from "next/server";

import { corsPreflight, jsonError, jsonOk } from "@/lib/http";
import { fetchWindow, LdbwsError, type Departure } from "@/lib/ldbws";

/** Two windows of 2 hours each = 4-hour total look-ahead.
 *
 *  Hard ceiling: LDBWS's `timeOffset` parameter is bounded to ±120
 *  minutes. Offsets above that get rejected or clamped, which is why
 *  the original [0, 120, 240, 360, 480, 600] design returned the same
 *  2 services regardless of how far out we tried to look. With
 *  timeOffset=120 + timeWindow=120 the latest window covers up to
 *  now+240 min, so 4 hours is the maximum forward reach this endpoint
 *  can deliver.
 *
 *  For a real full-day schedule (late evening, next-day-AM) we'd need
 *  to integrate a timetable feed — RDM's Timetable Information Service
 *  or Network Rail's SCHEDULE feed. Tracked as a separate enhancement;
 *  LDBWS by design publishes live data, not the full timetable. */
const DAY_OFFSETS_MIN = [0, 120] as const;

/** Max services per window. LDBWS allows 50; we ask for the max so a
 *  high-frequency route at peak (e.g. Surbiton → Waterloo) still gets
 *  every service inside the 2-hour band. */
const NUM_ROWS_PER_WINDOW = 50;

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from")?.toUpperCase().trim();
  const to = url.searchParams.get("to")?.toUpperCase().trim();

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
    console.error("[/api/departures/day] RDM_API_KEY env var not set");
    return jsonError(500, "Server configuration error.");
  }

  // Fire all windows in parallel. Promise.allSettled lets us keep
  // partial results when one window fails — preferable to a single
  // hiccup tanking the rider's whole-day view.
  const results = await Promise.allSettled(
    DAY_OFFSETS_MIN.map((offset) =>
      fetchWindow(from, to, apiKey, NUM_ROWS_PER_WINDOW, offset),
    ),
  );

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  if (successCount === 0) {
    const firstError = results.find((r) => r.status === "rejected");
    const reason =
      firstError && firstError.status === "rejected" ? firstError.reason : null;
    if (reason instanceof LdbwsError) {
      console.error(
        "[/api/departures/day] all windows failed; first LDBWS HTTP",
        reason.httpStatus,
        reason.message,
      );
      return jsonError(502, "Upstream error from rail data feed.");
    }
    console.error("[/api/departures/day] all windows failed", reason);
    return jsonError(502, "Couldn't reach the rail data feed.");
  }

  // Merge + dedupe by serviceId. Adjacent 2-hour windows overlap at
  // their boundaries, so the same service can appear in multiple
  // responses. First-occurrence wins: that's the earliest-offset
  // window, which carries the freshest live data for services near
  // "now". (Services 6h out hardly differ across nearby offsets.)
  const seen = new Set<string>();
  const merged: Departure[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const dep of r.value) {
      if (seen.has(dep.serviceId)) continue;
      seen.add(dep.serviceId);
      merged.push(dep);
    }
  }

  // Sort by next-occurrence wall-clock. HH:MM strings alone can't be
  // sorted lexically because of the midnight wrap (00:15 should sort
  // AFTER 23:30 when "now" is 22:00). Convert each to an absolute ms
  // value via scheduledOffsetMs and sort numerically.
  const now = Date.now();
  merged.sort(
    (a, b) =>
      scheduledOffsetMs(a.scheduled, now) -
      scheduledOffsetMs(b.scheduled, now),
  );

  return jsonOk({ ok: true, departures: merged });
}

/**
 * Convert an HH:MM service time into an absolute ms timestamp on the
 * same operating day relative to `nowMs`. Times earlier than "now"
 * (by more than a 1-minute grace) are treated as tomorrow's services —
 * the only way an HH:MM in the past makes sense in a schedule fetch.
 */
function scheduledOffsetMs(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(":").map(Number);
  const target = new Date(nowMs);
  target.setHours(h, m, 0, 0);
  if (target.getTime() < nowMs - 60_000) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}
