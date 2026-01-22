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

  const tRaw = (cell.text || "").trim();
  const schedRaw = (cell.schedText || "").trim();

  // If text is missing but schedText exists, render schedText (no hover/underline).
  if (!tRaw) {
    if (schedRaw && schedRaw !== "—") return escapeHtml(schedRaw);
    return "";
  }

  // Never underline / title for dashes
  if (tRaw === "—") return "—";

  // Only predictions get underlines + tooltips (as before)
  if (!cell.pred) return escapeHtml(tRaw);

  const hasSched = schedRaw && schedRaw !== "—";
  const title = hasSched ? `Scheduled ${schedRaw}` : "No scheduled time available";
  return `<span class="predTime" title="${escapeHtml(title)}">${escapeHtml(tRaw)}</span>`;
}

const borderPairs = {
  Arlington: ["--gl-green", "--table-head-bg"],
  Park: ["--gl-green", "--rl-red"],
  Layover: ["--table-head-bg", "--rl-red"],
  Harvard: ["--bus-yellow", "--rl-red"],
  Home: ["--bus-yellow", "--table-head-bg"],
};

export function renderHeader(theadEl, includeHome) {
  const cols = includeHome
    ? ["Arlington", "Park", "Layover", "Harvard", "Home"]
    : ["Arlington", "Park", "Layover", "Harvard"];

  const header = cols
    .map((c) => {
      const pair = borderPairs[c];
      const style = pair
        ? ` style="
            background-image: linear-gradient(to bottom, var(${pair[1]}), var(${pair[1]})),
                              linear-gradient(to bottom, var(${pair[0]}), var(${pair[0]}));
            background-size: 100% 5px, 100% 5px;
            background-position: left bottom, left calc(100% - 5px);
            background-repeat: no-repeat;
            padding-bottom:10px;
          "`
        : "";

      return `<th${style}>${escapeHtml(c)}</th>`;
    })
    .join("");

  theadEl.innerHTML = `<tr>${header}</tr>`;
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
    alertsEl.innerHTML = `${lines}${more}`;
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
