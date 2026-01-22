// planner.js
// Build groups/rows, including time-cells that can be underlined if predicted.
// Partial predictions supported: overlay predictions per-stop over schedules.
// ES module

import {
    childStops,
    csvFromSet,
    loadPredictions,
    buildTripStopTimesFromPred,
    busTripsFromPred,
    loadSchedulesRedPairs,
    loadSchedulesGreenPairs,
    loadSchedulesBusHarv,
    loadSchedulesBusHome,
    mergeBusByTripId,
    loadRelevantAlertsWithCounts,
} from "./mbta.js";

// planner.js

function parseStartOverride(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;

  // strict: must be YYYY-MM-DDTHH:MM (or space)
  const norm = t.replace(" ", "T");
  const m = norm.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;

  const [, yy, mm, dd, hh, mi] = m;
  const d = new Date(Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), 0, 0);
  return isNaN(d) ? null : d;
}

export function getNowInfo(state) {
  const raw = (state.startOverride || "").trim();
  const parsed = parseStartOverride(raw);
  if (raw && !parsed) {
    return { now: floorToMinute(new Date()), overrideOk: false };
  }
  return { now: floorToMinute(parsed || new Date()), overrideOk: true };
}


function hhmmLocal(d) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function addMinutes(d, min) {
    return new Date(d.getTime() + min * 60_000);
}

function ymdLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build schedule query “slices” so min_time/max_time always makes sense per serviceDate.
// Example:
//   start=23:10, end=02:10 (next day)
//   slices = [
//     { date: <start day>, min:"22:40", max:"23:59" },
//     { date: <end day>,   min:"00:00", max:"02:40" },
//   ]
function scheduleSlicesForWindow(start, end, padMin = 30) {
    const startPad = addMinutes(start, -padMin);
    const endPad = addMinutes(end, padMin);

    const slices = [];
    const startY = ymdLocal(startPad);
    const endY = ymdLocal(endPad);

    if (startY === endY) {
        slices.push({ date: startY, min: hhmmLocal(startPad), max: hhmmLocal(endPad) });
        return slices;
    }

    // First day: from startPad -> end of day
    slices.push({ date: startY, min: hhmmLocal(startPad), max: "23:59" });

    // Middle days (rare, but safe)
    let cur = new Date(startPad);
    cur.setHours(0, 0, 0, 0);
    cur.setDate(cur.getDate() + 1);
    while (ymdLocal(cur) !== endY) {
        slices.push({ date: ymdLocal(cur), min: "00:00", max: "23:59" });
        cur.setDate(cur.getDate() + 1);
    }

    // Last day: start of day -> endPad
    slices.push({ date: endY, min: "00:00", max: hhmmLocal(endPad) });

    return slices;
}


function floorToMinute(d) {
    const x = new Date(d);
    x.setSeconds(0, 0);
    return x;
}

export function getNow(state) {
    return floorToMinute(parseStartOverride((state.startOverride || "").trim()) || new Date());
}

export function serviceDatesForWindow(start, end) {
    const toYMD = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const dates = new Set();
    dates.add(toYMD(start));
    dates.add(toYMD(end));

    // Only include previous day if the window crosses midnight OR is very early AM,
    // where “service day” can still be previous date for late-night trips.
    const crossesMidnight = toYMD(start) !== toYMD(end);
    const earlyAM = start.getHours() < 3 || end.getHours() < 3;

    if (crossesMidnight || earlyAM) {
        const prev = new Date(start);
        prev.setDate(prev.getDate() - 1);
        dates.add(toYMD(prev));
    }

    return [...dates].sort();
}

export function timeCell(text, pred = false, schedText = "") {
    return { text: text || "", pred: !!pred, schedText: schedText || "" };
}

export function fmtHHMM(d) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

export function padWait(min) {
    return `${String(min).padStart(2, " ")} min`;
}

// upperBound by greenPairs[].toT (Park arrival)
function upperBoundByToT(arr, cutoffToT) {
    let lo = 0,
        hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].toT <= cutoffToT) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// lowerBound by busSorted[].dep
function lowerBoundByDep(arr, ready) {
    let lo = 0,
        hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].dep < ready) lo = mid + 1;
        else hi = mid;
    }
    return lo < arr.length ? arr[lo] : null;
}

// Best group = has at least one viable connection, but never mark the last such group "best"
export function markBestGroups(groupsOrdered) {
    const usable = groupsOrdered.filter(
        (g) => g.meta.tripId !== "__NONE__" && (g.items?.length || 0) > 0
    );
    const lastKey = usable.length ? usable[usable.length - 1].key : null;

    for (const g of groupsOrdered) {
        g.best = g.meta.tripId !== "__NONE__" && g.items.length > 0 && g.key !== lastKey;
    }
    return groupsOrdered;
}

function canUsePredictions(state) {
    // Don’t mix simulation time with live predictions
    return !(state.startOverride || "").trim();
}

function predStopTimesFromTripMap(tripMap, stopName) {
    // Map<tripId, Date>
    const out = new Map();
    for (const [tripId, rec] of tripMap.entries()) {
        const st = rec.stops?.[stopName];
        if (st?.t instanceof Date && !isNaN(st.t)) out.set(tripId, st.t);
    }
    return out;
}

function pickEarliestByTripId(pairs) {
    // Map<tripId, {tripId, fromT, toT}>
    const m = new Map();
    for (const p of pairs) {
        const prev = m.get(p.tripId);
        if (!prev || p.fromT < prev.fromT) m.set(p.tripId, p);
    }
    return m;
}
// Pick the schedule pair for a tripId that best matches the window.
// Preference order:
// 1) any pair whose fromT is within [start,end] (choose earliest within window)
// 2) otherwise, choose the pair whose fromT is closest to start
function pickSchedBestForWindow(schedPairs, start, end) {
    const m = new Map(); // tripId -> pair
    for (const p of schedPairs) {
        const prev = m.get(p.tripId);
        if (!prev) { m.set(p.tripId, p); continue; }

        const inWin = p.fromT >= start && p.fromT <= end;
        const prevIn = prev.fromT >= start && prev.fromT <= end;

        if (inWin && !prevIn) { m.set(p.tripId, p); continue; }
        if (inWin && prevIn && p.fromT < prev.fromT) { m.set(p.tripId, p); continue; }

        if (!inWin && !prevIn) {
            const d1 = Math.abs(p.fromT - start);
            const d0 = Math.abs(prev.fromT - start);
            if (d1 < d0) m.set(p.tripId, p);
        }
    }
    return m;
}

// Partial merge: overlay predictions per-stop over schedules, and include pred-only trips.
// IMPORTANT: schedule selection is window-aware to prevent cross-date tripId collisions.
function mergePairsPartial(schedPairs, predFromMap, predToMap, start, end) {
    const schedMap = pickSchedBestForWindow(schedPairs, start, end);

    const tripIds = new Set([
        ...schedMap.keys(),
        ...(predFromMap ? predFromMap.keys() : []),
        ...(predToMap ? predToMap.keys() : []),
    ]);

    const out = [];
    for (const tripId of tripIds) {
        const s = schedMap.get(tripId) || null;

        const schedFromT = s?.fromT || null;
        const schedToT = s?.toT || null;

        const predFromT = predFromMap?.get(tripId) || null;
        const predToT = predToMap?.get(tripId) || null;

        const fromT = predFromT || schedFromT;
        const toT = predToT || schedToT;

        if (!fromT || !toT) continue;
        if (!(fromT < toT)) continue;

        out.push({
            tripId,
            fromT,
            toT,
            fromPred: !!predFromT,
            toPred: !!predToT,
            schedFromT,
            schedToT,
        });
    }

    out.sort((a, b) => a.fromT - b.fromT);
    return out;
}

function chooseCloserToStart(prevT, nextT, start) {
    const d0 = Math.abs(prevT - start);
    const d1 = Math.abs(nextT - start);
    return d1 < d0;
}

function upsertBusHarv(map, tid, v, start, end) {
    const prev = map.get(tid);
    if (!prev) { map.set(tid, v); return; }

    const inWin = v.depHarv >= start && v.depHarv <= end;
    const prevIn = prev.depHarv >= start && prev.depHarv <= end;

    if (inWin && !prevIn) { map.set(tid, v); return; }
    if (inWin && prevIn && v.depHarv < prev.depHarv) { map.set(tid, v); return; }

    if (!inWin && !prevIn && chooseCloserToStart(prev.depHarv, v.depHarv, start)) {
        map.set(tid, v);
    }
}

function upsertBusHome(map, tid, t, start, end) {
    const prev = map.get(tid);
    if (!prev) { map.set(tid, t); return; }

    const inWin = t >= start && t <= end;
    const prevIn = prev >= start && prev <= end;

    if (inWin && !prevIn) { map.set(tid, t); return; }
    if (inWin && prevIn && t < prev) { map.set(tid, t); return; }

    if (!inWin && !prevIn && chooseCloserToStart(prev, t, start)) {
        map.set(tid, t);
    }
}


export async function buildGroupsForWindow(state, cfg) {
    const includeHome = Boolean((state.homeStop || "").trim());
    const { now: start, overrideOk } = getNowInfo(state);
    const end = new Date(start.getTime() + cfg.hours * 3600 * 1000);
    const scheduleSlices = scheduleSlicesForWindow(start, end, 30);


    const [parkKids, harvKids, arlKids] = await Promise.all([
        childStops(state, cfg.park),
        childStops(state, cfg.harvard),
        childStops(state, cfg.arlington),
    ]);

    const homeKids = includeHome
        ? await childStops(state, state.homeStop).catch(() => new Set([state.homeStop]))
        : new Set();

    const alertInfo = await loadRelevantAlertsWithCounts(state, cfg, parkKids, harvKids, arlKids);

    /* ---------------- BUS schedules always ---------------- */
    const schedBusByTrip = new Map();
    const schedHomeByTrip = new Map();

    for (const sl of scheduleSlices) {
        const sh = await loadSchedulesBusHarv(state, cfg, sl.date, harvKids, sl.min, sl.max);
        for (const [tid, v] of sh.entries()) {
            upsertBusHarv(schedBusByTrip, tid, v, start, end);
        }

        if (includeHome) {
            const home = await loadSchedulesBusHome(state, cfg, sl.date, homeKids, sl.min, sl.max);
            for (const [tid, t] of home.entries()) {
                upsertBusHome(schedHomeByTrip, tid, t, start, end);
            }
        }
    }

    /* ---------------- BUS predictions optional ---------------- */
    const predBusByTrip = new Map();
    const predHomeByTrip = new Map();

    if (canUsePredictions(state)) {
        const stopSet = new Set([...harvKids]);
        if (includeHome) for (const s of homeKids) stopSet.add(s);

        const { data: predData, stopParent } = await loadPredictions(state, cfg.busRoute, csvFromSet(stopSet));
        const tripMap = buildTripStopTimesFromPred(
            predData,
            { harv: harvKids, home: includeHome ? homeKids : null },
            cfg.predWindowMin,
            stopParent,
            start,
        );

        const busPred = busTripsFromPred(tripMap, includeHome);
        for (const [tid, v] of busPred.entries()) {
            predBusByTrip.set(tid, { depHarv: v.depHarv, arrDisp: v.arrDisp });
            if (includeHome && v.home) predHomeByTrip.set(tid, v.home);
        }
    }

    let busSorted = mergeBusByTripId(schedBusByTrip, schedHomeByTrip, predBusByTrip, predHomeByTrip);

    // Only consider trips headed toward home if home is set
    if (includeHome) busSorted = busSorted.filter((b) => b.home && b.home > b.dep);

    const busLookup = new Map();
    for (const b of busSorted) busLookup.set(`${b.dep.toISOString()}|${b.tripId}`, b);

    /* ---------------- GREEN schedules always ---------------- */
    let schedGreenPairs = [];
    for (const sl of scheduleSlices) {
        schedGreenPairs.push(...(await loadSchedulesGreenPairs(state, cfg, sl.date, arlKids, parkKids, sl.min, sl.max)));
    }

    /* ---------------- GREEN predictions optional (partial overlay) ---------------- */
    let greenPairs = [];
    if (canUsePredictions(state)) {
        const stopSet = new Set([...arlKids, ...parkKids]);
        const { data: predData, stopParent } = await loadPredictions(
            state,
            cfg.greenRoutes.join(","),
            csvFromSet(stopSet)
        );
        const tripMap = buildTripStopTimesFromPred(
            predData,
            { arl: arlKids, park: parkKids },
            cfg.predWindowMin,
            stopParent,
            start,
        );

        const predArl = predStopTimesFromTripMap(tripMap, "arl");
        const predPark = predStopTimesFromTripMap(tripMap, "park");

        greenPairs = mergePairsPartial(schedGreenPairs, predArl, predPark, start, end);
    } else {
        greenPairs = mergePairsPartial(schedGreenPairs, null, null, start, end);
    }

    // Binary-search by Park arrival
    greenPairs.sort((a, b) => a.toT - b.toT);

    /* ---------------- RED schedules always ---------------- */
    let schedRedPairs = [];
    for (const sl of scheduleSlices) {
        schedRedPairs.push(...(await loadSchedulesRedPairs(state, cfg, sl.date, parkKids, harvKids, sl.min, sl.max)));
    }

    /* ---------------- RED predictions optional (partial overlay) ---------------- */
    let redPairs = [];
    if (canUsePredictions(state)) {
        const stopSet = new Set([...parkKids, ...harvKids]);
        const { data: predData, stopParent } = await loadPredictions(
            state,
            cfg.redRoute,
            csvFromSet(stopSet)
        );
        const tripMap = buildTripStopTimesFromPred(
            predData,
            { park: parkKids, harv: harvKids },
            cfg.predWindowMin,
            stopParent,
            start,
        );

        const predPark = predStopTimesFromTripMap(tripMap, "park");
        const predHarv = predStopTimesFromTripMap(tripMap, "harv");

        redPairs = mergePairsPartial(schedRedPairs, predPark, predHarv, start, end);
    } else {
        redPairs = mergePairsPartial(schedRedPairs, null, null, start, end);
    }

    // Filter to window by Park arrival
    redPairs = redPairs.filter((p) => p.fromT >= start && p.fromT <= end).sort((a, b) => a.fromT - b.fromT);

    const bufferMs = Math.max(0, Number(state.layoverMin || 0)) * 60_000;

    // Assign each Red -> next feasible bus
    const assigned = [];
    for (const rp of redPairs) {
        const redPark = rp.fromT;
        const redHarvArr = rp.toT;

        // Arlington: last green with Park arrival <= RedPark - 1 min
        // If the green arrival is already before "now", show "—"
        let arlington = timeCell("—", false, "");
        if (greenPairs.length) {
            const cutoff = new Date(redPark.getTime() - 60_000);
            const idx = upperBoundByToT(greenPairs, cutoff) - 1;
            if (idx >= 0) {
                const gp = greenPairs[idx];
                const greenArl = gp.fromT;

                const shown = greenArl && greenArl >= start ? fmtHHMM(greenArl) : "—";
                const pred = gp.fromPred && shown !== "—";
                const sched = gp.schedFromT ? fmtHHMM(gp.schedFromT) : ""; // empty => "No scheduled time available"
                arlington = timeCell(shown, pred, sched);
            }
        }

        const ready = new Date(redHarvArr.getTime() + bufferMs);
        const b = lowerBoundByDep(busSorted, ready);

        if (!b) {
            assigned.push({
                gkey: "NONE|__NONE__",
                arlington,
                redParkDate: redPark,
                redParkPred: rp.fromPred,
                redParkSched: rp.schedFromT,
                waitMin: null,
            });
            continue;
        }

        const waitMin = Math.floor((b.dep - redHarvArr) / 60000);
        assigned.push({
            gkey: `${b.dep.toISOString()}|${b.tripId}`,
            arlington,
            redParkDate: redPark,
            redParkPred: rp.fromPred,
            redParkSched: rp.schedFromT,
            waitMin,
        });
    }

    // Group by bus trip key
    const groupsMap = new Map();
    for (const a of assigned) {
        if (!groupsMap.has(a.gkey)) groupsMap.set(a.gkey, { key: a.gkey, meta: null, items: [] });
        groupsMap.get(a.gkey).items.push(a);
    }

    // Keep bus groups visible even if no viable connections remain
    for (const b of busSorted) {
        if (!b.dep) continue;
        const depInWindow = b.dep >= start && b.dep <= end;
        const homeInWindow = includeHome && b.home && b.home >= start && b.home <= end;
        if (!depInWindow && !homeInWindow) continue;

        const gkey = `${b.dep.toISOString()}|${b.tripId}`;
        if (!groupsMap.has(gkey)) groupsMap.set(gkey, { key: gkey, meta: null, items: [] });
    }

    // Attach meta
    for (const g of groupsMap.values()) {
        const [depIso, tripId] = g.key.split("|");

        if (tripId === "__NONE__") {
            g.meta = {
                tripId,
                dep: null,
                busArr: null,
                busArrPred: false,
                busArrSched: null,
                home: null,
                homePred: false,
                homeSched: null,
                parkBestDate: null,
            };
        } else {
            const dep = new Date(depIso);
            const b = busLookup.get(g.key) || null;
            g.meta = {
                tripId,
                dep,
                busArr: b?.arrDisp || null,
                busArrPred: !!b?.arrPred,
                busArrSched: b?.schedArr || null,
                home: b?.home || null,
                homePred: !!b?.homePred,
                homeSched: b?.schedHome || null,
                parkBestDate: null,
            };
        }

        g.items.sort((x, y) => x.redParkDate - y.redParkDate);
    }

    let groupsOrdered = [...groupsMap.values()].sort((a, b) => {
        const A = a.meta,
            B = b.meta;
        const aNone = A.tripId === "__NONE__",
            bNone = B.tripId === "__NONE__";
        if (aNone && bNone) return 0;
        if (aNone) return 1;
        if (bNone) return -1;
        return A.dep - B.dep;
    });

    markBestGroups(groupsOrdered);

    // Build rowsCollapsed/rowsExpanded
    const out = [];
    for (const g of groupsOrdered) {
        let rowsExpanded;

        // inside buildGroupsForWindow(), inside: for (const g of groupsOrdered) { ... }
        if (!g.items.length) {
            const busArr = g.meta.busArr instanceof Date ? g.meta.busArr : null;
            const homeArr = includeHome && g.meta.home instanceof Date ? g.meta.home : null;

            const onlyHomeLeft =
                includeHome &&
                homeArr && homeArr >= start && homeArr <= end &&
                (!busArr || busArr < start || busArr > end);

            const now = getNow(state);
            const mhl = Math.max(0, Number(state.layoverMin || 0)); // Minimum Harvard Layover (minutes)

            const minsToHarvardArr = busArr ? Math.max(0, Math.floor((busArr - now) / 60000)) : null;

            // Proxy layover for empty groups (no viable Red): min(remaining mins until Harvard arrival, MHL)
            const proxyLayoverMin =
                minsToHarvardArr == null ? null : Math.min(minsToHarvardArr, mhl);

            rowsExpanded = [{
                arlington: timeCell("—", false, ""),
                park: timeCell("—", false, ""),
                layover: onlyHomeLeft
                    ? "—"
                    : (proxyLayoverMin == null ? "—" : padWait(proxyLayoverMin)),
                harvard: onlyHomeLeft
                    ? timeCell("—", false, "")
                    : (busArr
                        ? timeCell(
                            fmtHHMM(busArr),
                            g.meta.busArrPred,
                            g.meta.busArrSched ? fmtHHMM(g.meta.busArrSched) : ""
                        )
                        : timeCell("—", false, "")),
                home: includeHome
                    ? (homeArr
                        ? timeCell(
                            fmtHHMM(homeArr),
                            g.meta.homePred,
                            g.meta.homeSched ? fmtHHMM(g.meta.homeSched) : ""
                        )
                        : "")
                    : "",
                bestRow: false,
            }];

            g.meta.parkBestDate = null;
        } else {
            rowsExpanded = g.items.map((it, idx) => {
                const isLast = idx === g.items.length - 1;

                const parkShown = fmtHHMM(it.redParkDate);
                const parkSched = it.redParkSched ? fmtHHMM(it.redParkSched) : "";
                const parkCell = timeCell(parkShown, it.redParkPred, parkSched);

                const harvCell =
                    isLast && g.meta.busArr
                        ? timeCell(
                            fmtHHMM(g.meta.busArr),
                            g.meta.busArrPred,
                            g.meta.busArrSched ? fmtHHMM(g.meta.busArrSched) : ""
                        )
                        : timeCell("", false, "");

                const homeCell =
                    isLast && includeHome && g.meta.home
                        ? timeCell(
                            fmtHHMM(g.meta.home),
                            g.meta.homePred,
                            g.meta.homeSched ? fmtHHMM(g.meta.homeSched) : ""
                        )
                        : timeCell("", false, "");

                return {
                    arlington: it.arlington,
                    park: parkCell,
                    layover: it.waitMin == null ? "—" : padWait(it.waitMin),
                    harvard: harvCell,
                    home: includeHome ? homeCell : "",
                    bestRow: false,
                };
            });

            const bestIdx = rowsExpanded.length - 1;
            g.meta.parkBestDate = g.items[bestIdx]?.redParkDate || null;
            if (bestIdx >= 0 && g.best) rowsExpanded[bestIdx].bestRow = true;
        }

        const lastRow = rowsExpanded[rowsExpanded.length - 1];
        const rowsCollapsed = { ...lastRow };

        // If collapsed Arlington is empty, keep last non-empty (helpful)
        if (g.items.length) {
            const lastItem = g.items[g.items.length - 1];
            const a = rowsCollapsed.arlington?.text || "";
            const la = lastItem.arlington?.text || "";
            if (!a && la) rowsCollapsed.arlington = lastItem.arlington;
        }

        out.push({ key: g.key, tripId: g.meta.tripId, meta: g.meta, best: g.best, rowsCollapsed, rowsExpanded });
    }

    return {
        start,
        end,
        includeHome,
        alerts: alertInfo.headers,
        alertCounts: alertInfo.counts,
        alertsCountTotal: alertInfo.headers.length,
        groups: out,
        groupsAvailable: redPairs.length > 0,
        overrideOk,
    };
}
