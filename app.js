// app.js
// Orchestration + refresh loop + state-change routing.
// ES module

import { applyUrlParamsAndStrip, bindControls, loadState, saveState } from "./state.js";
import { buildGroupsForWindow, fmtHHMM } from "./planner.js";
import {
    renderHeader,
    renderAlerts,
    renderTableBody,
    wireAccordion,
    setUpdatedLine,
} from "./ui.js";
import {
    isElectron,
    isMobile,
    clearNotifyTrackingIfNotToday,
    formatSuppressedReasons,
    scheduleBestNotification,
    sendTestNotification,
    ensurePermission,
    formatAlertText,
    computeFireAt,
} from "./notify.js";



const CFG = {
    hours: 3,

    visibleMs: 60_000,
    hiddenMs: 120_000,

    predWindowMin: 120,
    materialChangeMin: 3,

    redRoute: "Red",
    busRoute: "75",
    greenRoutes: ["Green-B", "Green-C", "Green-D", "Green-E"],

    park: "place-pktrm",
    harvard: "place-harsq",
    arlington: "place-armnl",
};

const el = {
    alerts: document.getElementById("alerts"),
    loading: document.getElementById("loading"),
    errorBox: document.getElementById("errorBox"),
    tableWrap: document.getElementById("tableWrap"),
    tbl: document.getElementById("tbl"),
    thead: document.getElementById("thead"),
    tbody: document.getElementById("tbody"),
    updatedWrap: document.getElementById("updatedWrap"),
    updatedAgo: document.getElementById("updatedAgo"),
    simTime: document.getElementById("simTime"),

    // Notifications UI bits (exist in HTML; some may be hidden)
    notifyDetails: document.getElementById("notifyDetails"),
    notifyEnableRow: document.getElementById("notifyEnableRow"),
    electronHint: document.getElementById("electronHint"),
    notifySuppressed: document.getElementById("notifySuppressed"),
    nextNotifyLine: document.getElementById("nextNotifyLine"),
    bgNote: document.getElementById("bgNote"),
    homeHint: document.getElementById("homeHint"),
};

let state = applyUrlParamsAndStrip();
let controls = null;

let lastPlan = null;

let hasRenderedOnce = false;
let lastSuccessMs = null;
let updatedTimer = null;
let refreshTimer = null;
let notifyTimer = null;

let isRefreshing = false;
let lastNotifRef = null;

/* ---------------- UI mode helpers ---------------- */

function showMode(mode) {
    const set = (node, on, displayOn) => {
        if (!node) return;
        node.hidden = !on;
        node.style.display = on ? displayOn : "none";
    };
    set(el.loading, mode === "loading", "flex");
    set(el.tbl, mode === "table", "table");
    set(el.errorBox, mode === "error", "block");
}

function clearError() {
    if (!el.errorBox) return;
    el.errorBox.innerHTML = "";
    el.errorBox.hidden = true;
    el.errorBox.style.display = "none";
}

function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function showError(userMsg, err) {
    const detail = err ? (err.stack || String(err)) : "";
    el.errorBox.innerHTML = `
    <div class="msg">${escapeHtml(userMsg)}</div>
    ${detail ? `<details><summary>Details</summary><pre>${escapeHtml(detail)}</pre></details>` : ""}
  `;
    showMode("error");

    // Still bubble to console + throw async for debugging
    console.error(err);
    setTimeout(() => {
        throw err;
    }, 0);
}

/* ---------------- timers ---------------- */

function clearRefreshTimer() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
}

function clearNotifyTimer() {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
}

function clearUpdatedTimer() {
    if (updatedTimer) clearInterval(updatedTimer);
    updatedTimer = null;
}

function setNextNotifyLine(text) {
    if (!el.nextNotifyLine) return;
    if (!text) {
        el.nextNotifyLine.hidden = true;
        el.nextNotifyLine.textContent = "";
    } else {
        el.nextNotifyLine.hidden = false;
        el.nextNotifyLine.textContent = text;
    }
}

function setLastNotificationRef(n) {
    lastNotifRef = n || null;
}

function clearLastNotificationRef() {
    try {
        lastNotifRef?.close?.();
    } catch { }
    lastNotifRef = null;
}

/* ---------------- notification UI gating ---------------- */

function syncNotifyUiAvailability() {
    const inElec = isElectron();
    const mobile = isMobile();

    const details = document.getElementById("notifyDetails");
    const elOnly = document.getElementById("notifyElectronOnly");

    // 1) The whole Notifications spoiler should exist on desktop web + Electron.
    // Only hide it on mobile.
    if (details) details.hidden = mobile;

    // 2) Inside the spoiler:
    // - Electron: show all controls
    // - Web: show ONLY the download hint
    if (elOnly) elOnly.hidden = !(inElec && !mobile);

    if (el?.electronHint) {
        el.electronHint.hidden = (inElec && !mobile);
        if (!(inElec && !mobile) && !mobile) {
            const url =
                (state.electronReleaseUrl || "").trim() ||
                "https://github.com/YOUR_OWNER/YOUR_REPO/releases/latest";
            el.electronHint.innerHTML =
                `Notifications require the desktop app. <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Download the latest release</a>.`;
        } else {
            el.electronHint.textContent = "";
        }
    }

    // 3) In Electron, keep everything visible + editable at all times.
    if (inElec && !mobile) {
        document.getElementById("notifyConfig") && (document.getElementById("notifyConfig").hidden = false);
        document.getElementById("notifyExampleRow") && (document.getElementById("notifyExampleRow").hidden = false);
        document.getElementById("bgNote") && (document.getElementById("bgNote").hidden = false);

        if (controls?.notifyLeadMin) controls.notifyLeadMin.disabled = false;
        if (controls?.commuteStart) controls.commuteStart.disabled = false;
        if (controls?.testNotify) controls.testNotify.disabled = false;
    }
}


/* ---------------- updated line ---------------- */

function startUpdatedTicker() {
    clearUpdatedTimer();
    updatedTimer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        setUpdatedLine(el.updatedWrap, el.updatedAgo, el.simTime, {
            lastSuccessMs,
            isRefreshing,
            startOverride: state.startOverride,
        });
    }, 1000);
}

/* ---------------- render ---------------- */

// app.js — full updated renderPlan(plan)
function renderPlan(plan) {
    lastPlan = plan;

    // If the saved selection no longer exists in the window, clear it.
    const sel = (state.selected75TripId || "").trim();
    if (sel && !plan.groups.some((g) => g.tripId === sel)) {
        const s = loadState();
        s.selected75TripId = "";
        saveState(s);
        state = s;
    }

    renderHeader(el.thead, plan.includeHome);
    renderAlerts(el.alerts, plan.alerts, plan.alertCounts);

    const expandedTripId = (state.selected75TripId || "").trim();
    renderTableBody(el.tbody, plan.groups, plan.includeHome, expandedTripId);

    wireAccordion(
        el.tbody,
        el.tableWrap,
        () => (state.selected75TripId || "").trim(),
        (tripId) => {
            // Persist selection without triggering data refresh
            const s = loadState();
            s.selected75TripId = tripId || "";
            saveState(s);
            state = s;
        },
        () => {
            renderTableBody(
                el.tbody,
                plan.groups,
                plan.includeHome,
                (state.selected75TripId || "").trim()
            );
        }
    );

    // --- Example message + dynamic title ---
    const best = plan.groups?.find((g) => g?.rowsCollapsed?.bestRow);
    const park = best?.meta?.parkBestDate instanceof Date ? best.meta.parkBestDate : null;

    const alertText = formatAlertText(plan?.alertCounts);
    const exampleText = park
        ? `Park ${fmtHHMM(park)} arrival. ${alertText}`
        : `Park --:-- arrival. ${alertText}`;

    const exEl = document.getElementById("notifyExampleText");
    if (exEl) exEl.textContent = exampleText;

    const titleEl = document.getElementById("notifyExampleLabel");
    if (titleEl) {
        const info = formatSuppressedReasons({ state, plan, cfg: CFG, includeCountsLine: false });
        if (info.active && park instanceof Date && !isNaN(park)) {
            const fireAt = computeFireAt(state, park);
            titleEl.textContent = `Upcoming ${fmtHHMM(fireAt)} notification`;
        } else {
            titleEl.textContent = "Example notification";
        }
    }

    if (el.notifySuppressed) {
        const info = formatSuppressedReasons({ state, plan, cfg: CFG, includeCountsLine: false });

        if (info.active) {
            el.notifySuppressed.innerHTML = "";
            el.notifySuppressed.hidden = true;
        } else {
            el.notifySuppressed.hidden = false;

            const reasons = (info.reasons || []).filter(Boolean);
            const lis = reasons.map((r) => escapeHtml(r)).join(", ");

            el.notifySuppressed.innerHTML = `<div class="label">Not sending because: ${lis}</div>`;
        }
    }
}


/* ---------------- refresh loop ---------------- */

function scheduleNextRefresh() {
    clearRefreshTimer();

    const visible = document.visibilityState === "visible";

    // If visible: always refresh periodically (>=1 minute).
    if (visible) {
        refreshTimer = setTimeout(async () => {
            await refresh();
            scheduleNextRefresh();
        }, CFG.visibleMs);
        return;
    }

    // If hidden: only do background work in Electron when notifications enabled + within commute window.
    const allowHidden =
        isElectron() &&
        !isMobile() &&
        !!state.notifyEnabled &&
        (() => {
            // use notify.js commute window logic indirectly via formatSuppressedReasons
            const info = formatSuppressedReasons({ state, plan: lastPlan, cfg: CFG, includeCountsLine: false });
            return info.active || (isElectron() && state.notifyEnabled); // keep minimal background refresh while enabled
        })();

    if (!allowHidden) return;

    refreshTimer = setTimeout(async () => {
        await refresh();
        scheduleNextRefresh();
    }, CFG.hiddenMs);
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
    scheduleNextRefresh();
});

/* ---------------- notification scheduling ---------------- */

async function rescheduleNotificationIfNeeded() {
    clearNotifyTimer();
    clearLastNotificationRef();
    setNextNotifyLine("");

    syncNotifyUiAvailability();

    if (!isElectron() || isMobile()) return;
    if (!state.notifyEnabled) return;
    if (!("Notification" in window)) return;

    clearNotifyTrackingIfNotToday(state, saveState, loadState);

    // Ensure permission if user is trying to enable notifications (don't pop permission dialogs on web)
    if (Notification.permission === "default") {
        // Only request on explicit enable or test button; do nothing here.
    }

    if (Notification.permission !== "granted") return;
    if (!lastPlan) return;

    notifyTimer = scheduleBestNotification({
        state,
        cfg: CFG,
        plan: lastPlan,
        loadState,
        saveState,
        setNextNotifyLine,
        setLastNotificationRef,
        clearLastNotificationRef,
    });
}

/* ---------------- main refresh ---------------- */

async function refresh() {
    isRefreshing = true;
    setUpdatedLine(el.updatedWrap, el.updatedAgo, el.simTime, {
        lastSuccessMs,
        isRefreshing,
        startOverride: state.startOverride,
    });

    clearError();
    if (!hasRenderedOnce) showMode("loading");

    try {
        const plan = await buildGroupsForWindow(state, CFG);

        const sel = (state.selected75TripId || "").trim();
        if (sel && !plan.groups.some(g => g.tripId === sel)) {
            state = saveState({ ...loadState(), selected75TripId: "" });
        }


        showMode("table");
        renderPlan(plan);

        hasRenderedOnce = true;
        lastSuccessMs = Date.now();
        startUpdatedTicker();

        setUpdatedLine(el.updatedWrap, el.updatedAgo, el.simTime, {
            lastSuccessMs,
            isRefreshing: false,
            startOverride: state.startOverride,
        });

        await rescheduleNotificationIfNeeded();
    } catch (err) {
        const msg =
            String(err?.message || "").includes("429")
                ? "Rate limited by MBTA (429). Retrying automatically…"
                : String(err?.message || "").includes("Failed to fetch")
                    ? "Network error reaching MBTA. Retrying automatically…"
                    : "Could not load MBTA data. Retrying automatically…";

        showError(msg, err);

        // If error, error box replaces spinner; keep stale updated line if we had one.
        syncNotifyUiAvailability();
        setNextNotifyLine("");
    } finally {
        isRefreshing = false;
        setUpdatedLine(el.updatedWrap, el.updatedAgo, el.simTime, {
            lastSuccessMs,
            isRefreshing,
            startOverride: state.startOverride,
        });
    }
}

/* ---------------- state routing ---------------- */

function onStateChange(next) {
    const prev = state;
    state = next;

    // Sync UI availability first (important for web vs electron).
    syncNotifyUiAvailability();

    // Decide whether data refresh is needed
    const dataKeys = ["layoverMin", "apiKey", "homeStop", "startOverride"];
    const needsDataRefresh = dataKeys.some((k) => String(prev[k] ?? "") !== String(state[k] ?? ""));

    const notifyKeys = ["notifyMode", "notifyLeadMin", "commuteStart", "electronReleaseUrl"];
    const notifyChanged = notifyKeys.some((k) => String(prev[k] ?? "") !== String(state[k] ?? ""));

    if (needsDataRefresh) {
        refresh();
    } else if (notifyChanged) {
        scheduleNextRefresh();

        Promise.resolve(rescheduleNotificationIfNeeded())
            .catch(() => { }) // reschedule already handles UI; don't break state changes
            .finally(() => {
                // Redraw after reschedule so suppressed/example reflect newest state
                if (lastPlan) renderPlan(lastPlan);
            });
    }

}

/* ---------------- init ---------------- */

function init() {
    // source of truth: localStorage
    state = loadState();
    controls = bindControls(state, onStateChange);

    syncNotifyUiAvailability();

    // updated line click-to-refresh (if >=1 second)
    if (el.updatedWrap) {
        el.updatedWrap.addEventListener("click", () => {
            if (lastSuccessMs == null) return;
            const sec = Math.max(0, Math.floor((Date.now() - lastSuccessMs) / 1000));
            if (sec >= 1) refresh();
        });
    }

    // test notification button (Electron only)
    if (controls?.testNotify) {
        controls.testNotify.addEventListener("click", async () => {
            if (!isElectron() || isMobile()) return;

            const ok = await ensurePermission();
            if (!ok) return;

            await sendTestNotification({ state, cfg: CFG, plan: lastPlan });
            await rescheduleNotificationIfNeeded();

            // Redraw so suppressed/example text reflects any permission/state changes
            if (lastPlan) renderPlan(lastPlan);
        });
    }


    // If user checks enable in Electron, request permission once.
    if (controls?.notifyEnabled) {
        controls.notifyEnabled.addEventListener("change", async () => {
            if (!isElectron() || isMobile()) return;
            if (controls.notifyEnabled.checked) await ensurePermission();
            // state.js will emit the change; we just ensure permission.
        });
    }

    showMode("loading");
    refresh();
    scheduleNextRefresh();
}

init();
