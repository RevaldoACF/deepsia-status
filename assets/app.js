const REPO_OWNER = "RevaldoACF";
const REPO_NAME = "deepsia-status";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const ISSUES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all&per_page=20`;
const HISTORY_DAYS = 60;

const SERVICES = [
  { slug: "api", name: "API" },
  { slug: "chat", name: "DeepChat" },
];

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
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

function issueAffectsService(issue, slug, name) {
  const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
  const text = `${issue.title || ""} ${issue.body || ""}`.toLowerCase();
  return (
    labels.includes(slug) ||
    text.includes(slug) ||
    text.includes(name.toLowerCase()) ||
    text.includes(`${slug}.deepsia.my.id`)
  );
}

function issueActiveOnDate(issue, dateKey) {
  const startKey = issue.created_at?.slice(0, 10);
  const endKey =
    issue.state === "closed" && issue.closed_at
      ? issue.closed_at.slice(0, 10)
      : toUtcDateKey(new Date());
  return Boolean(startKey && dateKey >= startKey && dateKey <= endKey);
}

function showTooltip(target, text) {
  const tip = document.getElementById("bar-tooltip");
  if (!tip) return;
  const rect = target.getBoundingClientRect();
  tip.textContent = text;
  tip.style.left = `${rect.left + rect.width / 2}px`;
  tip.style.top = `${rect.top - 8}px`;
  tip.hidden = false;
}

function hideTooltip() {
  const tip = document.getElementById("bar-tooltip");
  if (tip) tip.hidden = true;
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
  if (!container) return;

  container.innerHTML = "";
  const today = new Date();
  const todayKey = toUtcDateKey(today);
  const maintIssues = (issues || []).filter(
    (i) =>
      !i.pull_request &&
      classifyIssue(i) === "maintenance" &&
      issueAffectsService(i, slug, name)
  );

  for (let offset = HISTORY_DAYS - 1; offset >= 0; offset--) {
    const d = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - offset
      )
    );
    const dateKey = toUtcDateKey(d);
    const labelDate = formatShortDate(dateKey);

    let barState = "none";
    let detail = "No data";

    if (startDateKey && dateKey >= startDateKey) {
      const minutesDown = Number(dailyMinutesDown?.[dateKey] || 0);
      const hasMaint = maintIssues.some((issue) =>
        issueActiveOnDate(issue, dateKey)
      );

      if (dateKey === todayKey && currentState === "down") {
        barState = "down";
        detail =
          minutesDown > 0 ? `Down (${minutesDown}m)` : "Service disruption";
      } else if (dateKey === todayKey && currentState === "maintenance") {
        barState = "maintenance";
        detail = "Scheduled maintenance";
      } else if (minutesDown >= 30) {
        barState = "down";
        detail = `Major outage (${minutesDown}m down)`;
      } else if (minutesDown > 0) {
        barState = "degraded";
        detail = `Partial outage (${minutesDown}m down)`;
      } else if (hasMaint) {
        barState = "maintenance";
        detail = "Scheduled maintenance";
      } else {
        barState = "operational";
        detail = "Operational";
      }
    }

    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "uptime-bar";
    bar.dataset.state = barState;
    bar.setAttribute("role", "listitem");
    bar.setAttribute("aria-label", `${labelDate}: ${detail}`);

    const tooltipText = `${labelDate} · ${detail}`;
    bar.addEventListener("mouseenter", () => showTooltip(bar, tooltipText));
    bar.addEventListener("mouseleave", hideTooltip);
    bar.addEventListener("focus", () => showTooltip(bar, tooltipText));
    bar.addEventListener("blur", hideTooltip);

    container.appendChild(bar);
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

    const link = document.createElement("a");
    link.className = "incident-title";
    link.href = issue.html_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = issue.title;

    const badge = document.createElement("span");
    badge.className = "incident-badge";
    if (!isOpen) {
      badge.textContent = "Resolved";
    } else if (kind === "maintenance") {
      badge.textContent = "Maintenance";
    } else {
      badge.textContent = "Active";
    }

    header.append(link, badge);

    const time = document.createElement("time");
    time.className = "incident-date";
    time.dateTime = issue.created_at;
    time.textContent = new Date(issue.created_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    li.append(header, time);
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

  const [summary, issues, ...historyDocs] = await Promise.all([
    fetchWithFallback("history/summary.json", "json"),
    fetch(ISSUES_API, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    ...SERVICES.map((s) => fetchWithFallback(`history/${s.slug}.yml`, "text")),
  ]);

  const openMaintenanceIssues = (issues || []).filter(
    (i) =>
      !i.pull_request &&
      i.state === "open" &&
      classifyIssue(i) === "maintenance"
  );

  let latestTimestamp = null;
  let hasDown = false;
  let hasMaintenance = openMaintenanceIssues.length > 0;

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
    renderServiceBars({
      slug: svc.slug,
      name: svc.name,
      startDateKey,
      dailyMinutesDown: summaryItem?.dailyMinutesDown || {},
      currentState: state,
      issues,
    });
  });

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

  renderIncidents(issues);
}

document.addEventListener("DOMContentLoaded", initStatusPage);
