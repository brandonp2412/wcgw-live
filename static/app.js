const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  actions: [],
  current: null,
  currentByThread: new Map(),
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

function createAction(ts, kind, title, tool = "", meta = null) {
  const action = {
    id: `${ts}-${Math.random().toString(16).slice(2)}`,
    ts,
    kind,
    title,
    tool,
    output: "",
    cwd: meta?.cwd || "",
    workspace: meta?.workspace || "",
    task: meta?.task || "",
    threadId: meta?.thread_id || "",
    status: "",
    live: false,
  };
  state.actions.push(action);
  state.current = action;
  if (action.threadId) state.currentByThread.set(action.threadId, action);
  if (state.actions.length > 350) {
    const removed = state.actions.splice(0, state.actions.length - 350);
    for (const oldAction of removed) {
      if (
        oldAction.threadId &&
        state.currentByThread.get(oldAction.threadId) === oldAction
      ) {
        state.currentByThread.delete(oldAction.threadId);
      }
    }
  }
  return action;
}

function currentAction(entry) {
  const threadId = entry?.meta?.thread_id;
  return threadId ? state.currentByThread.get(threadId) : state.current;
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
  const meta = entry.meta || null;
  if (isNoise(message)) return false;

  const toolMatch = message.match(/^Calling (.+?) tool$/i);
  if (toolMatch) {
    const tool = toolMatch[1].trim();
    const action = createAction(entry.ts, kindForTool(tool), prettyTool(tool), tool, meta);
    action.live = live;
    return true;
  }

  if (message.startsWith("$ ")) {
    let action = currentAction(entry);
    if (!action || action.kind !== "shell") action = createAction(entry.ts, "shell", "Shell command", "execute bash", meta);
    action.ts = entry.ts;
    action.title = message.slice(2).trim();
    action.live ||= live;
    return true;
  }

  const fileWritten = message.match(/^File written to (.+)$/);
  if (fileWritten) {
    let action = currentAction(entry);
    if (!action || action.kind !== "file") action = createAction(entry.ts, "file", "File write", "file writing", meta);
    action.title = `Wrote ${fileWritten[1]}`;
    action.cwd = fileWritten[1];
    action.live ||= live;
    return true;
  }

  const fileRead = message.match(/^(?:Reading|Read) (?:file|image)s?(?: from)?:?\s+(.+)$/i);
  const current = currentAction(entry);
  if (fileRead && current) {
    current.title = `${current.tool.toLowerCase().includes("image") ? "Read image" : "Read"} ${fileRead[1]}`;
    current.cwd = fileRead[1];
    current.live ||= live;
    return true;
  }

  if (message.startsWith("cwd = ") && current) {
    current.cwd = message.slice(6).trim();
    current.live ||= live;
    return true;
  }

  if (message.startsWith("status = ") && current) {
    current.status = message.slice(9).trim();
    current.live ||= live;
    return true;
  }

  if (message === "Success" && current) {
    current.status = "success";
    current.live ||= live;
    return true;
  }

  if (current) {
    appendOutput(current, message);
    current.live ||= live;
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
      return `${action.task}\n${action.title}\n${action.workspace}\n${action.cwd}\n${action.output}\n${action.tool}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.ts - a.ts);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function groupActions(actions) {
  const groups = new Map();
  for (const action of actions) {
    const workspace = action.workspace || action.cwd || "";
    const inferred = !action.task;
    const key = inferred
      ? `legacy:${basename(workspace)}:${Math.floor(action.ts / 900)}`
      : `${action.threadId || "thread"}:${action.task}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: action.task || `Inferred · ${basename(workspace)}`,
        inferred,
        workspace,
        threadId: action.threadId,
        newest: action.ts,
        oldest: action.ts,
        actions: [],
      };
      groups.set(key, group);
    }
    group.actions.push(action);
    group.newest = Math.max(group.newest, action.ts);
    group.oldest = Math.min(group.oldest, action.ts);
    if (!group.workspace && workspace) group.workspace = workspace;
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

function renderAction(action) {
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
  if (action.cwd && action.cwd !== action.workspace) context.push(action.cwd);
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

  if (action.live) node.querySelector(".action-live").classList.remove("hidden");
  return node;
}

function render() {
  const visible = visibleActions();
  const fragment = document.createDocumentFragment();

  for (const group of groupActions(visible)) {
    const section = document.createElement("section");
    section.className = `task-group${group.inferred ? " inferred" : ""}`;

    const header = document.createElement("header");
    header.className = "task-header";
    const heading = document.createElement("div");
    heading.className = "task-heading";
    const kicker = document.createElement("div");
    kicker.className = "task-kicker";
    kicker.textContent = group.inferred ? "INFERRED LEGACY GROUP" : "CHATBOT TASK";
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = group.title;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const details = [];
    if (group.workspace) details.push(basename(group.workspace));
    details.push(`${group.actions.length} action${group.actions.length === 1 ? "" : "s"}`);
    details.push(formatDuration(group.newest - group.oldest));
    meta.textContent = details.join(" · ");
    heading.append(kicker, title, meta);
    header.appendChild(heading);

    if (group.threadId) {
      const thread = document.createElement("div");
      thread.className = "task-thread";
      thread.textContent = group.threadId.slice(0, 10);
      thread.title = group.threadId;
      header.appendChild(thread);
    }
    section.appendChild(header);

    const actions = document.createElement("div");
    actions.className = "task-actions";
    for (const action of group.actions.sort((a, b) => b.ts - a.ts)) actions.appendChild(renderAction(action));
    section.appendChild(actions);
    fragment.appendChild(section);
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
    $("#latestDetail").textContent = latest.task || latest.title;
    const latestWorkspace = latest.workspace || latest.cwd;
    $("#workspace").textContent = basename(latestWorkspace);
    $("#workspace").title = latestWorkspace || "";
  }

  const shown = visibleActions().length;
  const taskCount = groupActions(all).filter((group) => !group.inferred).length;
  $("#streamSubtitle").textContent = `${shown} shown · ${taskCount} task${taskCount === 1 ? "" : "s"} · ${all.length} recent actions`;
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
