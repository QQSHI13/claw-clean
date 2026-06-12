#!/usr/bin/env node
// Session Cleanup Tool — @clack/prompts TUI
// Version: 2.5.0
// Usage: claw-clean [-h] [--doctor]

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

const VERSION = "2.5.0";

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

// ── Argument parsing ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      console.log(`Session Cleanup Tool

Usage: claw-clean [-h] [--doctor]

Flags:
  -h, --help         Show this help
      --doctor       Check environment and dependencies
`);
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === "--doctor") {
      runDoctor();
      process.exit(0);
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

// ── Session data ──────────────────────────────────────────────────
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

function gatherData(sessionDir, archiveDir, sessionsJson) {
  const sessions = [];
  const seenIds = new Set();
  let sSize = 0;
  let openC = 0;
  let activeC = 0;

  if (fs.existsSync(sessionDir)) {
    for (const entry of fs.readdirSync(sessionDir)) {
      const f = path.join(sessionDir, entry);
      if (!fs.statSync(f).isFile()) continue;
      if (!entry.endsWith(".jsonl")) continue;
      if (entry.endsWith(".trajectory.jsonl")) continue;
      if (entry.includes(".bak")) continue;
      if (entry.startsWith(".")) continue;
      if (entry.includes(".checkpoint.")) continue;
      if (entry.includes(".deleted.")) continue;

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
  }

  // Orphans: entries in sessions.json with sessionId but no file
  const orphans = [];
  if (sessionsJson) {
    for (const [key, value] of Object.entries(sessionsJson)) {
      if (!value || typeof value.sessionId !== "string") continue;
      const id = value.sessionId;
      if (seenIds.has(id)) continue;
      if (sessFileExists(id, sessionDir, sessionsJson)) continue;
      orphans.push({ id, key });
    }
  }

  // Stale data items (each displayed as its own selectable row)
  const staleItems = [];
  let staleSize = 0;

  if (fs.existsSync(sessionDir)) {
    for (const entry of fs.readdirSync(sessionDir)) {
      const f = path.join(sessionDir, entry);
      if (!fs.statSync(f).isFile()) continue;

      if (entry.includes(".deleted.")) {
        const sz = fs.statSync(f).size;
        const baseid = entry.split(".jsonl.deleted.")[0];
        const companions = [];

        const tjf = path.join(sessionDir, `${baseid}.trajectory.jsonl`);
        if (fs.existsSync(tjf)) companions.push(tjf);

        const tpjf = path.join(sessionDir, `${baseid}.trajectory-path.json`);
        if (fs.existsSync(tpjf)) companions.push(tpjf);

        const companionsSize = companions.reduce((sum, c) => sum + fs.statSync(c).size, 0);
        staleItems.push({
          type: "deleted",
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

      if (entry.includes(".bak")) {
        const sz = fs.statSync(f).size;
        staleItems.push({
          type: "bak",
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
  }

  if (fs.existsSync(archiveDir)) {
    const archiveEntries = fs.readdirSync(archiveDir).filter((e) =>
      fs.statSync(path.join(archiveDir, e)).isFile()
    );
    if (archiveEntries.length > 0) {
      const archiveSize = archiveEntries.reduce(
        (sum, e) => sum + fs.statSync(path.join(archiveDir, e)).size,
        0
      );
      staleItems.push({
        type: "archive",
        value: `stale:archive`,
        file: archiveDir,
        label: `archive/ — ${archiveEntries.length} items, ${fmt(archiveSize)}`,
        hint: "folder",
        size: archiveSize,
        companions: [],
      });
      staleSize += archiveSize;
    }
  }

  return {
    sessions,
    orphans,
    staleItems,
    staleSize,
    sSize,
    openC,
    activeC,
  };
}

// ── Main ──────────────────────────────────────────────────────────
async function cleanupAgent(stateDir, AGENT_ID, trashCmd) {
  const sessionDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
  const archiveDir = path.join(sessionDir, "archive");

  if (!fs.existsSync(sessionDir)) {
    console.error(`Error: No session directory: ${sessionDir}`);
    process.exit(1);
  }

  const sessionsJson = loadSessionsJson(sessionDir);
  const { sessions, orphans, staleItems, staleSize, sSize, openC, activeC } =
    gatherData(sessionDir, archiveDir, sessionsJson);

  intro(`Session Cleanup — Agent: ${AGENT_ID}`);

  note(
    `Sessions: ${sessions.length} (${activeC} active, ${openC} open) — ${fmt(sSize)}` +
      (orphans.length > 0
        ? `\nOrphaned: ${orphans.length} (in sessions.json but no file)`
        : "") +
      (staleItems.length > 0
        ? `\nStale data: ${staleItems.length} items — ${fmt(staleSize)}`
        : ""),
    "Summary"
  );

  const groups = {};

  if (sessions.length > 0) {
    groups["Sessions"] = sessions.map((s) => ({
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
    (v) => !v.startsWith("orphan:") && !v.startsWith("stale:") && !v.startsWith("agent:")
  );
  const selectedOrphanIds = selectedValues
    .filter((v) => v.startsWith("orphan:"))
    .map((v) => v.slice("orphan:".length));
  const selectedStaleValues = new Set(selectedValues.filter((v) => v.startsWith("stale:")));
  const deleteAgent = selectedValues.includes("agent:delete");

  const totalCount =
    selectedIds.length + selectedOrphanIds.length + selectedStaleValues.size + (deleteAgent ? 1 : 0);

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
    log.step(`Trashing entire agent: ${AGENT_ID} (${fmt(agentSize)})`);
    appendAudit(`DELETE_AGENT ${AGENT_ID} ${agentDir}`);
    if (await trashFile(trashCmd, agentDir)) {
      totalTrashed++;
      totalSize += agentSize;
    }
    outro(`Done. Freed ${fmt(totalSize)}.`);
    return;
  }

  // Trash sessions
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
      fs.writeFileSync(p, JSON.stringify(updated, null, 2));
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
      fs.writeFileSync(p, JSON.stringify(updated, null, 2));
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

    if (item.type === "deleted") {
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
    fs.writeFileSync(p, JSON.stringify(updated, null, 2));
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

  intro("Session Cleanup");

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
