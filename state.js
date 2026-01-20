// state.js
// LocalStorage is source of truth for ALL state.
// On load: apply URL params once, then remove params from URL.
// ES module

const LS_KEY = "mbta_commute_state_v1";

const DEFAULTS = {
    // core
    layoverMin: 1, // Minimum Harvard Layover (min)
    apiKey: "",
    homeStop: "",
    startOverride: "",

    // notifications (Electron-only enforced elsewhere)
    notifyMode: "disabled", // "disabled" | "silent" | "enabled"
    notifyLeadMin: 15,
    commuteStart: "16:50",
    electronReleaseUrl: "",

    // UI persistence
    selected75TripId: "", // <-- THIS is what we persist for accordion

    // notification tracking (cleared daily)
    lastNotifiedYMD: "",
    lastNotifiedTrainKey: "",
    lastNotifiedParkISO: "",
};

function safeJsonParse(s) {
    try {
        const x = JSON.parse(s);
        return x && typeof x === "object" ? x : null;
    } catch {
        return null;
    }
}

export function loadState() {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    return { ...DEFAULTS, ...(parsed || {}) };
}

// IMPORTANT: saveState merges into existing localStorage state,
// so unrelated fields (like selected75TripId) are never dropped.
export function saveState(patchOrFull) {
    const prev = loadState();
    const next =
        patchOrFull && patchOrFull.__replaceAll === true
            ? { ...DEFAULTS, ...patchOrFull, __replaceAll: undefined }
            : { ...prev, ...(patchOrFull || {}) };

    localStorage.setItem(LS_KEY, JSON.stringify(next));
    return next;
}

function setIfPresent(patch, key, val) {
    if (val == null) return;
    const s = String(val).trim();
    if (s) patch[key] = s;
}

function parseBoolParam(v) {
    const s = String(v || "").toLowerCase().trim();
    return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseIntParam(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export function applyUrlParamsAndStrip() {
    const url = new URL(window.location.href);
    const sp = url.searchParams;

    // If no params, just return current state.
    if ([...sp.keys()].length === 0) return loadState();

    const patch = {};

    // API key
    const key = sp.get("apikey") || sp.get("key");
    if (key != null) patch.apiKey = key;

    // Home stop
    const home = sp.get("home");
    if (home != null) patch.homeStop = home;

    // Start override (when "now" is)
    const start = sp.get("start");
    if (start != null) patch.startOverride = start;

    // Minimum Harvard Layover
    const mhl = sp.get("mhl") || sp.get("buffer") || sp.get("layover");
    if (mhl != null) patch.layoverMin = parseIntParam(mhl, DEFAULTS.layoverMin);

    // Notifications state (Electron-only gating handled elsewhere)
    const notify = sp.get("notify");
    if (notify != null) patch.notifyEnabled = parseBoolParam(notify);

    const lead = sp.get("lead");
    if (lead != null) patch.notifyLeadMin = parseIntParam(lead, DEFAULTS.notifyLeadMin);

    const cs = sp.get("commute");
    if (cs != null) setIfPresent(patch, "commuteStart", cs);

    const silent = sp.get("silent");
    if (silent != null) patch.notifySilent = parseBoolParam(silent);

    const rel = sp.get("release");
    if (rel != null) patch.electronReleaseUrl = rel;

    // Optional: preselect a bus trip by tripId
    const sel = sp.get("sel75");
    if (sel != null) patch.selected75TripId = sel;

    const next = saveState(patch);

    // Strip params
    url.search = "";
    window.history.replaceState({}, "", url.toString());

    return next;
}

// bind UI controls (bottom menus) to localStorage-backed state.
// onChange(nextState) always receives FULL merged state.
export function bindControls(state, onChange) {
    const els = {
        // core
        layoverMin: document.getElementById("layoverMin"),
        homeStop: document.getElementById("homeStop"),
        startOverride: document.getElementById("startOverride"),
        apiKey: document.getElementById("apiKey"),
        resetBtn: document.getElementById("resetBtn"),

        // notifications
        notifyLeadMin: document.getElementById("notifyLeadMin"),
        commuteStart: document.getElementById("commuteStart"),
        testNotify: document.getElementById("testNotify"),
    };

    function emit(patch) {
        const next = saveState(patch);
        onChange?.(next);
    }

    // Initialize values (defensive: elements may be missing)
    if (els.layoverMin) els.layoverMin.value = String(state.layoverMin ?? DEFAULTS.layoverMin);
    if (els.homeStop) els.homeStop.value = state.homeStop || "";
    if (els.startOverride) els.startOverride.value = state.startOverride || "";
    if (els.apiKey) els.apiKey.value = state.apiKey || "";

    if (els.notifyEnabled) els.notifyEnabled.checked = !!state.notifyEnabled;
    if (els.notifyLeadMin) els.notifyLeadMin.value = String(state.notifyLeadMin ?? DEFAULTS.notifyLeadMin);
    if (els.commuteStart) els.commuteStart.value = state.commuteStart || DEFAULTS.commuteStart;
    if (els.notifySilent) els.notifySilent.checked = !!state.notifySilent;

    // Listeners
    els.layoverMin?.addEventListener("change", () => {
        emit({ layoverMin: parseIntParam(els.layoverMin.value, DEFAULTS.layoverMin) });
    });

    els.homeStop?.addEventListener("change", () => emit({ homeStop: String(els.homeStop.value || "").trim() }));
    els.startOverride?.addEventListener("change", () => emit({ startOverride: String(els.startOverride.value || "").trim() }));
    els.apiKey?.addEventListener("change", () => emit({ apiKey: String(els.apiKey.value || "").trim() }));

    els.notifyLeadMin?.addEventListener("change", () => emit({ notifyLeadMin: parseIntParam(els.notifyLeadMin.value, DEFAULTS.notifyLeadMin) }));
    els.commuteStart?.addEventListener("change", () => emit({ commuteStart: String(els.commuteStart.value || "").trim() }));

    const nm = document.querySelectorAll('input[name="notifyMode"]');
    function setNotifyModeUI(mode) {
        const v = mode || "disabled";
        for (const r of nm) r.checked = (r.value === v);
    }

    // init
    setNotifyModeUI(state.notifyMode);

    // update state on change
    for (const r of nm) {
        r.addEventListener("change", () => {
            if (r.checked) emit({ notifyMode: r.value });
        });
    }
    renderStartChips({ state, emit });

    els.resetBtn?.addEventListener("click", () => {
        const next = saveState({ ...DEFAULTS, __replaceAll: true });
        onChange?.(next);
    });

    return els;
}
function fmt2(n) { return String(n).padStart(2, "0"); }

function formatStartOverride(d) {
  // YYYY/MM/DD HH:MM
  return `${d.getFullYear()}/${fmt2(d.getMonth() + 1)}/${fmt2(d.getDate())} ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}

function parseHHMMToday(hhmm, baseDate = new Date()) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const d = new Date(baseDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function renderStartChips({ emit, getState }) {
  const host = document.getElementById("startChips");
  if (!host) return;

  const mk = (label, patchFn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;

    b.addEventListener("click", () => {
      const patch = patchFn();
      if (!patch) return;

      // 1) update state via your existing pipeline
      emit(patch);

      // 2) after emit finishes its synchronous work + any immediate rerender,
      // force the textbox to reflect the *actual current state*.
      setTimeout(() => {
        const s = getState ? getState() : null;
        const v = s?.startOverride ?? patch.startOverride ?? "";
        const inp = document.getElementById("startOverride");
        if (inp) inp.value = v || "";
      }, 0);
    });

    return b;
  };

  host.innerHTML = "";
  host.append(
    mk("Now", () => ({ startOverride: formatStartOverride(new Date()) })),
    mk("16:50", () => {
      const d = parseHHMMToday("16:50");
      return d ? { startOverride: formatStartOverride(d) } : null;
    }),
    mk("17:10", () => {
      const d = parseHHMMToday("17:10");
      return d ? { startOverride: formatStartOverride(d) } : null;
    }),
    mk("Clear", () => ({ startOverride: "" }))
  );
}
