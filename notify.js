// notify.js
// Electron-only notifications (uses “best” row meta from planner output).
// ES module

import { fmtHHMM, getNow } from "./planner.js";

export function isElectron() {
  return !!(window.process?.versions?.electron) || /Electron/i.test(navigator.userAgent || "");
}

export function isMobile() {
  const ud = navigator.userAgentData;
  if (ud && typeof ud.mobile === "boolean") return ud.mobile;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

export function formatAlertText(counts) {
  const c = counts || { green: 0, red: 0, bus: 0 };
  const parts = [];
  if (c.green > 0) parts.push(`${c.green} Green`);
  if (c.red > 0) parts.push(`${c.red} Red`);
  if (c.bus > 0) parts.push(`${c.bus} 75`);
  return parts.length ? `Alerts: ${parts.join(", ")}` : "No alerts.";
}

export function isWeekday(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseHHMMToday(hhmm, baseDate) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]),
    mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const d = new Date(baseDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

export function inCommuteWindow(state, now, hours = 3) {
  const start = parseHHMMToday(state.commuteStart, now);
  if (!start) return false;
  const end = new Date(start.getTime() + hours * 3600 * 1000);
  return now >= start && now <= end;
}

export function canOfferNotificationsUI() {
  // Don't show notifications at all on mobile
  return !isMobile();
}

/**
 * Three-way mode:
 *  - "disabled": notifications off
 *  - "silent":   notifications on, Notification({silent:true})
 *  - "enabled":  notifications on, normal sound/vibration (OS controlled)
 */
export function notifyMode(state) {
  const m = String(state?.notifyMode || "disabled").toLowerCase();
  if (m === "silent" || m === "enabled") return m;
  return "disabled";
}

export function notificationsEnabled(state) {
  return notifyMode(state) !== "disabled";
}

export function notificationsSilent(state) {
  return notifyMode(state) === "silent";
}

export function canEnableNotifications(state, now, hours = 3) {
  // Only allow inside Electron, only on weekdays, and only within commute window.
  if (!isElectron()) return false;
  if (isMobile()) return false;
  if (!notificationsEnabled(state)) return false;
  if (!isWeekday(now)) return false;
  if (!inCommuteWindow(state, now, hours)) return false;
  if (!("Notification" in window)) return false;
  return true;
}

export async function ensurePermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

export function clearNotifyTrackingIfNotToday(state, saveState, loadState) {
  const now = getNow(state);
  const today = ymdLocal(now);

  const s = loadState();
  if ((s.lastNotifiedYMD || "") !== today) {
    saveState({
      ...s,
      lastNotifiedYMD: today,
      lastNotifiedTrainKey: "",
      lastNotifiedParkISO: "",
    });
  }
}

// Finds the best group (collapsed row is bestRow).
export function getBestGroup(plan) {
  return plan?.groups?.find((g) => g?.rowsCollapsed?.bestRow);
}

export function formatSuppressedReasons({ state, plan, cfg, includeCountsLine = true }) {
  const now = getNow(state);
  const reasons = [];

  if (isMobile()) reasons.push("Mobile: notifications not available.");
  if (!isElectron()) reasons.push("Desktop app required for notifications.");

  if (isElectron()) {
    if (!notificationsEnabled(state)) reasons.push("Notifications are off.");
    if (notificationsEnabled(state) && !isWeekday(now)) reasons.push("Weekends: notifications suppressed.");
    if (notificationsEnabled(state) && isWeekday(now) && !inCommuteWindow(state, now, cfg.hours))
      reasons.push("Outside commute window.");
    if (notificationsEnabled(state) && ("Notification" in window)) {
      if (Notification.permission === "denied") reasons.push("Permission denied in system/browser settings.");
      if (Notification.permission === "default") reasons.push("Permission not granted yet (use Test notification).");
    }
    if (notificationsEnabled(state) && plan && plan.groupsAvailable === false)
      reasons.push("No upcoming trains found in this window.");
  }

  const counts = plan?.alertCounts;
  const countLine =
    includeCountsLine && counts ? `Alerts: Green ${counts.green}, Red ${counts.red}, 75 ${counts.bus}.` : "";

  const active =
    canEnableNotifications(state, now, cfg.hours) &&
    ("Notification" in window) &&
    Notification.permission === "granted" &&
    plan?.groupsAvailable !== false &&
    !!getBestGroup(plan);

  return { active, countLine, reasons };
}

/* ---------------- Scheduling ---------------- */

export function computeFireAt(state, parkBestDate) {
  const leadMin = Math.max(0, Number(state.notifyLeadMin || 0));
  return new Date(parkBestDate.getTime() - leadMin * 60_000);
}

export function shouldSuppressRepeat({ state, loadState, bestGroup, cfg }) {
  // "Nudge only if still best": if she got a heads-up, don't re-notify unless plan changes materially.
  const s = loadState();
  const prevISO = s.lastNotifiedParkISO || "";
  const prevPark = prevISO ? new Date(prevISO) : null;

  if (!prevPark || isNaN(prevPark)) return false;

  const prevPassed = Date.now() >= prevPark.getTime();
  if (prevPassed) return false;

  const park = bestGroup?.meta?.parkBestDate;
  if (!(park instanceof Date) || isNaN(park)) return false;

  const deltaMin = Math.abs(Math.round((park - prevPark) / 60000));
  return deltaMin < cfg.materialChangeMin;
}

export function buildTrainKey(state, bestGroup) {
  const now = getNow(state);
  const ymd = ymdLocal(now);
  const park = bestGroup?.meta?.parkBestDate;
  const parkISO = park instanceof Date ? park.toISOString() : "";
  return `${ymd}|${bestGroup.key}|${parkISO}`;
}

export function showNotification({ state, title, body, url }) {
  // Best effort close after 5 minutes; clicking focuses and navigates to page.
  try {
    const n = new Notification(title, { body, silent: notificationsSilent(state) });
    n.onclick = () => {
      try {
        window.focus();
      } catch {}
      if (url) {
        try {
          window.location.href = url;
        } catch {}
      }
    };
    setTimeout(() => {
      try {
        n.close();
      } catch {}
    }, 5 * 60_000);
    return n;
  } catch {
    alert(body);
    return null;
  }
}

export function scheduleBestNotification({
  state,
  cfg,
  plan,
  loadState,
  saveState,
  setNextNotifyLine,
  setLastNotificationRef,
  clearLastNotificationRef,
}) {
  // returns timeout id or null
  const now = getNow(state);
  if (!canEnableNotifications(state, now, cfg.hours)) {
    setNextNotifyLine?.("");
    return null;
  }
  if (Notification.permission !== "granted") {
    setNextNotifyLine?.("");
    return null;
  }

  const best = getBestGroup(plan);
  if (!best) {
    setNextNotifyLine?.("");
    return null;
  }

  const park = best.meta?.parkBestDate;
  if (!(park instanceof Date) || isNaN(park)) {
    setNextNotifyLine?.("");
    return null;
  }
  if (Date.now() >= park.getTime()) {
    setNextNotifyLine?.("");
    return null;
  }

  // One per train key (per day)
  const key = buildTrainKey(state, best);
  const s = loadState();
  if ((s.lastNotifiedTrainKey || "") === key) {
    setNextNotifyLine?.("");
    return null;
  }

  const fireAt = computeFireAt(state, park);
  const delay = fireAt.getTime() - Date.now();

  const run = () => {
    const now2 = getNow(state);
    if (!canEnableNotifications(state, now2, cfg.hours)) return;
    if (Notification.permission !== "granted") return;

    // Re-check still best + still not passed
    const best2 = getBestGroup(plan);
    if (!best2) return;

    const park2 = best2.meta?.parkBestDate;
    if (!(park2 instanceof Date) || isNaN(park2) || Date.now() >= park2.getTime()) return;

    // Suppress repeat again if plan didn't materially change
    if (shouldSuppressRepeat({ state, loadState, bestGroup: best2, cfg })) return;

    // Close last if any
    clearLastNotificationRef?.();

    const alertText = formatAlertText(plan?.alertCounts);
    const body = `Park ${fmtHHMM(park2)} arrival. ${alertText}`;

    const n = showNotification({
      state,
      title: "Commute",
      body,
      url: window.location.href,
    });
    setLastNotificationRef?.(n);

    // Persist tracking
    const nowDay = ymdLocal(getNow(state));
    saveState({
      ...loadState(),
      lastNotifiedYMD: nowDay,
      lastNotifiedTrainKey: buildTrainKey(state, best2),
      lastNotifiedParkISO: park2.toISOString(),
    });

    setNextNotifyLine?.("");
  };

  if (delay <= 0) {
    run();
    return null;
  }
  return setTimeout(run, delay);
}

export async function sendTestNotification({ state, cfg, plan }) {
  if (!isElectron() || isMobile()) return;

  if (!("Notification" in window)) {
    alert("Notifications not supported here.");
    return;
  }

  const ok = await ensurePermission();
  if (!ok) {
    alert("Notification permission not granted.");
    return;
  }

  // Representative: use current best Park arrival if available
  const best = getBestGroup(plan);
  const park =
    best?.meta?.parkBestDate instanceof Date && !isNaN(best.meta.parkBestDate)
      ? best.meta.parkBestDate
      : getNow(state);

  const alertText = formatAlertText(plan?.alertCounts);
  const body = `Park ${fmtHHMM(park)} arrival. ${alertText}`;

  showNotification({
    state,
    title: "Commute",
    body,
    url: window.location.href,
  });
}
