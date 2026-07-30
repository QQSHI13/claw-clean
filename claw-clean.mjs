#!/usr/bin/env node
// claw-clean — Interactive cleanup tool for OpenClaw agents and legacy sessions.
// Version: 2.6.0
// Usage: claw-clean [-h] [--doctor] [--dry-run]

import {
  intro,
  outro,
  select,
  groupMultiselect,
  confirm,
  isCancel,
  cancel,
  note,
  log,
} from "@clack/prompts";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const VERSION = "2.6.0";

// ── Global options ─────────────────────────────────────────────────
let DRY_RUN = false;
let CLI_AGENT = null;

// ── Helpers ────────────────────────────────────────────────────────
function fmt(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function ageDays(filePath) {
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    return Math.floor((Date.now() - mtime) / 86400000);
  } catch {
    return 0;
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(p);
      } else if (entry.isFile()) {
        total += fs.statSync(p).size;
      }
    }
  } catch {
    // ignore unreadable paths
  }
  return total;
}

function commandExists(cmd) {
  const [first] = cmd.split(" ");
  try {
    execSync(`command -v ${first}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectTrashCmd() {
  const candidates = ["trash", "trash-put", "gio trash"];
  for (const cmd of candidates) {
    if (commandExists(cmd)) {
      return cmd.includes(" ") ? cmd.split(" ") : [cmd];
    }
  }
  return null;
}

function auditLogPath() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "claw-clean", "log");
}

function appendAudit(line) {
  try {
    const p = auditLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(p, `[${timestamp}] ${line}\n`);
  } catch (err) {
    log.warn(`Could not write audit log: ${err.message}`);
  }
}

async function trashFile(trashCmd, filePath, attempt = 1) {
  if (!fs.existsSync(filePath)) {
    log.warn(`${filePath} does not exist, skipping`);
    return false;
  }

  if (DRY_RUN) {
    log.step(`[dry-run] Would trash ${filePath}`);
    return true;
  }

  const result = await new Promise((resolve) => {
    const [cmd, ...args] = [...trashCmd, filePath];
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

  if (result) return true;

  if (attempt === 1) {
    log.step(`Retrying trash for ${filePath}...`);
    await new Promise((r) => setTimeout(r, 300));
    return trashFile(trashCmd, filePath, attempt + 1);
  }

  log.error(`Failed to trash ${filePath}`);
  return false;
}

// ── SQLite helpers (best-effort; Node >=22 has node:sqlite) ────────
let SqliteDatabase = null;

try {
  const sqlite = await import("node:sqlite");
  SqliteDatabase = sqlite.DatabaseSync;
} catch {
  SqliteDatabase = null;
}

function hasNodeSqlite() {
  return SqliteDatabase !== null;
}

function readAgentSqliteSessions(dbPath) {
  if (!hasNodeSqlite() || !fs.existsSync(dbPath)) {
    return null;
  }
  try {
    const db = new SqliteDatabase(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT
          n.session_key,
          n.current_session_id,
          n.label,
          n.status,
          n.updated_at,
          n.archived_at,
          n.pinned_at
        FROM session_nodes n
        ORDER BY n.updated_at DESC
      `);
      return stmt.all();
    } finally {
      db.close();
    }
  } catch (err) {
    // Best-effort; corrupted or locked DBs are ignored.
    return null;
  }
}

// ── Argument parsing ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(`Session Cleanup Tool

Usage: claw-clean [-h] [--doctor] [--dry-run] [--agent <agent-id>]

Flags:
  -h, --help              Show this help
      --doctor            Check environment and dependencies
      --dry-run           Show what would be deleted without deleting anything
      --agent <agent-id>  Skip the agent menu and clean the specified agent
`);
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === "--doctor") {
      runDoctor();
      process.exit(0);
    } else if (arg === "--dry-run") {
      DRY_RUN = true;
      i++;
    } else if (arg === "--agent") {
      i++;
      const next = args[i];
      if (!next) {
        console.error("Error: --agent requires an agent id.");
        process.exit(1);
      }
      CLI_AGENT = next;
      i++;
    } else {
      console.error(`Error: Unknown flag: ${arg}. Use -h for help.`);
      process.exit(1);
    }
  }
}

// ── Doctor ────────────────────────────────────────────────────────
function runDoctor() {
  console.log(`claw-clean ${VERSION}\n`);

  const checks = [];

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    name: "Node.js",
    ok: major >= 18,
    detail: nodeVersion,
  });

  // node:sqlite availability (optional but useful)
  checks.push({
    name: "node:sqlite (optional)",
    ok: hasNodeSqlite(),
    detail: hasNodeSqlite() ? "available" : `not available on ${nodeVersion} (Node >=22 required)`,
  });

  // Trash command
  const trashCmd = detectTrashCmd();
  checks.push({
    name: "Trash command",
    ok: trashCmd !== null,
    detail: trashCmd ? trashCmd.join(" ") : "none found (install trash-cli)",
  });

  // State directory writable
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  let stateWritable = false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.accessSync(stateDir, fs.constants.W_OK);
    stateWritable = true;
  } catch {
    stateWritable = false;
  }
  checks.push({
    name: "State directory writable",
    ok: stateWritable,
    detail: stateDir,
  });

  // Audit log directory writable
  const auditDir = path.dirname(auditLogPath());
  let auditWritable = false;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.accessSync(auditDir, fs.constants.W_OK);
    auditWritable = true;
  } catch {
    auditWritable = false;
  }
  checks.push({
    name: "Audit log directory writable",
    ok: auditWritable,
    detail: auditDir,
  });

  let allOk = true;
  for (const c of checks) {
    const symbol = c.ok ? "✓" : "✗";
    console.log(`${symbol} ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }

  console.log("");
  console.log(allOk ? "All checks passed." : "Some checks failed.");
  process.exit(allOk ? 0 : 1);
}

// ── Agent selection ───────────────────────────────────────────────
async function selectAgent(stateDir) {
  const agentsDir = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    console.error(`Error: No agents directory: ${agentsDir}`);
    process.exit(1);
  }

  const agents = fs
    .readdirSync(agentsDir)
    .filter((e) => fs.statSync(path.join(agentsDir, e)).isDirectory())
    .sort();

  if (agents.length === 0) {
    console.error(`Error: No agents found in ${agentsDir}`);
    process.exit(1);
  }

  const options = agents.map((a) => ({ value: a, label: a }));
  options.push({ value: "__done__", label: "Done" });

  const choice = await select({
    message: "Select agent:",
    options,
  });

  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  return choice;
}

// ── Agent layout detection ────────────────────────────────────────
function detectAgentLayout(stateDir, agentId) {
  const agentDir = path.join(stateDir, "agents", agentId);
  const legacySessionsDir = path.join(agentDir, "sessions");
  const agentDbDir = path.join(agentDir, "agent");
  const agentDbPath = path.join(agentDbDir, "openclaw-agent.sqlite");
  const importArchiveDir = path.join(agentDir, "session-sqlite-import-archive");

  return {
    agentDir,
    legacySessionsDir,
    hasLegacySessions: fs.existsSync(legacySessionsDir),
    agentDbDir,
    agentDbPath,
    hasAgentDb: fs.existsSync(agentDbPath),
    importArchiveDir,
    hasImportArchive: fs.existsSync(importArchiveDir),
  };
}

// ── Legacy sessions.json helpers ──────────────────────────────────
function loadSessionsJson(sessionDir) {
  const p = path.join(sessionDir, "sessions.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function sessIsActive(id, sessionsJson) {
  if (!sessionsJson) return false;
  return Object.values(sessionsJson).some(
    (v) =>
      v &&
      (v.sessionId === id ||
        (typeof v.sessionFile === "string" && v.sessionFile.includes(id)))
  );
}

function sessKey(id, sessionsJson) {
  if (!sessionsJson) return "";
  const entry = Object.entries(sessionsJson).find(
    ([, v]) =>
      v &&
      (v.sessionId === id ||
        (typeof v.sessionFile === "string" && v.sessionFile.includes(id)))
  );
  return entry ? entry[0] : "";
}

function sessFileForId(id, sessionsJson) {
  if (!sessionsJson) return "";
  const entry = Object.values(sessionsJson).find((v) => v && v.sessionId === id);
  return entry && typeof entry.sessionFile === "string" ? entry.sessionFile : "";
}

function sessFileExists(id, sessionDir, sessionsJson) {
  if (fs.existsSync(path.join(sessionDir, `${id}.jsonl`))) return true;
  const sf = sessFileForId(id, sessionsJson);
  return sf && fs.existsSync(sf);
}

// ── Artifact classifiers matching OpenClaw's artifact naming ───────
const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;

function isSessionArchiveArtifactName(fileName) {
  if (/^sessions\.json\.bak\.\d+$/.test(fileName)) return true;
  for (const reason of ["deleted", "reset", "bak"]) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0) {
      const raw = fileName.slice(index + marker.length);
      if (ARCHIVE_TIMESTAMP_RE.test(raw)) return true;
    }
  }
  return false;
}

function isImportArchiveArtifactName(fileName) {
  return /\.imported-\d+$/.test(fileName);
}

function isAgentDbBackupArtifactName(fileName) {
  if (/\.bak(?:-|$)/i.test(fileName)) return true;
  if (/\.sqlite-import\..*\.bak$/i.test(fileName)) return true;
  if (/\.tmp$/i.test(fileName)) return true;
  if (fileName === "openclaw-agent.sqlite.reindex-lock.sqlite") return true;
  return false;
}

function parseArchiveBaseId(fileName) {
  // <id>.jsonl.<reason>.<timestamp>
  for (const reason of ["deleted", "reset", "bak"]) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

// ── Data gathering ────────────────────────────────────────────────
function gatherLegacySessions(sessionDir, sessionsJson) {
  const sessions = [];
  const seenIds = new Set();
  let sSize = 0;
  let openC = 0;
  let activeC = 0;

  if (!fs.existsSync(sessionDir)) {
    return { sessions, seenIds, sSize, openC, activeC };
  }

  for (const entry of fs.readdirSync(sessionDir)) {
    const f = path.join(sessionDir, entry);
    if (!fs.statSync(f).isFile()) continue;
    if (!entry.endsWith(".jsonl")) continue;
    if (entry.endsWith(".trajectory.jsonl")) continue;
    if (isSessionArchiveArtifactName(entry)) continue;
    if (entry.startsWith(".")) continue;
    if (entry.includes(".checkpoint.")) continue;
    if (isImportArchiveArtifactName(entry)) continue;

    const id = entry.slice(0, -".jsonl".length);
    const sz = fs.statSync(f).size;
    const st = sessIsActive(id, sessionsJson)
      ? fs.existsSync(`${f}.lock`)
        ? "OPEN"
        : "active"
      : "inactive";
    const ag = ageDays(f);
    const key = sessKey(id, sessionsJson);

    sessions.push({ id, key, file: f, size: sz, age: ag, status: st });
    seenIds.add(id);
    sSize += sz;
    if (st === "OPEN") openC++;
    if (st === "active") activeC++;
  }

  return { sessions, seenIds, sSize, openC, activeC };
}

function gatherOrphans(sessionDir, sessionsJson, seenIds) {
  const orphans = [];
  if (!sessionsJson) return orphans;

  for (const [key, value] of Object.entries(sessionsJson)) {
    if (!value || typeof value.sessionId !== "string") continue;
    const id = value.sessionId;
    if (seenIds.has(id)) continue;
    if (sessFileExists(id, sessionDir, sessionsJson)) continue;
    orphans.push({ id, key });
  }

  return orphans;
}

function gatherStaleItems(sessionDir) {
  const staleItems = [];
  let staleSize = 0;

  if (!fs.existsSync(sessionDir)) {
    return { staleItems, staleSize };
  }

  for (const entry of fs.readdirSync(sessionDir)) {
    const f = path.join(sessionDir, entry);
    if (!fs.statSync(f).isFile()) continue;

    if (isSessionArchiveArtifactName(entry)) {
      const sz = fs.statSync(f).size;
      const baseid = parseArchiveBaseId(entry);
      const companions = [];

      if (baseid) {
        const tjf = path.join(sessionDir, `${baseid}.trajectory.jsonl`);
        if (fs.existsSync(tjf)) companions.push(tjf);

        const tpjf = path.join(sessionDir, `${baseid}.trajectory-path.json`);
        if (fs.existsSync(tpjf)) companions.push(tpjf);
      }

      const companionsSize = companions.reduce((sum, c) => sum + fs.statSync(c).size, 0);
      const reason = entry.includes(".deleted.")
        ? "deleted"
        : entry.includes(".reset.")
          ? "reset"
          : "bak";

      staleItems.push({
        type: reason,
        value: `stale:${f}`,
        file: f,
        baseid,
        label: `${entry} — ${fmt(sz)}${companions.length ? ` + ${fmt(companionsSize)} companions` : ""}`,
        hint: `${ageDays(f)}d old`,
        size: sz,
        companions,
      });
      staleSize += sz + companionsSize;
    }

    if (isImportArchiveArtifactName(entry)) {
      const sz = fs.statSync(f).size;
      staleItems.push({
        type: "import",
        value: `stale:${f}`,
        file: f,
        label: `${entry} — ${fmt(sz)}`,
        hint: `${ageDays(f)}d old`,
        size: sz,
        companions: [],
      });
      staleSize += sz;
    }
  }

  return { staleItems, staleSize };
}

function gatherLegacyImportArchive(importArchiveDir) {
  if (!fs.existsSync(importArchiveDir)) {
    return null;
  }

  const files = fs
    .readdirSync(importArchiveDir)
    .map((e) => {
      const f = path.join(importArchiveDir, e);
      try {
        return { name: e, file: f, size: fs.statSync(f).size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (files.length === 0) {
    return null;
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return {
    dir: importArchiveDir,
    fileCount: files.length,
    size: totalSize,
    files,
  };
}

function gatherAgentDbBackups(agentDbDir) {
  if (!fs.existsSync(agentDbDir)) {
    return [];
  }

  const backups = [];
  for (const entry of fs.readdirSync(agentDbDir)) {
    const f = path.join(agentDbDir, entry);
    if (!fs.statSync(f).isFile()) continue;
    if (isAgentDbBackupArtifactName(entry)) {
      backups.push({ file: f, name: entry, size: fs.statSync(f).size });
    }
  }

  return backups.sort((a, b) => a.name.localeCompare(b.name));
}

function gatherData(sessionDir, archiveDir, importArchiveDir, agentDbDir, sessionsJson) {
  const { sessions, seenIds, sSize, openC, activeC } = gatherLegacySessions(
    sessionDir,
    sessionsJson
  );
  const orphans = gatherOrphans(sessionDir, sessionsJson, seenIds);
  const { staleItems, staleSize } = gatherStaleItems(sessionDir);

  // Legacy archive/ folder
  let archiveItem = null;
  if (fs.existsSync(archiveDir)) {
    const archiveEntries = fs.readdirSync(archiveDir).filter((e) => {
      try {
        return fs.statSync(path.join(archiveDir, e)).isFile();
      } catch {
        return false;
      }
    });
    if (archiveEntries.length > 0) {
      const archiveSize = archiveEntries.reduce(
        (sum, e) => sum + fs.statSync(path.join(archiveDir, e)).size,
        0
      );
      archiveItem = {
        type: "archive",
        value: `stale:archive`,
        file: archiveDir,
        label: `archive/ — ${archiveEntries.length} items, ${fmt(archiveSize)}`,
        hint: "folder",
        size: archiveSize,
        companions: [],
      };
    }
  }

  const importArchive = gatherLegacyImportArchive(importArchiveDir);
  const dbBackups = gatherAgentDbBackups(agentDbDir);

  return {
    sessions,
    orphans,
    staleItems: archiveItem ? [...staleItems, archiveItem] : staleItems,
    staleSize: archiveItem ? staleSize + archiveItem.size : staleSize,
    importArchive,
    dbBackups,
    sSize,
    openC,
    activeC,
  };
}

// ── Main ──────────────────────────────────────────────────────────
async function cleanupAgent(stateDir, AGENT_ID, trashCmd) {
  const layout = detectAgentLayout(stateDir, AGENT_ID);
  const sessionDir = layout.legacySessionsDir;
  const archiveDir = path.join(sessionDir, "archive");

  let sessionsJson = null;
  if (layout.hasLegacySessions) {
    sessionsJson = loadSessionsJson(sessionDir);
  }

  const sqliteSessions = layout.hasAgentDb ? readAgentSqliteSessions(layout.agentDbPath) : null;

  const { sessions, orphans, staleItems, staleSize, importArchive, dbBackups, sSize, openC, activeC } =
    gatherData(sessionDir, archiveDir, layout.importArchiveDir, layout.agentDbDir, sessionsJson);

  intro(`Session Cleanup — Agent: ${AGENT_ID}`);

  const dbSize = layout.hasAgentDb ? fs.statSync(layout.agentDbPath).size : 0;
  const dbBackupSize = dbBackups.reduce((sum, b) => sum + b.size, 0);

  const summaryLines = [];
  if (layout.hasAgentDb) {
    summaryLines.push(`Agent DB: ${fmt(dbSize)} (${sqliteSessions?.length ?? "?"} sessions)`);
  }
  if (sessions.length > 0) {
    summaryLines.push(`Legacy sessions: ${sessions.length} (${activeC} active, ${openC} open) — ${fmt(sSize)}`);
  }
  if (orphans.length > 0) {
    summaryLines.push(`Orphaned: ${orphans.length} (in sessions.json but no file)`);
  }
  if (staleItems.length > 0) {
    summaryLines.push(`Stale data: ${staleItems.length} items — ${fmt(staleSize)}`);
  }
  if (importArchive) {
    summaryLines.push(`Import archive: ${importArchive.fileCount} items — ${fmt(importArchive.size)}`);
  }
  if (dbBackups.length > 0) {
    summaryLines.push(`DB backups/temp: ${dbBackups.length} items — ${fmt(dbBackupSize)}`);
  }

  if (summaryLines.length === 0) {
    summaryLines.push("Nothing to clean up.");
  }

  note(summaryLines.join("\n"), DRY_RUN ? "Summary (dry-run)" : "Summary");

  if (layout.hasAgentDb) {
    if (sqliteSessions && sqliteSessions.length > 0) {
      const sqliteLines = sqliteSessions.map((s) => {
        const label = s.label || s.display_name || "(unlabeled)";
        const status = s.status || "unknown";
        const archived = s.archived_at ? " archived" : "";
        const pinned = s.pinned_at ? " pinned" : "";
        const age = s.updated_at ? `${Math.floor((Date.now() - s.updated_at) / 86400000)}d` : "?";
        return `${s.session_key} — ${label} [${status}${archived}${pinned}, ${age}]`;
      });
      note(
        `${sqliteLines.join("\n")}\n\nSQLite sessions cannot be deleted here. Use 'openclaw sessions cleanup' to prune them safely.`,
        `SQLite sessions (${sqliteSessions.length})`
      );
    } else {
      note(
        "This agent uses the SQLite session store. Use 'openclaw sessions cleanup' to prune individual SQLite sessions safely.",
        "Tip"
      );
    }
  }

  const groups = {};

  if (sessions.length > 0) {
    groups["Legacy sessions"] = sessions.map((s) => ({
      value: s.id,
      label: `${s.id}${s.key ? ` (${s.key})` : ""} — ${fmt(s.size)}`,
      hint: `${s.age}d, ${s.status}`,
    }));
  }

  if (orphans.length > 0) {
    groups["Orphaned sessions"] = orphans.map((o) => ({
      value: `orphan:${o.id}`,
      label: `${o.id}${o.key ? ` (${o.key})` : ""}`,
      hint: "in sessions.json only",
    }));
  }

  if (staleItems.length > 0) {
    groups["Stale data"] = staleItems.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    }));
  }

  if (importArchive) {
    groups["Legacy import archive"] = [
      {
        value: `import-archive:${importArchive.dir}`,
        label: `session-sqlite-import-archive/ — ${importArchive.fileCount} items, ${fmt(importArchive.size)}`,
        hint: "legacy import artifacts",
      },
    ];
  }

  if (dbBackups.length > 0) {
    groups["DB backups & temp"] = dbBackups.map((b) => ({
      value: `dbbackup:${b.file}`,
      label: `${b.name} — ${fmt(b.size)}`,
      hint: `${ageDays(b.file)}d old`,
    }));
  }

  const agentDir = path.join(stateDir, "agents", AGENT_ID);
  const agentSize = dirSize(agentDir);
  groups["Agent"] = [
    {
      value: "agent:delete",
      label: `Delete entire agent: ${AGENT_ID}`,
      hint: `moves whole agent to trash — ${fmt(agentSize)}`,
    },
  ];

  let selected = [];
  if (Object.keys(groups).length > 0) {
    selected = await groupMultiselect({
      message: "Select sessions / cleanup actions:",
      options: groups,
      required: false,
    });

    if (isCancel(selected)) {
      cancel("Cancelled.");
      process.exit(0);
    }
  }

  // Expand group-level selections to all child values
  const expanded = new Set();
  for (const value of selected) {
    if (value in groups) {
      for (const opt of groups[value]) {
        expanded.add(opt.value);
      }
    } else {
      expanded.add(value);
    }
  }

  const selectedValues = Array.from(expanded);
  const selectedIds = selectedValues.filter(
    (v) =>
      !v.startsWith("orphan:") &&
      !v.startsWith("stale:") &&
      !v.startsWith("agent:") &&
      !v.startsWith("import-archive:") &&
      !v.startsWith("dbbackup:")
  );
  const selectedOrphanIds = selectedValues
    .filter((v) => v.startsWith("orphan:"))
    .map((v) => v.slice("orphan:".length));
  const selectedStaleValues = new Set(selectedValues.filter((v) => v.startsWith("stale:")));
  const selectedImportArchive = selectedValues
    .filter((v) => v.startsWith("import-archive:"))
    .map((v) => v.slice("import-archive:".length));
  const selectedDbBackups = selectedValues
    .filter((v) => v.startsWith("dbbackup:"))
    .map((v) => v.slice("dbbackup:".length));
  const deleteAgent = selectedValues.includes("agent:delete");

  const totalCount =
    selectedIds.length +
    selectedOrphanIds.length +
    selectedStaleValues.size +
    selectedImportArchive.length +
    selectedDbBackups.length +
    (deleteAgent ? 1 : 0);

  if (totalCount === 0) {
    outro("Nothing selected.");
    return;
  }

  const hasOpen = sessions.some((s) => selectedIds.includes(s.id) && s.status === "OPEN");

  const confirmed = await confirm({
    message:
      `${totalCount} item(s) selected for cleanup.` +
      (deleteAgent ? " (WARNING: entire agent will be deleted)" : "") +
      (hasOpen ? " (WARNING: open sessions selected)" : "") +
      (DRY_RUN ? " (dry-run — no files will be changed)" : "") +
      " Proceed?",
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel("Cancelled.");
    return;
  }

  let totalTrashed = 0;
  let totalSize = 0;

  // Delete entire agent
  if (deleteAgent) {
    log.step(`${DRY_RUN ? "[dry-run] Would trash" : "Trashing"} entire agent: ${AGENT_ID} (${fmt(agentSize)})`);
    appendAudit(`DELETE_AGENT ${AGENT_ID} ${agentDir}`);
    if (await trashFile(trashCmd, agentDir)) {
      totalTrashed++;
      totalSize += agentSize;
    }
    outro(`Done. Freed ${fmt(totalSize)}.`);
    return;
  }

  // Trash legacy sessions
  for (const s of sessions) {
    if (!selectedIds.includes(s.id)) continue;

    log.step(`Trashing session ${s.id} (${fmt(s.size)})`);
    appendAudit(`DELETE_SESSION ${s.id} ${s.file}`);
    if (await trashFile(trashCmd, s.file)) {
      totalTrashed++;
      totalSize += s.size;
    }

    const tjf = path.join(sessionDir, `${s.id}.trajectory.jsonl`);
    if (fs.existsSync(tjf)) {
      const tsz = fs.statSync(tjf).size;
      appendAudit(`DELETE_COMPANION ${s.id} ${tjf}`);
      if (await trashFile(trashCmd, tjf)) {
        totalSize += tsz;
      }
    }

    const tpjf = path.join(sessionDir, `${s.id}.trajectory-path.json`);
    if (fs.existsSync(tpjf)) {
      const psz = fs.statSync(tpjf).size;
      appendAudit(`DELETE_COMPANION ${s.id} ${tpjf}`);
      if (await trashFile(trashCmd, tpjf)) {
        totalSize += psz;
      }
    }

    if (sessionsJson) {
      const p = path.join(sessionDir, "sessions.json");
      const updated = Object.fromEntries(
        Object.entries(sessionsJson).filter(
          ([, v]) =>
            !v ||
            (v.sessionId !== s.id &&
              !(typeof v.sessionFile === "string" && v.sessionFile.includes(s.id)))
        )
      );
      if (!DRY_RUN) {
        fs.writeFileSync(p, JSON.stringify(updated, null, 2));
      }
      sessionsJson = updated;
    }
  }

  // Remove orphans
  for (const o of orphans) {
    if (!selectedOrphanIds.includes(o.id)) continue;

    log.step(`Removing orphaned session ${o.id} from sessions.json`);
    appendAudit(`DELETE_ORPHAN ${o.id}`);
    if (sessionsJson) {
      const p = path.join(sessionDir, "sessions.json");
      const updated = Object.fromEntries(
        Object.entries(sessionsJson).filter(([, v]) => !v || v.sessionId !== o.id)
      );
      if (!DRY_RUN) {
        fs.writeFileSync(p, JSON.stringify(updated, null, 2));
      }
      sessionsJson = updated;
      totalTrashed++;
    }
  }

  // Clean selected stale items
  const cleanedDeletedBaseIds = new Set();
  for (const item of staleItems) {
    if (!selectedStaleValues.has(item.value)) continue;

    if (item.type === "archive") {
      log.step(`Trashing archive folder (${fmt(item.size)})`);
      appendAudit(`DELETE_ARCHIVE ${item.file}`);
      if (await trashFile(trashCmd, item.file)) {
        totalTrashed++;
        totalSize += item.size;
      }
      continue;
    }

    log.step(`Trashing stale file ${path.basename(item.file)} (${fmt(item.size)})`);
    appendAudit(`DELETE_STALE ${item.file}`);
    if (await trashFile(trashCmd, item.file)) {
      totalTrashed++;
      totalSize += item.size;
    }

    for (const companion of item.companions) {
      const csz = fs.statSync(companion).size;
      appendAudit(`DELETE_STALE_COMPANION ${companion}`);
      if (await trashFile(trashCmd, companion)) {
        totalSize += csz;
      }
    }

    if (item.type === "deleted" && item.baseid) {
      cleanedDeletedBaseIds.add(item.baseid);
    }
  }

  if (cleanedDeletedBaseIds.size > 0 && sessionsJson) {
    const p = path.join(sessionDir, "sessions.json");
    const updated = Object.fromEntries(
      Object.entries(sessionsJson).filter(
        ([, v]) => !v || !cleanedDeletedBaseIds.has(v.sessionId)
      )
    );
    if (!DRY_RUN) {
      fs.writeFileSync(p, JSON.stringify(updated, null, 2));
    }
  }

  // Clean legacy import archive
  for (const dir of selectedImportArchive) {
    const item = importArchive;
    if (!item || item.dir !== dir) continue;

    log.step(`${DRY_RUN ? "[dry-run] Would trash" : "Trashing"} legacy import archive (${fmt(item.size)})`);
    appendAudit(`DELETE_IMPORT_ARCHIVE ${item.dir}`);
    if (await trashFile(trashCmd, item.dir)) {
      totalTrashed++;
      totalSize += item.size;
    }
  }

  // Clean DB backups / temp files
  for (const file of selectedDbBackups) {
    const backup = dbBackups.find((b) => b.file === file);
    if (!backup) continue;

    log.step(`${DRY_RUN ? "[dry-run] Would trash" : "Trashing"} DB backup ${backup.name} (${fmt(backup.size)})`);
    appendAudit(`DELETE_DB_BACKUP ${backup.file}`);
    if (await trashFile(trashCmd, backup.file)) {
      totalTrashed++;
      totalSize += backup.size;
    }
  }

  appendAudit(`SUMMARY agent=${AGENT_ID} trashed=${totalTrashed} freed=${totalSize}`);
  outro(`Done. Freed ${fmt(totalSize)} (${totalTrashed} items).`);
}

async function main() {
  parseArgs();

  const trashCmd = detectTrashCmd();
  if (!trashCmd) {
    console.error(
      "Error: No trash command found. Install trash-cli: npm install -g trash-cli"
    );
    process.exit(1);
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");

  if (DRY_RUN) {
    log.info("Dry-run mode enabled — no files will be changed.");
  }

  intro("Session Cleanup");

  if (CLI_AGENT) {
    const agentsDir = path.join(stateDir, "agents");
    if (!fs.existsSync(path.join(agentsDir, CLI_AGENT))) {
      console.error(`Error: Agent not found: ${CLI_AGENT}`);
      process.exit(1);
    }
    await cleanupAgent(stateDir, CLI_AGENT, trashCmd);
    return;
  }

  while (true) {
    const AGENT_ID = await selectAgent(stateDir);

    if (AGENT_ID === "__done__") {
      outro("Goodbye.");
      break;
    }

    await cleanupAgent(stateDir, AGENT_ID, trashCmd);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
