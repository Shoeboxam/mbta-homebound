// mbta.js
// MBTA API I/O + predictions/schedules merge + alerts counts
// ES module

export const BASE = "https://api-v3.mbta.com";

const childStopCache = new Map();

function parseIso(s) {
  return s ? new Date(s) : null;
}

function bestTimeFromAttrs(attrs) {
  return parseIso(attrs.arrival_time) || parseIso(attrs.departure_time);
}

export function csvFromSet(set) {
  return [...set].join(",");
}

export async function fetchJson(state, url, params = null) {
  const u = new URL(url);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const headers = { Accept: "application/vnd.api+json" };
  if (state?.apiKey) headers["x-api-key"] = state.apiKey;

  const res = await fetch(u.toString(), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`.trim());
  }
  return await res.json();
}

export async function fetchAll(state, path, params) {
  let url = `${BASE}${path}`;
  let p = { ...params };
  const out = [];

  while (true) {
    const payload = await fetchJson(state, url, p);
    out.push(...(payload.data || []));
    const next = payload.links && payload.links.next;
    if (!next) break;
    url = next.startsWith("/") ? `${BASE}${next}` : next;
    p = null;
  }
  return out;
}

export async function childStops(state, parentStopId) {
  if (childStopCache.has(parentStopId)) return childStopCache.get(parentStopId);

  const payload = await fetchJson(state, `${BASE}/stops/${parentStopId}`, {
    include: "child_stops",
  });

  const set = new Set();
  if (payload.data?.id) set.add(payload.data.id);
  for (const inc of payload.included || []) {
    if (inc.type === "stop" && inc.id) set.add(inc.id);
  }

  childStopCache.set(parentStopId, set);
  return set;
}

/* ---------------- Predictions helpers ---------------- */

export async function loadPredictions(state, routeCsv, stopCsv) {
  return await fetchAll(state, "/predictions", {
    "filter[route]": routeCsv,
    "filter[stop]": stopCsv,
    "page[limit]": "250",
  });
}

// Build Map<tripId, { dir, stops: {name:{t, seq, arr, dep}} }>
export function buildTripStopTimesFromPred(predData, stopSetsByName, predWindowMin = 120) {
  const out = new Map();
  const now = new Date();
  const horizon = new Date(now.getTime() + predWindowMin * 60_000);

  const inHorizon = (t) => t && t >= new Date(now.getTime() - 60_000) && t <= horizon;

  for (const p of predData) {
    const tripId = p.relationships?.trip?.data?.id;
    const stopId = p.relationships?.stop?.data?.id;
    if (!tripId || !stopId) continue;

    const a = p.attributes || {};
    const arr = parseIso(a.arrival_time);
    const dep = parseIso(a.departure_time);
    const t = arr || dep;
    if (!t || !inHorizon(t)) continue;

    const seq = Number.isFinite(a.stop_sequence) ? a.stop_sequence : null;
    const dir = Number.isFinite(a.direction_id) ? a.direction_id : null;

    let rec = out.get(tripId);
    if (!rec) {
      rec = { dir, stops: {} };
      out.set(tripId, rec);
    }
    if (rec.dir == null && dir != null) rec.dir = dir;

    for (const [name, set] of Object.entries(stopSetsByName)) {
      if (set && set.has(stopId)) {
        const prev = rec.stops[name];
        if (!prev || t < prev.t) rec.stops[name] = { t, seq, arr, dep };
      }
    }
  }

  return out;
}

// Build pairs with strict direction sanity-check.
// Returns [{tripId, fromT, toT}] sorted by fromT.
export function pairsFromTripStops(tripMap, fromName, toName) {
  const out = [];
  for (const [tripId, rec] of tripMap.entries()) {
    const a = rec.stops[fromName];
    const b = rec.stops[toName];
    if (!a || !b) continue;

    // Always enforce time order (prevents wrong-direction pairing when stop_sequence is missing)
    if (!(a.t < b.t)) continue;

    // If sequences exist, enforce those too
    if (a.seq != null && b.seq != null && a.seq >= b.seq) continue;

    out.push({ tripId, fromT: a.t, toT: b.t });
  }
  out.sort((x, y) => x.fromT - y.fromT);
  return out;
}

// Map<tripId, { depHarv, arrDisp, home? }>
export function busTripsFromPred(tripMap, includeHome) {
  const out = new Map();
  for (const [tripId, rec] of tripMap.entries()) {
    const harv = rec.stops.harv;
    if (!harv) continue;

    const depHarv = harv.dep || harv.arr || harv.t;
    const arrHarv = harv.arr || harv.dep || harv.t;

    const home = includeHome
      ? (rec.stops.home?.arr || rec.stops.home?.dep || rec.stops.home?.t || null)
      : null;

    out.set(tripId, { depHarv, arrDisp: arrHarv, home });
  }
  return out;
}

/* ---------------- Schedules loaders ---------------- */

// [{tripId, fromT(park), toT(harv)}]
export async function loadSchedulesRedPairs(state, cfg, serviceDate, parkKids, harvKids) {
  const data = await fetchAll(state, "/schedules", {
    "filter[route]": cfg.redRoute,
    "filter[stop]": `${cfg.park},${cfg.harvard}`,
    "filter[date]": serviceDate,
    "page[limit]": "450",
  });

  const trips = new Map();
  for (const item of data) {
    const tripId = item.relationships?.trip?.data?.id;
    const stopId = item.relationships?.stop?.data?.id;
    if (!tripId || !stopId) continue;

    const t = bestTimeFromAttrs(item.attributes || {});
    if (!t) continue;

    const seq = item.attributes?.stop_sequence;
    const rec = trips.get(tripId) || {};
    if (parkKids.has(stopId)) { rec.park_t = t; rec.park_seq = seq; }
    if (harvKids.has(stopId)) { rec.harv_t = t; rec.harv_seq = seq; }
    trips.set(tripId, rec);
  }

  const out = [];
  for (const [tripId, rec] of trips.entries()) {
    if (
      rec.park_t && rec.harv_t &&
      Number.isInteger(rec.park_seq) && Number.isInteger(rec.harv_seq) &&
      rec.park_seq < rec.harv_seq &&
      rec.park_t < rec.harv_t // extra safety
    ) {
      out.push({ tripId, fromT: rec.park_t, toT: rec.harv_t });
    }
  }

  out.sort((a, b) => a.fromT - b.fromT);
  return out;
}

// [{tripId, fromT(arl), toT(park)}]
export async function loadSchedulesGreenPairs(state, cfg, serviceDate, arlKids, parkKids) {
  const data = await fetchAll(state, "/schedules", {
    "filter[route]": cfg.greenRoutes.join(","),
    "filter[stop]": `${cfg.arlington},${cfg.park}`,
    "filter[date]": serviceDate,
    "page[limit]": "650",
  });

  const trips = new Map();
  for (const item of data) {
    const tripId = item.relationships?.trip?.data?.id;
    const stopId = item.relationships?.stop?.data?.id;
    if (!tripId || !stopId) continue;

    const t = bestTimeFromAttrs(item.attributes || {});
    if (!t) continue;

    const seq = item.attributes?.stop_sequence;
    const rec = trips.get(tripId) || {};
    if (arlKids.has(stopId)) { rec.arl_t = t; rec.arl_seq = seq; }
    if (parkKids.has(stopId)) { rec.park_t = t; rec.park_seq = seq; }
    trips.set(tripId, rec);
  }

  const out = [];
  for (const [tripId, rec] of trips.entries()) {
    if (
      rec.arl_t && rec.park_t &&
      Number.isInteger(rec.arl_seq) && Number.isInteger(rec.park_seq) &&
      rec.arl_seq < rec.park_seq &&
      rec.arl_t < rec.park_t // extra safety
    ) {
      out.push({ tripId, fromT: rec.arl_t, toT: rec.park_t });
    }
  }

  // typically we binary-search by park arrival
  out.sort((a, b) => a.toT - b.toT);
  return out;
}

// Map<tripId, { depHarv, arrDisp }>
export async function loadSchedulesBusHarv(state, cfg, serviceDate) {
  const data = await fetchAll(state, "/schedules", {
    "filter[route]": cfg.busRoute,
    "filter[stop]": cfg.harvard,
    "filter[date]": serviceDate,
    "page[limit]": "350",
  });

  const out = new Map();
  for (const item of data) {
    const tripId = item.relationships?.trip?.data?.id;
    if (!tripId) continue;

    const a = item.attributes || {};
    const arr = parseIso(a.arrival_time);
    const dep = parseIso(a.departure_time);
    const depHarv = dep || arr;
    const arrHarv = arr || dep;
    if (!depHarv || !arrHarv) continue;

    const prev = out.get(tripId);
    if (!prev || depHarv < prev.depHarv) out.set(tripId, { depHarv, arrDisp: arrHarv });
  }

  return out;
}

// Map<tripId, Date>
export async function loadSchedulesBusHome(state, cfg, serviceDate, homeStopId) {
  const data = await fetchAll(state, "/schedules", {
    "filter[route]": cfg.busRoute,
    "filter[stop]": homeStopId,
    "filter[date]": serviceDate,
    "page[limit]": "800",
  });

  const out = new Map();
  for (const item of data) {
    const tripId = item.relationships?.trip?.data?.id;
    if (!tripId) continue;
    const a = item.attributes || {};
    const t = parseIso(a.arrival_time) || parseIso(a.departure_time);
    if (!t) continue;
    const prev = out.get(tripId);
    if (!prev || t < prev) out.set(tripId, t);
  }
  return out;
}

/* ---------------- Merge logic ---------------- */

// Merge schedule + prediction pairs by tripId.
// Guarantees scheduled fallback exists even if some predictions exist.
// Also chooses the earliest schedule/pred entry if duplicates appear.
export function mergePairsByTripId(schedPairs, predPairs) {
  const schedMap = new Map();
  for (const p of schedPairs) {
    const prev = schedMap.get(p.tripId);
    if (!prev || p.fromT < prev.fromT) schedMap.set(p.tripId, p);
  }

  const predMap = new Map();
  for (const p of predPairs) {
    const prev = predMap.get(p.tripId);
    if (!prev || p.fromT < prev.fromT) predMap.set(p.tripId, p);
  }

  const tripIds = new Set([...schedMap.keys(), ...predMap.keys()]);
  const out = [];

  for (const tripId of tripIds) {
    const s = schedMap.get(tripId) || null;
    const pr = predMap.get(tripId) || null;

    const fromT = pr?.fromT || s?.fromT || null;
    const toT = pr?.toT || s?.toT || null;
    if (!fromT || !toT) continue;

    // extra guard
    if (!(fromT < toT)) continue;

    out.push({
      tripId,
      fromT,
      toT,
      fromPred: !!pr?.fromT,
      toPred: !!pr?.toT,
      schedFromT: s?.fromT || null,
      schedToT: s?.toT || null,
    });
  }

  out.sort((a, b) => a.fromT - b.fromT);
  return out;
}

// Merge bus harvard/home by tripId, prefer earliest when duplicates exist.
export function mergeBusByTripId(
  schedBusByTrip,
  schedHomeByTrip,
  predBusByTrip,
  predHomeByTrip
) {
  const tripIds = new Set([
    ...schedBusByTrip.keys(),
    ...predBusByTrip.keys(),
    ...schedHomeByTrip.keys(),
    ...predHomeByTrip.keys(),
  ]);

  const out = [];
  for (const tid of tripIds) {
    const sb = schedBusByTrip.get(tid) || null;
    const pb = predBusByTrip.get(tid) || null;

    const dep = pb?.depHarv || sb?.depHarv || null;
    const arr = pb?.arrDisp || sb?.arrDisp || null;
    if (!dep || !arr) continue;

    const sh = schedHomeByTrip.get(tid) || null;
    const ph = predHomeByTrip.get(tid) || null;
    const home = ph || sh || null;

    out.push({
      tripId: tid,
      dep,
      depPred: !!pb?.depHarv,
      schedDep: sb?.depHarv || null,
      arrDisp: arr,
      arrPred: !!pb?.arrDisp,
      schedArr: sb?.arrDisp || null,
      home,
      homePred: !!ph,
      schedHome: sh || null,
    });
  }

  out.sort((a, b) => a.dep - b.dep);
  return out;
}

/* ---------------- Alerts counts per mode ---------------- */

export async function loadRelevantAlertsWithCounts(state, cfg, parkKids, harvKids, arlKids) {
  const routes = [cfg.redRoute, cfg.busRoute, ...cfg.greenRoutes].join(",");
  const data = await fetchAll(state, "/alerts", {
    "filter[route]": routes,
    "page[limit]": "250",
  });

  const parkSet = new Set([...parkKids]);
  const harvSet = new Set([...harvKids]);
  const arlSet = new Set([...arlKids]);

  const headers = [];
  const seen = new Set();

  let red = 0, green = 0, bus = 0;

  for (const a of data) {
    const header = (a.attributes?.header || "").trim();
    if (!header) continue;

    const informed = a.attributes?.informed_entity || [];
    let hits = false;
    let hitRed = false, hitGreen = false, hitBus = false;

    for (const ent of informed) {
      const r = ent.route;
      const s = ent.stop;

      if (r === cfg.busRoute) { hitBus = true; hits = true; }
      if (r === cfg.redRoute) {
        if (!s || parkSet.has(s) || harvSet.has(s)) { hitRed = true; hits = true; }
      }
      if (cfg.greenRoutes.includes(r)) {
        if (!s || arlSet.has(s) || parkSet.has(s)) { hitGreen = true; hits = true; }
      }
    }

    if (!hits) continue;

    if (!seen.has(header)) { seen.add(header); headers.push(header); }
    if (hitRed) red++;
    if (hitGreen) green++;
    if (hitBus) bus++;
  }

  return { headers, counts: { red, green, bus } };
}
