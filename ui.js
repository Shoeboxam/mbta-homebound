// ui.js
// Render table + predicted underlines + accordion animation + updated line helpers.
// Tooltips: never show dash-times. If scheduled time missing, show "No scheduled time available".
// ES module

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// cell: {text, pred, schedText} or string
export function renderTimeCell(cell) {
  if (cell == null) return "";
  if (typeof cell === "string") return escapeHtml(cell);

  const t = cell.text || "";
  if (!cell.pred || !t || t === "—") return escapeHtml(t);

  const sched = (cell.schedText || "").trim();
  const hasSched = sched && sched !== "—";

  const title = hasSched ? `Scheduled ${sched}` : "No scheduled time available";
  return `<span class="predTime" title="${escapeHtml(title)}">${escapeHtml(t)}</span>`;
}

export function renderHeader(theadEl, includeHome) {
  const cols = includeHome
    ? ["Arlington", "Park", "Layover", "Harvard", "Home"]
    : ["Arlington", "Park", "Layover", "Harvard"];
  theadEl.innerHTML = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
}

export function renderAlerts(alertsEl, headers, counts) {
  if (!headers?.length) {
    alertsEl.hidden = true;
    alertsEl.innerHTML = "";
    return;
  }
  const lines = headers.slice(0, 6).map((h) => `<div class="line">${escapeHtml(h)}</div>`).join("");
  const more = headers.length > 6 ? `<div class="line">…and ${headers.length - 6} more</div>` : "";
  alertsEl.hidden = false;
  alertsEl.innerHTML = `<div class="title">Service alert</div>${lines}${more}`;
}

export function renderTableBody(tbodyEl, groups, includeHome, expandedTripId) {
  const trs = [];

  for (const g of groups) {
    const isExpanded = expandedTripId && expandedTripId === g.tripId;
    const rows = isExpanded ? g.rowsExpanded : [g.rowsCollapsed];

    for (const r of rows) {
      const classes = ["clickable"];
      if (!r.bestRow) classes.push("nonBest");

      const tds = [
        `<td>${renderTimeCell(r.arlington)}</td>`,
        `<td>${renderTimeCell(r.park)}</td>`,
        `<td>${escapeHtml(r.layover || "")}</td>`,
        `<td>${renderTimeCell(r.harvard)}</td>`,
      ];
      if (includeHome) tds.push(`<td>${renderTimeCell(r.home)}</td>`);

      // IMPORTANT: data-tripid (stable), not data-gkey (unstable due to dep time shifts)
      trs.push(
        `<tr class="${classes.join(" ")}" data-tripid="${escapeHtml(g.tripId)}">${tds.join("")}</tr>`
      );
    }
  }

  tbodyEl.innerHTML = trs.join("");
}

export function wireAccordion(tbodyEl, tableWrapEl, getExpandedTripId, setExpandedTripId, onAfterToggle) {
  tbodyEl.onclick = (evt) => {
    const tr = evt.target.closest("tr");
    if (!tr) return;

    const tripId = tr.getAttribute("data-tripid");
    if (!tripId) return;

    const prev = getExpandedTripId() || "";
    const next = prev === tripId ? "" : tripId; // accordion: open one, collapse others

    const h0 = tableWrapEl.getBoundingClientRect().height;

    setExpandedTripId(next);
    onAfterToggle?.();

    const h1 = tableWrapEl.getBoundingClientRect().height;

    try {
      tableWrapEl.animate([{ height: `${h0}px` }, { height: `${h1}px` }], {
        duration: 180,
        easing: "ease-out",
      });
    } catch {
      // ignore
    }
  };
}


// Updated line UI
export function setUpdatedLine(updatedWrapEl, updatedAgoEl, simTimeEl, opts) {
  const { lastSuccessMs, isRefreshing, startOverride } = opts;

  if (lastSuccessMs == null) {
    updatedWrapEl.hidden = true;
    return;
  }

  const sec = Math.max(0, Math.floor((Date.now() - lastSuccessMs) / 1000));
  updatedWrapEl.hidden = false;

  updatedAgoEl.textContent = `Updated ${sec} seconds ago.`;
  updatedAgoEl.classList.toggle("stale", sec > 90);
  updatedAgoEl.classList.toggle("refreshing", !!isRefreshing);

  const sim = (startOverride || "").trim();
  if (sim) {
    simTimeEl.hidden = false;
    simTimeEl.textContent = `Simulating time: ${sim}`;
  } else {
    simTimeEl.hidden = true;
    simTimeEl.textContent = "";
  }

  return sec;
}
