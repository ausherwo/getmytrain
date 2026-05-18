// Shared bridge to Rail Data Marketplace's "Live Arrival and Departure
// Boards" (LDBWS) product. Used by both:
//
//   /api/departures        — single 2-hour window (the default rider view)
//   /api/departures/day    — full-day stitch (multiple windows, View all)
//
// Pulled out so the route handlers stay route-specific (request parsing,
// response shaping) and the upstream call lives in exactly one place.
//
// Contracts
// =========
// The `Departure` type below must stay in sync with `Departure` in the
// Expo app at App/src/types/index.ts. The BFF and the app talk to each
// other through this shape; drift is a runtime bug.

const LDBWS_BASE =
  "https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards-arr-and-dep1_1";

/**
 * Output shape returned to the Expo app. Mirrors
 * App/src/types/index.ts:Departure.
 */
export type Departure = {
  /** Scheduled departure time at the origin (HH:MM, 24h). */
  scheduled: string;
  /** Live expected departure at the origin (HH:MM, 24h). Equal to
   *  scheduled when on time. */
  expected: string;
  /** Live expected arrival at the DESTINATION (HH:MM, 24h). Sourced
   *  directly from the destination calling point's `et` with `st` as
   *  fallback. Reflects mid-journey delay accumulation, unlike a
   *  client-side `expected + duration` computation. */
  expectedArrival: string;
  status: "on_time" | "delayed" | "cancelled";
  delayMinutes: number;
  platform?: string;
  platformConfidence: "confirmed" | "likely" | "unknown";
  platformConfidencePercent: number;
  originCrs: string;
  destinationCrs: string;
  serviceId: string;
  /** Scheduled origin→destination duration in minutes. Timetable
   *  promise, not the live expectation. */
  durationMinutes: number;
  /** Intermediate calling points between origin and destination,
   *  exclusive of both. A direct service that calls nowhere else
   *  returns 0; UK rail parlance distinguishes "direct" (no change of
   *  train) from "stops" (intermediate stations), so a direct train can
   *  still have many stops. */
  stopCount: number;
  /** Free-text reason a service is cancelled, when LDBWS supplies it.
   *  e.g. "Late arrival of incoming train", "Operational incident". */
  cancelReason?: string;
  /** Free-text reason a service is running late, when LDBWS supplies
   *  it. Same shape as cancelReason but for delayed services. */
  delayReason?: string;
  /** Per-service ad-hoc alerts from the TOC. Short human-readable
   *  strings like "Reduced seating today" or "Will not call at
   *  Wimbledon today". Empty array when there are none. */
  adhocAlerts: string[];
  onTimePercent30d: number;
  recent14Days: never[];
};

/** Thrown when LDBWS rejects the request or returns an HTTP error.
 *  Route handlers catch this to log + return 502 to the client. */
export class LdbwsError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "LdbwsError";
  }
}

/**
 * Fetch one LDBWS window (up to 120 minutes from now+timeOffset) and
 * reshape it into Departure[].
 *
 * @param from              Origin CRS, e.g. "DKG"
 * @param to                Destination CRS, e.g. "WAT"
 * @param apiKey            RDM consumer key (x-apikey header)
 * @param numRows           Max services to return for this window (1..50)
 * @param timeOffsetMinutes Where the 120-min window starts relative to
 *                          "now". 0 = window covers now..now+120min.
 *                          Used by the day endpoint to stitch multiple
 *                          windows together across operating hours.
 */
export async function fetchWindow(
  from: string,
  to: string,
  apiKey: string,
  numRows: number,
  timeOffsetMinutes = 0,
): Promise<Departure[]> {
  // GetArrDepBoardWithDetails — combined arrivals + departures with
  // calling-point details. We use this rather than the departures-only
  // variant because our RDM subscription only exposes the combined
  // endpoint. filterCrs+filterType=to narrows the result to services
  // going to the destination.
  const url =
    `${LDBWS_BASE}/LDBWS/api/20220120/GetArrDepBoardWithDetails/${from}` +
    `?filterCrs=${to}&filterType=to&numRows=${numRows}` +
    `&timeWindow=120&timeOffset=${timeOffsetMinutes}`;

  const res = await fetch(url, {
    headers: {
      "x-apikey": apiKey,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LdbwsError(res.status, text.slice(0, 200));
  }
  const upstream = (await res.json()) as unknown;

  const trainServices = getArray(upstream, "trainServices");
  return trainServices
    .map((s) => reshapeService(s, from, to))
    .filter((d): d is Departure => d !== null);
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

  // Reason fields — LDBWS supplies these as free-text sentences from the
  // TOC's CIS. We pass them through verbatim; they're typically short
  // (~6-12 words, e.g. "Late arrival of incoming train"). Only included
  // in the returned shape when actually present — undefined otherwise so
  // the UI can conditionally render rather than checking for empty strings.
  const cancelReason = pickString(s, "cancelReason")?.trim() || undefined;
  const delayReason = pickString(s, "delayReason")?.trim() || undefined;

  // Per-service ad-hoc alerts: short strings published by the TOC for
  // service-specific gotchas ("Will not call at Wimbledon today",
  // "Reduced seating"). LDBWS returns this as an array of strings —
  // we filter out blanks but otherwise pass through unchanged.
  const adhocAlertsRaw = getArray(s, "adhocAlerts");
  const adhocAlerts = adhocAlertsRaw
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  // Find the destination calling point in subsequentCallingPoints.
  // The field is an array of arrays — one inner array per portion of
  // the train (e.g. a train that splits at a junction has two). We
  // take the first portion that contains toCrs.
  //
  // From the destination point we derive three things:
  //   - durationMinutes:   scheduled origin → scheduled dest (timetable)
  //   - expectedArrival:   live destination ETA, falls back to scheduled
  //                        if the destination point hasn't been issued
  //                        an estimate yet.
  //   - stopCount:         idx of destination in callingPoint = number
  //                        of intermediate stops between origin and
  //                        destination, exclusive of both.
  let durationMinutes = 0;
  let expectedArrival = expected; // sentinel: same as origin's expected
  let stopCount = 0;

  const groups = getArray(s, "subsequentCallingPoints");
  for (const group of groups) {
    const points = getArray(group, "callingPoint");
    const idx = points.findIndex((p) => isObject(p) && p.crs === toCrs);
    if (idx < 0) continue;

    const dest = points[idx] as Record<string, unknown>;
    const destSt = pickString(dest, "st");
    const destEt = pickString(dest, "et");

    if (destSt && /^\d{2}:\d{2}$/.test(destSt)) {
      durationMinutes = diffMinutes(std, destSt);
    }

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
    cancelReason,
    delayReason,
    adhocAlerts,
    onTimePercent30d: 0,
    recent14Days: [],
  };
}

/* --------------------------------- helpers -------------------------------- */

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
