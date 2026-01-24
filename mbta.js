// mbta.js
// MBTA API I/O + predictions/schedules merge + alerts counts
// ES module

export const BASE = "https://api-v3.mbta.com";

const childStopCache = new Map();

function parseIso(s) {
    return s ? new Date(s) : null;
}

function schedOriginTime(attrs) {
    // for origin stop: prefer departure
    return parseIso(attrs?.departure_time) || parseIso(attrs?.arrival_time) || null;
}

function schedDestTime(attrs) {
    // for destination stop: prefer arrival
    return parseIso(attrs?.arrival_time) || parseIso(attrs?.departure_time) || null;
}

function bestTimeFromAttrs(attrs) {
    return parseIso(attrs.arrival_time) || parseIso(attrs.departure_time);
}

export function csvFromSet(set) {
    return [...set].join(",");
}

function csvFromAnySet(set) {
    return [...new Set([...set])].sort().join(",");
}

// ---- Persistent cache (localStorage) ----
const LS_PREFIX = "mbta-cache:v1:";
const LS_MAX_BYTES = 750_000; // best-effort guard; adjust if you want

function lsKey(key) {
    return LS_PREFIX + key;
}

function lsGet(key) {
    try {
        const raw = localStorage.getItem(lsKey(key));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object") return null;
        if (obj.expiresAt && obj.expiresAt <= Date.now()) {
            localStorage.removeItem(lsKey(key));
            return null;
        }
        return obj.value ?? null;
    } catch {
        return null;
    }
}

function lsGetEntry(key) {
    try {
        const raw = localStorage.getItem(lsKey(key));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object") return null;
        if (obj.expiresAt && obj.expiresAt <= Date.now()) {
            localStorage.removeItem(lsKey(key));
            return null;
        }
        return obj; // includes { expiresAt, savedAt, value, ...custom fields }
    } catch {
        return null;
    }
}

function lsSet(key, value, ttlMs) {
    try {
        const obj = {
            expiresAt: Date.now() + ttlMs,
            savedAt: Date.now(),
            value,
        };
        const raw = JSON.stringify(obj);

        // crude guard against runaway growth
        if (raw.length > LS_MAX_BYTES) return;

        localStorage.setItem(lsKey(key), raw);
    } catch {
        // quota exceeded / blocked - just skip caching
    }
}

// Optional: wipe all cached MBTA stuff
export function clearPersistentMbtaCache() {
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
        }
    } catch { }
}

function stableParamsKey(params) {
    const p = params ? Object.entries(params).sort(([a], [b]) => a.localeCompare(b)) : [];
    return JSON.stringify(p);
}

function persistentKey(url, params, { includeApiKey = false, apiKey = "" } = {}) {
    // IMPORTANT: for stops data, apiKey does not affect content, so exclude by default.
    return `${url}|${stableParamsKey(params)}|k:${includeApiKey ? apiKey : ""}`;
}

function normalizeStartOverride(startOverride) {
    // Fingerprint must be stable across reloads.
    // Accept Date, ISO string, number, etc.
    if (!startOverride) return "";
    if (startOverride instanceof Date) return startOverride.toISOString();

    // If it's a string that parses as a date, normalize to ISO (stable).
    if (typeof startOverride === "string") {
        const d = new Date(startOverride);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
        return startOverride; // keep raw string if not a date
    }

    // numbers / booleans / objects -> stringify best-effort
    try {
        return typeof startOverride === "object"
            ? JSON.stringify(startOverride)
            : String(startOverride);
    } catch {
        return String(startOverride);
    }
}

// Fetch + persistent cache with TTL
export async function fetchJsonCachedPersistent(
    state,
    url,
    params = null,
    ttlMs = 0,
    { includeApiKeyInCacheKey = false } = {}
) {
    const key = persistentKey(url, params, { includeApiKey: includeApiKeyInCacheKey, apiKey: state?.apiKey || "" });

    if (ttlMs > 0) {
        const hit = lsGet(key);
        if (hit) return hit;
    }

    const value = await fetchJson(state, url, params);

    if (ttlMs > 0) lsSet(key, value, ttlMs);
    return value;
}

export async function fetchJson(state, url, params = null) {
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

    const headers = { Accept: "application/vnd.api+json" };
    if (state?.apiKey) {
        u.searchParams.set("api_key", state.apiKey);
    }

    const res = await fetch(u.toString(), { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`.trim());
    }
    return await res.json();
}


function buildStopParentMap(included) {
    const m = new Map(); // stopId -> parentStationId
    for (const inc of included || []) {
        if (inc.type !== "stop") continue;
        const id = inc.id;
        if (!id) continue;
        const p = inc.attributes?.parent_station;
        if (p) m.set(id, p);
    }
    return m;
}

export async function fetchAllWithIncluded(state, path, params) {
    let url = `${BASE}${path}`;
    let p = { ...params };
    const out = [];
    const includedByKey = new Map(); // `${type}:${id}` -> resource

    while (true) {
        const payload = await fetchJson(state, url, p);
        out.push(...(payload.data || []));

        for (const inc of payload.included || []) {
            if (!inc?.type || !inc?.id) continue;
            includedByKey.set(`${inc.type}:${inc.id}`, inc);
        }

        const next = payload.links && payload.links.next;
        if (!next) break;
        url = next.startsWith("/") ? `${BASE}${next}` : next;
        p = null;
    }

    return { data: out, included: [...includedByKey.values()] };
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
const MIN = 60 * 1000;
const SCHEDULE_TTL = 60 * MIN;          // stored up to 1 hour
const SCHEDULE_WINDOW_MIN = 60;         // window size + reset threshold
const SCHEDULES_ONEKEY = "schedules:onekey"; // one localStorage entry total

function minutesFromHHMM(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 47 || mm < 0 || mm > 59) return null; // allow service-day > 24h
    return hh * 60 + mm;
}

function hhmmFromMinutes(totalMinutes) {
    if (!Number.isFinite(totalMinutes)) return null;
    // allow > 24h (service day), but keep it sane
    const t = Math.max(0, Math.min(47 * 60 + 59, Math.floor(totalMinutes)));
    const hh = Math.floor(t / 60);
    const mm = t % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function readSchedulesOneKey() {
    return lsGetEntry(SCHEDULES_ONEKEY) || null; // uses your lsGetEntry()
}

function writeSchedulesOneKey(obj) {
    try {
        const raw = JSON.stringify(obj);
        if (raw.length > LS_MAX_BYTES) return;
        localStorage.setItem(lsKey(SCHEDULES_ONEKEY), raw);
    } catch { }
}

/**
 * One LS entry with per-group slots, but ONLY min_time controls reuse.
 * On MISS, fetches a fixed window: [min_time, min_time + 60min]
 * On HIT, returns cached value even if caller's max_time moved forward.
 */
async function fetchSchedulesOneKeyCached(state, groupName, params) {
    const reqDate = params?.["filter[date]"] || "";
    const reqMinStr = params?.["filter[min_time]"] || "";
    const reqMin = minutesFromHHMM(reqMinStr);

    const reqOverrideKey = normalizeStartOverride(state.startOverride);

    // If we can't parse min_time, don't cache (just fetch exact params)
    if (reqMin == null) {
        return await fetchAllWithIncluded(state, "/schedules", params);
    }

    const cache = readSchedulesOneKey(); // lsGetEntry(SCHEDULES_ONEKEY)
    const cacheOverrideKey = cache?.overrideKey || "";

    // If startOverride fingerprint changed, treat as a hard reset.
    // (Still only ONE LS entry — we just overwrite it.)
    const overrideMismatch = cache && cacheOverrideKey !== reqOverrideKey;

    const slot = !overrideMismatch ? cache?.groups?.[groupName] : null;

    if (slot?.value && slot.date === reqDate && typeof slot.minTime === "string") {
        const cachedMin = minutesFromHHMM(slot.minTime);
        if (cachedMin != null) {
            const delta = reqMin - cachedMin;

            // Your rule:
            // - reset if reqMin < cachedMin
            // - reset if reqMin > cachedMin + 60
            if (delta >= 0 && delta <= SCHEDULE_WINDOW_MIN) {
                return slot.value; // HIT
            }
        }
    }

    // MISS: fetch a fixed 60-minute window starting at reqMin
    const fetchMinStr = reqMinStr;
    const fetchMaxStr = params["filter[max_time]"] || hhmmFromMinutes(reqMin + SCHEDULE_WINDOW_MIN);

    const fetchParams = {
        ...params,
        "filter[min_time]": fetchMinStr,
        "filter[max_time]": fetchMaxStr,
    };

    const value = await fetchAllWithIncluded(state, "/schedules", fetchParams);

    // Write back into the ONE localStorage entry.
    // If override changed, drop all groups (hard reset).
    const next =
        cache?.groups && !overrideMismatch
            ? cache
            : { expiresAt: 0, savedAt: 0, overrideKey: reqOverrideKey, groups: {} };

    next.expiresAt = Date.now() + SCHEDULE_TTL;
    next.savedAt = Date.now();
    next.overrideKey = reqOverrideKey;

    next.groups[groupName] = {
        date: reqDate,
        minTime: fetchMinStr, // fingerprint (plus overrideKey at top level)
        maxTime: fetchMaxStr, // informational/debug only
        value,
    };

    writeSchedulesOneKey(next);
    return value;
}



const STOP_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function childStops(state, parentStopId) {
    // fast path: in-memory for this session
    if (childStopCache.has(parentStopId)) return childStopCache.get(parentStopId);

    const payload = await fetchJsonCachedPersistent(
        state,
        `${BASE}/stops/${parentStopId}`,
        {
            include: "child_stops",
            "fields[stop]": "parent_station", // keep payload small
        },
        STOP_TTL,
        { includeApiKeyInCacheKey: false }
    );

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
    const { data, included } = await fetchAllWithIncluded(state, "/predictions", {
        "filter[route]": routeCsv,
        "filter[stop]": stopCsv,

        "page[limit]": "250",

        // keep include stop, but only ask for parent_station
        "include": "stop",
        "fields[stop]": "parent_station",

        // only the prediction fields you read in buildTripStopTimesFromPred
        "fields[prediction]": "arrival_time,departure_time,stop_sequence,direction_id",
    });

    return { data, stopParent: buildStopParentMap(included) };
}


// Build Map<tripId, { dir, stops: {name:{t, seq, arr, dep}} }>
export function buildTripStopTimesFromPred(predData, stopSetsByName, predWindowMin = 120, stopParent = null, nowOverride = null) {
    const out = new Map();
    const now = nowOverride instanceof Date ? nowOverride : new Date();
    const horizon = new Date(now.getTime() + predWindowMin * 60_000);

    const inHorizon = (t) => t && t >= new Date(now.getTime() - 60_000) && t <= horizon;

    for (const p of predData) {
        const tripId = p.relationships?.trip?.data?.id;
        const stopId = p.relationships?.stop?.data?.id;
        if (!tripId || !stopId) continue;

        const effStopId = stopParent?.get(stopId) || stopId;

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
            if (set && set.has(effStopId)) {
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
export async function loadSchedulesRedPairs(state, cfg, serviceDate, parkKids, harvKids, minTime, maxTime) {
    const stopCsv = csvFromAnySet(new Set([...parkKids, ...harvKids]));

    const params = {
        "filter[route]": cfg.redRoute,
        "filter[stop]": stopCsv,
        "filter[date]": serviceDate,
        "filter[min_time]": minTime,
        "filter[max_time]": maxTime,
        "page[limit]": "450",
        "include": "stop",
        "fields[stop]": "parent_station",
        "fields[schedule]": "arrival_time,departure_time,stop_sequence",
    };

    const { data, included } = await fetchSchedulesOneKeyCached(state, "redPairs", params);

    const stopParent = buildStopParentMap(included);

    const trips = new Map();
    for (const item of data) {
        const tripId = item.relationships?.trip?.data?.id;
        const stopId = item.relationships?.stop?.data?.id;
        if (!tripId || !stopId) continue;

        const eff = stopParent.get(stopId) || stopId;

        const t = bestTimeFromAttrs(item.attributes || {});
        if (!t) continue;

        const rawSeq = item.attributes?.stop_sequence;
        const seq = rawSeq == null ? null : Number(rawSeq);
        const seqOk = Number.isFinite(seq) ? seq : null;

        const rec = trips.get(tripId) || {};
        const attrs = item.attributes || {};
        if (parkKids.has(eff)) {
            const t = schedOriginTime(attrs);
            if (t) { rec.park_t = t; rec.park_seq = seqOk; }
        }
        if (harvKids.has(eff)) {
            const t = schedDestTime(attrs);
            if (t) { rec.harv_t = t; rec.harv_seq = seqOk; }
        }
        trips.set(tripId, rec);
    }

    const out = [];
    for (const [tripId, rec] of trips.entries()) {
        if (!rec.park_t || !rec.harv_t) continue;
        if (!(rec.park_t < rec.harv_t)) continue;
        if (rec.park_seq != null && rec.harv_seq != null && !(rec.park_seq < rec.harv_seq)) continue;
        out.push({ tripId, fromT: rec.park_t, toT: rec.harv_t });
    }

    out.sort((a, b) => a.fromT - b.fromT);
    return out;
}


// [{tripId, fromT(arl), toT(park)}]
export async function loadSchedulesGreenPairs(state, cfg, serviceDate, arlKids, parkKids, minTime, maxTime) {
    const stopCsv = csvFromAnySet(new Set([...arlKids, ...parkKids]));

    const params = {
        "filter[route]": cfg.greenRoutes.join(","),
        "filter[stop]": stopCsv,
        "filter[date]": serviceDate,
        "filter[min_time]": minTime,
        "filter[max_time]": maxTime,
        "page[limit]": "650",
        "include": "stop",
        "fields[stop]": "parent_station",
        "fields[schedule]": "arrival_time,departure_time,stop_sequence",
    };

    const { data, included } = await fetchSchedulesOneKeyCached(state, "greenPairs", params);

    const stopParent = buildStopParentMap(included);

    const trips = new Map();
    for (const item of data) {
        const tripId = item.relationships?.trip?.data?.id;
        const stopId = item.relationships?.stop?.data?.id;
        if (!tripId || !stopId) continue;

        const eff = stopParent.get(stopId) || stopId;

        const t = bestTimeFromAttrs(item.attributes || {});
        if (!t) continue;

        const rawSeq = item.attributes?.stop_sequence;
        const seq = rawSeq == null ? null : Number(rawSeq);
        const seqOk = Number.isFinite(seq) ? seq : null;

        const rec = trips.get(tripId) || {};
        const attrs = item.attributes || {};
        if (arlKids.has(eff)) {
            const t = schedOriginTime(attrs);
            if (t) { rec.arl_t = t; rec.arl_seq = seqOk; }
        }
        if (parkKids.has(eff)) {
            const t = schedDestTime(attrs);
            if (t) { rec.park_t = t; rec.park_seq = seqOk; }
        }
        trips.set(tripId, rec);
    }

    const out = [];
    for (const [tripId, rec] of trips.entries()) {
        if (!rec.arl_t || !rec.park_t) continue;
        if (!(rec.arl_t < rec.park_t)) continue;
        if (rec.arl_seq != null && rec.park_seq != null && !(rec.arl_seq < rec.park_seq)) continue;
        out.push({ tripId, fromT: rec.arl_t, toT: rec.park_t });
    }

    out.sort((a, b) => a.toT - b.toT);
    return out;
}


// Map<tripId, { depHarv, arrDisp }>
export async function loadSchedulesBusHarv(state, cfg, serviceDate, harvKids, minTime, maxTime) {
    const params = {
        "filter[route]": cfg.busRoute,
        "filter[stop]": csvFromAnySet(harvKids),
        "filter[date]": serviceDate,
        "filter[min_time]": minTime,
        "filter[max_time]": maxTime,
        "page[limit]": "350",
        "include": "stop",
        "fields[stop]": "parent_station",
        "fields[schedule]": "arrival_time,departure_time,stop_sequence",
    };

    const { data, included } = await fetchSchedulesOneKeyCached(state, "busHarvard", params);

    const stopParent = buildStopParentMap(included);

    const out = new Map();
    for (const item of data) {
        const tripId = item.relationships?.trip?.data?.id;
        const stopId = item.relationships?.stop?.data?.id;
        if (!tripId || !stopId) continue;

        const eff = stopParent.get(stopId) || stopId;
        if (!harvKids.has(eff)) continue;

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
export async function loadSchedulesBusHome(state, cfg, serviceDate, homeKids, minTime, maxTime) {
    const params = {
        "filter[route]": cfg.busRoute,
        "filter[stop]": csvFromAnySet(homeKids),
        "filter[date]": serviceDate,
        "filter[min_time]": minTime,
        "filter[max_time]": maxTime,
        "page[limit]": "800",
        "include": "stop",
        "fields[stop]": "parent_station",
        "fields[schedule]": "arrival_time,departure_time,stop_sequence",
    };

    const { data, included } = await fetchSchedulesOneKeyCached(state, "busHome", params);

    const stopParent = buildStopParentMap(included);

    const out = new Map();
    for (const item of data) {
        const tripId = item.relationships?.trip?.data?.id;
        const stopId = item.relationships?.stop?.data?.id;
        if (!tripId || !stopId) continue;

        const eff = stopParent.get(stopId) || stopId;
        if (!homeKids.has(eff)) continue;

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

        // Only use predictions if BOTH endpoints exist
        const usePred = !!(pr?.fromT && pr?.toT);

        const fromT = usePred ? pr.fromT : s?.fromT || null;
        const toT = usePred ? pr.toT : s?.toT || null;

        if (!fromT || !toT) continue;
        if (!(fromT < toT)) continue;

        out.push({
            tripId,
            fromT,
            toT,
            fromPred: usePred,
            toPred: usePred,
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
