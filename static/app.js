const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  actions: [],
  current: null,
  filter: "all",
  search: "",
  paused: false,
  queue: [],
  connected: false,
  compact: false,
};

const timeline = $("#timeline");
const template = $("#actionTemplate");
const emptyState = $("#emptyState");

function stripLoggerPrefix(message) {
  return message.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}:\s*/, "");
}

function isNoise(message) {
  const m = stripLoggerPrefix(message).trim();
  return (
    !m ||
    m.startsWith("INFO:     127.0.0.1:") ||
    m.startsWith("Created new transport with session ID:") ||
    m === "Processing request of type CallToolRequest"
  );
}

function kindForTool(toolName) {
  const name = toolName.toLowerCase();
  if (name.includes("bash") || name.includes("shell")) return "shell";
  if (name.includes("file") || name.includes("image") || name.includes("context save")) return "file";
  return "tool";
}

function prettyTool(toolName) {
  return toolName
    .replace(/^execute bash$/i, "Shell command")
    .replace(/^file writing$/i, "File write")
    .replace(/^read files?$/i, "Read files")
    .replace(/^read image$/i, "Read image")
    .replace(/^initialize$/i, "Initialize workspace")
    .replace(/^context save$/i, "Save context")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function createAction(ts, kind, title, tool = "") {
  const action = {
    id: `${ts}-${Math.random().toString(16).slice(2)}`,
    ts,
    kind,
    title,
    tool,
    output: "",
    cwd: "",
    status: "",
    live: false,
  };
  state.actions.push(action);
  state.current = action;
  if (state.actions.length > 350) state.actions.splice(0, state.actions.length - 350);
  return action;
}

function appendOutput(action, text) {
  if (!text || text === "---" || text === "This is the main shell. No command running in background.") return;
  action.output += `${action.output ? "\n" : ""}${text}`;
  if (action.output.length > 28000) action.output = `… older output trimmed …\n${action.output.slice(-26000)}`;
}

function processEntry(entry, live = false) {
  if (!entry || typeof entry.message !== "string") return false;
  const raw = stripLoggerPrefix(entry.message);
  const message = raw.trimEnd();
  if (isNoise(message)) return false;

  const toolMatch = message.match(/^Calling (.+?) tool$/i);
  if (toolMatch) {
    const tool = toolMatch[1].trim();
    const action = createAction(entry.ts, kindForTool(tool), prettyTool(tool), tool);
    action.live = live;
    return true;
  }

  if (message.startsWith("$ ")) {
    let action = state.current;
    if (!action || action.kind !== "shell") action = createAction(entry.ts, "shell", "Shell command", "execute bash");
    action.ts = entry.ts;
    action.title = message.slice(2).trim();
    action.live ||= live;
    return true;
  }

  const fileWritten = message.match(/^File written to (.+)$/);
  if (fileWritten) {
    let action = state.current;
    if (!action || action.kind !== "file") action = createAction(entry.ts, "file", "File write", "file writing");
    action.title = `Wrote ${fileWritten[1]}`;
    action.cwd = fileWritten[1];
    action.live ||= live;
    return true;
  }

  const fileRead = message.match(/^(?:Reading|Read) (?:file|image)s?(?: from)?:?\s+(.+)$/i);
  if (fileRead && state.current) {
    state.current.title = `${state.current.tool.toLowerCase().includes("image") ? "Read image" : "Read"} ${fileRead[1]}`;
    state.current.cwd = fileRead[1];
    state.current.live ||= live;
    return true;
  }

  if (message.startsWith("cwd = ") && state.current) {
    state.current.cwd = message.slice(6).trim();
    state.current.live ||= live;
    return true;
  }

  if (message.startsWith("status = ") && state.current) {
    state.current.status = message.slice(9).trim();
    state.current.live ||= live;
    return true;
  }

  if (message === "Success" && state.current) {
    state.current.status = "success";
    state.current.live ||= live;
    return true;
  }

  if (state.current) {
    appendOutput(state.current, message);
    state.current.live ||= live;
    return true;
  }

  return false;
}

function formatTime(ts) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ts * 1000));
}

function formatLatest(ts) {
  const date = new Date(ts * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

function basename(path) {
  if (!path) return "—";
  const normalized = path.replace(/\/$/, "");
  return normalized.split("/").filter(Boolean).pop() || path;
}

function iconFor(kind) {
  if (kind === "shell") return ">_";
  if (kind === "file") return "⌑";
  return "◇";
}

function visibleActions() {
  const needle = state.search.trim().toLowerCase();
  return state.actions
    .filter((action) => state.filter === "all" || action.kind === state.filter)
    .filter((action) => {
      if (!needle) return true;
      return `${action.title}\n${action.cwd}\n${action.output}\n${action.tool}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.ts - a.ts);
}

function render() {
  const visible = visibleActions();
  const fragment = document.createDocumentFragment();

  for (const action of visible) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = action.id;
    node.classList.add(action.kind);
    if (action.live) node.classList.add("fresh");
    if (/error|failed|failure/i.test(action.status)) node.classList.add("error");

    node.querySelector(".action-icon").textContent = iconFor(action.kind);
    node.querySelector(".action-kind").textContent = action.tool || action.kind;
    node.querySelector(".action-time").textContent = formatTime(action.ts);
    node.querySelector(".action-title").textContent = action.title;

    const context = [];
    if (action.cwd) context.push(action.cwd);
    if (action.status && action.status !== "success") context.push(action.status);
    node.querySelector(".action-context").textContent = context.join("  ·  ");

    const output = action.output.trim();
    const pre = node.querySelector(".action-output");
    const code = pre.querySelector("code");
    const expand = node.querySelector(".expand-button");
    if (output) {
      code.textContent = output;
      if (output.split("\n").length > 6 || output.length > 650) {
        pre.classList.add("collapsed");
        expand.classList.remove("hidden");
        expand.addEventListener("click", () => {
          const expanded = pre.classList.toggle("expanded");
          pre.classList.toggle("collapsed", !expanded);
          expand.textContent = expanded ? "Hide output" : "Show output";
        });
      }
    } else {
      pre.remove();
      expand.remove();
    }

    if (action.live) {
      const badge = node.querySelector(".action-live");
      badge.classList.remove("hidden");
    }
    fragment.appendChild(node);
  }

  timeline.replaceChildren(fragment);
  emptyState.classList.toggle("hidden", visible.length !== 0);
  updateStats();

}

function updateStats() {
  const all = state.actions;
  const latest = all.length ? all.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
  const oneHourAgo = Date.now() / 1000 - 3600;

  $("#allCount").textContent = all.length;
  $("#shellCount").textContent = all.filter((a) => a.kind === "shell").length;
  $("#fileCount").textContent = all.filter((a) => a.kind === "file").length;
  $("#toolCount").textContent = all.filter((a) => a.kind === "tool").length;
  $("#hourCount").textContent = all.filter((a) => a.ts >= oneHourAgo).length;

  if (latest) {
    $("#latestTime").textContent = formatLatest(latest.ts);
    $("#latestDetail").textContent = latest.title;
    $("#workspace").textContent = basename(latest.cwd);
    $("#workspace").title = latest.cwd || "";
  }

  const shown = visibleActions().length;
  $("#streamSubtitle").textContent = `${shown} shown · ${all.length} recent actions`;
}

function setConnection(mode) {
  state.connected = mode === "live";
  const pill = $("#livePill");
  pill.classList.toggle("offline", mode === "offline");
  pill.classList.toggle("paused", mode === "paused");
  $("#liveLabel").textContent = mode === "live" ? "LIVE" : mode === "paused" ? "PAUSED" : "RECONNECTING";
}

async function loadHistory() {
  const response = await fetch("/api/history?lines=1800", { cache: "no-store" });
  if (!response.ok) throw new Error(`history ${response.status}`);
  const data = await response.json();
  $("#sourceUnit").textContent = data.unit;
  for (const entry of data.entries) processEntry(entry, false);
  render();
}

function startStream() {
  const source = new EventSource("/api/stream");
  source.onopen = () => setConnection(state.paused ? "paused" : "live");
  source.onerror = () => setConnection("offline");
  source.onmessage = (event) => {
    let entry;
    try { entry = JSON.parse(event.data); } catch { return; }
    if (state.paused) {
      state.queue.push(entry);
      if (state.queue.length > 1000) state.queue.shift();
      return;
    }
    if (processEntry(entry, true)) render();
  };
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    $("#serviceState").textContent = data.state === "active" ? "wcgw service active" : `wcgw ${data.state}`;
    $("#sourceUnit").textContent = data.unit;
    $(".status-dot").style.background = data.state === "active" ? "var(--green)" : "var(--red)";
  } catch {
    $("#serviceState").textContent = "status unavailable";
  }
}

$$('.nav-item').forEach((button) => {
  button.addEventListener("click", () => {
    $$('.nav-item').forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    render();
  });
});

$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== $("#search")) {
    event.preventDefault();
    $("#search").focus();
  }
  if (event.key === "Escape" && document.activeElement === $("#search")) {
    $("#search").value = "";
    state.search = "";
    $("#search").blur();
    render();
  }
});

$("#pauseButton").addEventListener("click", () => {
  state.paused = !state.paused;
  $("#pauseButton").querySelector("span:last-child").textContent = state.paused ? "Resume" : "Pause";
  setConnection(state.paused ? "paused" : "live");
  if (!state.paused && state.queue.length) {
    for (const entry of state.queue.splice(0)) processEntry(entry, true);
    render();
  }
});

$("#collapseButton").addEventListener("click", () => {
  state.compact = !state.compact;
  document.body.classList.toggle("compact", state.compact);
  $("#collapseButton").querySelector("span:last-child").textContent = state.compact ? "Expand" : "Collapse";
});

setInterval(() => {
  $("#clock").textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}, 1000);
setInterval(refreshStatus, 15000);

(async () => {
  try {
    await Promise.all([loadHistory(), refreshStatus()]);
  } catch (error) {
    console.error(error);
    $("#streamSubtitle").textContent = "failed to load history";
  }
  if (!new URLSearchParams(location.search).has("snapshot")) startStream();
  else setConnection("paused");
})();
