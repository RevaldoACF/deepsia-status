const REPO_OWNER = "RevaldoACF";
const REPO_NAME = "deepsia-status";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const ISSUES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all&per_page=30`;
const RUNS_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/uptime.yml/runs?per_page=1&status=completed`;
const HISTORY_DAYS = 60;

const SERVICES = [
  { slug: "api", name: "API" },
  { slug: "chat", name: "Benthos" },
];

let windowOffset = 0;
let cachedServicesState = [];
let cachedIssues = [];

/**
 * Parse simple Upptime flat YAML key-value files.
 */
function parseSimpleYaml(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

/**
 * Fetch local file first, falling back to raw GitHub content.
 */
async function fetchWithFallback(path, parseAs = "json") {
  const urls = [`./${path}`, `${RAW_BASE}/${path}`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      return parseAs === "json" ? await res.json() : await res.text();
    } catch {
      // Try fallback URL
    }
  }
  return null;
}

function toUtcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function formatShortDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatMonthYear(date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return "";
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs} hrs ${mins} mins`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return "Recently";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Recently";

  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return "Updated just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `Updated ${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `Updated ${diffHr}h ago`;
  return `Updated ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function classifyIssue(issue) {
  const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
  const titleLower = (issue.title || "").toLowerCase();

  if (labels.includes("maintenance") || titleLower.includes("maintenance")) {
    return "maintenance";
  }
  if (
    labels.includes("status") ||
    labels.includes("incident") ||
    labels.includes("down")
  ) {
    return "down";
  }
  return null;
}

function parseIssueMetadata(issue) {
  const body = issue.body || "";
  const affectedMatch = body.match(/<!--\s*affected:\s*([^>]+?)\s*-->/i);
  const startMatch = body.match(/<!--\s*start:\s*([^>]+?)\s*-->/i);
  const endMatch = body.match(/<!--\s*end:\s*([^>]+?)\s*-->/i);

  const affected = affectedMatch
    ? affectedMatch[1]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const cleanBody = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .trim();

  return {
    affected,
    start: startMatch ? startMatch[1].trim() : null,
    end: endMatch ? endMatch[1].trim() : null,
    cleanBody,
  };
}

function issueAffectsService(issue, slug, name) {
  const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
  const serviceLabels = labels.filter((l) =>
    SERVICES.some((s) => s.slug === l)
  );
  const { affected } = parseIssueMetadata(issue);

  if (affected) {
    return affected.includes(slug) || affected.includes("all");
  }

  if (serviceLabels.length > 0) {
    return serviceLabels.includes(slug);
  }

  const title = (issue.title || "").toLowerCase();
  if (slug === "api") {
    return /\bapi\b/.test(title) || title.includes("api.deepsia.my.id");
  }
  if (slug === "chat") {
    return (
      /\b(chat|benthos|deepchat)\b/.test(title) || title.includes("chat.deepsia.my.id")
    );
  }
  return title.includes(name.toLowerCase());
}

function issueActiveOnDate(issue, dateKey) {
  const startKey = issue.created_at?.slice(0, 10);
  const endKey =
    issue.state === "closed" && issue.closed_at
      ? issue.closed_at.slice(0, 10)
      : toUtcDateKey(new Date());
  return Boolean(startKey && dateKey >= startKey && dateKey <= endKey);
}

function showPopover(target, info) {
  const popover = document.getElementById("bar-popover");
  const dateEl = document.getElementById("popover-date");
  const boxEl = document.getElementById("popover-status-box");
  const statusEl = document.getElementById("popover-status-text");
  const durationEl = document.getElementById("popover-duration");
  const relatedWrap = document.getElementById("popover-related");
  const relatedList = document.getElementById("popover-related-list");

  if (!popover || !dateEl || !boxEl || !statusEl || !durationEl) return;

  dateEl.textContent = info.labelDate;
  boxEl.dataset.state = info.barState;
  statusEl.textContent = info.statusLabel;
  durationEl.textContent = info.durationText || "";

  if (relatedWrap && relatedList) {
    relatedList.innerHTML = "";
    if (info.relatedTitles.length > 0) {
      for (const title of info.relatedTitles) {
        const li = document.createElement("li");
        li.textContent = title;
        relatedList.appendChild(li);
      }
      relatedWrap.hidden = false;
    } else {
      relatedWrap.hidden = true;
    }
  }

  popover.hidden = false;

  const rect = target.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  const centerX = rect.left + rect.width / 2;
  const clampedLeft = Math.max(
    margin,
    Math.min(centerX - popRect.width / 2, window.innerWidth - popRect.width - margin)
  );
  const arrowX = Math.max(16, Math.min(centerX - clampedLeft, popRect.width - 16));

  popover.style.left = `${clampedLeft}px`;
  popover.style.top = `${rect.bottom + 10}px`;
  popover.style.setProperty("--arrow-x", `${arrowX}px`);
}

function hidePopover() {
  const popover = document.getElementById("bar-popover");
  if (popover) popover.hidden = true;
}

function getWindowDates(offsetWindows) {
  const now = new Date();
  const endOffsetDays = offsetWindows * HISTORY_DAYS;
  const endDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - endOffsetDays
    )
  );
  const startDate = new Date(
    Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate() - (HISTORY_DAYS - 1)
    )
  );
  return { startDate, endDate };
}

function updateRangeControls() {
  const { startDate, endDate } = getWindowDates(windowOffset);
  const rangeLabel = document.getElementById("range-label");
  const nextBtn = document.getElementById("range-next");
  if (rangeLabel) {
    rangeLabel.textContent = `${formatMonthYear(startDate)} – ${formatMonthYear(endDate)}`;
  }
  if (nextBtn) {
    nextBtn.disabled = windowOffset === 0;
  }
}

function renderServiceBars({
  slug,
  name,
  startDateKey,
  dailyMinutesDown,
  currentState,
  issues,
}) {
  const row = document.querySelector(`.service-row[data-slug="${slug}"]`);
  const container = row?.querySelector("[data-bars]");
  const legendStart = row?.querySelector(".uptime-legend span:first-child");
  const legendEnd = row?.querySelector(".uptime-legend span:last-child");
  if (!container) return;

  container.innerHTML = "";
  const { startDate, endDate } = getWindowDates(windowOffset);
  const todayKey = toUtcDateKey(new Date());

  if (legendStart) {
    legendStart.textContent =
      windowOffset === 0 ? "60 days ago" : formatShortDate(toUtcDateKey(startDate));
  }
  if (legendEnd) {
    legendEnd.textContent =
      windowOffset === 0 ? "Today" : formatShortDate(toUtcDateKey(endDate));
  }

  const serviceIssues = (issues || []).filter(
    (i) =>
      !i.pull_request &&
      classifyIssue(i) !== null &&
      issueAffectsService(i, slug, name)
  );

  for (let i = 0; i < HISTORY_DAYS; i++) {
    const d = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i
      )
    );
    const dateKey = toUtcDateKey(d);
    const labelDate = formatShortDate(dateKey);

    let barState = "none";
    let statusLabel = "No data";
    let durationText = "";
    let relatedTitles = [];

    if (startDateKey && dateKey >= startDateKey) {
      const minutesDown = Number(dailyMinutesDown?.[dateKey] || 0);
      const dayIssues = serviceIssues.filter((issue) =>
        issueActiveOnDate(issue, dateKey)
      );
      relatedTitles = dayIssues.map((issue) => issue.title);
      const hasMaint = dayIssues.some(
        (issue) => classifyIssue(issue) === "maintenance"
      );

      if (dateKey === todayKey && currentState === "down") {
        barState = "down";
        statusLabel = "Major outage";
        durationText = formatDuration(minutesDown);
      } else if (dateKey === todayKey && currentState === "maintenance") {
        barState = "maintenance";
        statusLabel = "Maintenance";
      } else if (minutesDown >= 30) {
        barState = "down";
        statusLabel = "Major outage";
        durationText = formatDuration(minutesDown);
      } else if (minutesDown > 0) {
        barState = "degraded";
        statusLabel = "Partial outage";
        durationText = formatDuration(minutesDown);
      } else if (hasMaint) {
        barState = "maintenance";
        statusLabel = "Maintenance";
      } else {
        barState = "operational";
        statusLabel = "Operational";
      }
    }

    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "uptime-bar";
    bar.dataset.state = barState;
    bar.setAttribute("role", "listitem");
    bar.setAttribute(
      "aria-label",
      `${labelDate}: ${statusLabel}${durationText ? ` (${durationText})` : ""}`
    );

    const info = { labelDate, barState, statusLabel, durationText, relatedTitles };
    bar.addEventListener("mouseenter", () => showPopover(bar, info));
    bar.addEventListener("mouseleave", hidePopover);
    bar.addEventListener("focus", () => showPopover(bar, info));
    bar.addEventListener("blur", hidePopover);

    container.appendChild(bar);
  }
}

function rerenderAllBars() {
  updateRangeControls();
  hidePopover();
  for (const svcState of cachedServicesState) {
    renderServiceBars({
      ...svcState,
      issues: cachedIssues,
    });
  }
}

function updateServiceRow(slug, state, uptimeText, latencyText) {
  const row = document.querySelector(`.service-row[data-slug="${slug}"]`);
  if (!row) return;

  const uptimeEl = row.querySelector("[data-uptime]");
  const latencyEl = row.querySelector("[data-latency]");
  const pillEl = row.querySelector(".status-pill");
  const pillText = row.querySelector(".pill-text");

  if (uptimeEl && uptimeText) uptimeEl.textContent = `${uptimeText} uptime`;
  if (latencyEl && latencyText) latencyEl.textContent = latencyText;

  const labelMap = {
    operational: "Operational",
    maintenance: "Maintenance",
    down: "Down",
    degraded: "Degraded",
    loading: "Checking",
  };

  if (pillEl) pillEl.dataset.state = state;
  if (pillText) pillText.textContent = labelMap[state] || "Operational";
}

function renderIncidents(issues) {
  const section = document.getElementById("incidents-section");
  const list = document.getElementById("incidents-list");
  if (!section || !list) return;

  const relevant = (issues || [])
    .filter((issue) => !issue.pull_request && classifyIssue(issue) !== null)
    .slice(0, 5);

  if (relevant.length === 0) {
    section.hidden = true;
    return;
  }

  list.innerHTML = "";
  for (const issue of relevant) {
    const kind = classifyIssue(issue);
    const isOpen = issue.state === "open";
    const li = document.createElement("li");
    li.className = "incident-card";
    li.dataset.kind = isOpen ? kind : "resolved";

    const header = document.createElement("div");
    header.className = "incident-header";

    const titleEl = document.createElement("h3");
    titleEl.className = "incident-title";
    titleEl.textContent = issue.title;

    const badge = document.createElement("span");
    badge.className = "incident-badge";
    if (!isOpen) {
      badge.textContent = "Resolved";
    } else if (kind === "maintenance") {
      badge.textContent = "Maintenance";
    } else {
      badge.textContent = "Active";
    }

    header.append(titleEl, badge);
    li.append(header);

    const { start, end, cleanBody } = parseIssueMetadata(issue);
    if (cleanBody) {
      const desc = document.createElement("p");
      desc.className = "incident-body";
      desc.textContent = cleanBody;
      li.append(desc);
    }

    const time = document.createElement("time");
    time.className = "incident-date";
    time.dateTime = start || issue.created_at;
    if (start && end) {
      const startFmt = new Date(start).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const endFmt = new Date(end).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      time.textContent = `${startFmt} – ${endFmt}`;
    } else {
      time.textContent = new Date(issue.created_at).toLocaleDateString(
        undefined,
        {
          month: "short",
          day: "numeric",
          year: "numeric",
        }
      );
    }

    li.append(time);
    list.append(li);
  }

  section.hidden = false;
}

function setOverview(state, title, meta) {
  const card = document.querySelector(".overview-card");
  const titleEl = document.getElementById("main-heading");
  const metaEl = document.getElementById("last-updated");

  if (card) card.dataset.state = state;
  if (titleEl) titleEl.textContent = title;
  if (metaEl && meta) metaEl.textContent = meta;
}

function runIntroAnimation() {
  if (typeof window.gsap === "undefined") return;

  const mm = window.gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", () => {
    window.gsap.from(".anim-item", {
      y: 12,
      opacity: 0,
      duration: 0.5,
      stagger: 0.08,
      ease: "power3.out",
      clearProps: "transform,opacity",
    });
  });
}

async function initStatusPage() {
  runIntroAnimation();

  document.getElementById("range-prev")?.addEventListener("click", () => {
    windowOffset += 1;
    rerenderAllBars();
  });

  document.getElementById("range-next")?.addEventListener("click", () => {
    if (windowOffset > 0) {
      windowOffset -= 1;
      rerenderAllBars();
    }
  });

  const [summary, issues, latestRun, ...historyDocs] = await Promise.all([
    fetchWithFallback("history/summary.json", "json"),
    fetch(ISSUES_API, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    fetch(RUNS_API, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data?.workflow_runs?.[0]?.updated_at || null)
      .catch(() => null),
    ...SERVICES.map((s) => fetchWithFallback(`history/${s.slug}.yml`, "text")),
  ]);

  cachedIssues = issues || [];

  const openMaintenanceIssues = cachedIssues.filter(
    (i) =>
      !i.pull_request &&
      i.state === "open" &&
      classifyIssue(i) === "maintenance"
  );

  let latestTimestamp = latestRun || null;
  let hasDown = false;
  let hasMaintenance = openMaintenanceIssues.length > 0;

  cachedServicesState = [];

  SERVICES.forEach((svc, idx) => {
    const summaryItem = Array.isArray(summary)
      ? summary.find((item) => item.slug === svc.slug)
      : null;
    const yamlData = historyDocs[idx] ? parseSimpleYaml(historyDocs[idx]) : null;

    const rawStatus = yamlData?.status || summaryItem?.status || "up";
    const isMaint = openMaintenanceIssues.some((issue) =>
      issueAffectsService(issue, svc.slug, svc.name)
    );

    let state = "operational";
    if (isMaint) {
      state = "maintenance";
      hasMaintenance = true;
    } else if (rawStatus === "down") {
      state = "down";
      hasDown = true;
    }

    const latencyMs = yamlData?.responseTime ?? summaryItem?.time;
    const latencyText =
      latencyMs !== undefined && latencyMs !== null ? `${latencyMs} ms` : "—";
    const uptimeText =
      summaryItem?.uptimeMonth || summaryItem?.uptime || "100.00%";

    const startDateKey =
      yamlData?.startTime?.slice(0, 10) ||
      yamlData?.lastUpdated?.slice(0, 10) ||
      toUtcDateKey(new Date());

    if (yamlData?.lastUpdated) {
      if (!latestTimestamp || yamlData.lastUpdated > latestTimestamp) {
        latestTimestamp = yamlData.lastUpdated;
      }
    }

    updateServiceRow(svc.slug, state, uptimeText, latencyText);
    cachedServicesState.push({
      slug: svc.slug,
      name: svc.name,
      startDateKey,
      dailyMinutesDown: summaryItem?.dailyMinutesDown || {},
      currentState: state,
    });
  });

  rerenderAllBars();

  if (hasDown) {
    setOverview(
      "down",
      "Service Disruption Detected",
      formatRelativeTime(latestTimestamp)
    );
  } else if (hasMaintenance) {
    setOverview(
      "maintenance",
      "Scheduled Maintenance in Progress",
      formatRelativeTime(latestTimestamp)
    );
  } else {
    setOverview(
      "operational",
      "All Systems Operational",
      formatRelativeTime(latestTimestamp)
    );
  }

  renderIncidents(cachedIssues);
}

document.addEventListener("DOMContentLoaded", initStatusPage);
