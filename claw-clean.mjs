#!/usr/bin/env node
// Session Cleanup Tool — @clack/prompts TUI
// Version: 2.1.0
// Usage: claw-clean [-a agent] [-h]

import {
  intro,
  outro,
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

const VERSION = "2.1.0";
let AGENT_ID = "main";

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

async function trashFile(trashCmd, filePath) {
  if (!fs.existsSync(filePath)) {
    log.warn(`${filePath} does not exist, skipping`);
    return false;
  }
  return new Promise((resolve) => {
    const [cmd, ...args] = [...trashCmd, filePath];
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// ── Argument parsing ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a" || arg === "--agent") {
      const val = args[++i];
      if (!val) {
        console.error("Error: --agent requires a value");
        process.exit(1);
      }
      AGENT_ID = val;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Session Cleanup Tool

Usage: claw-clean [-a agent] [-h]

Flags:
  -a, --agent <id>   Target agent (default: main)
  -h, --help         Show this help
`);
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else {
      console.error(`Error: Unknown flag: ${arg}. Use -h for help.`);
      process.exit(1);
    }
  }
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
      label: `${s.id}${s.key ? ` (${s.key})` : ""} — ${fmt(s.size)} (${s.age}d, ${s.status})`,
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

  let selected = [];
  if (Object.keys(groups).length > 0) {
    selected = await groupMultiselect({
      message: "Select sessions / cleanup actions:",
      options: groups,
      required: false,
      selectableGroups: false,
    });

    if (isCancel(selected)) {
      cancel("Cancelled.");
      process.exit(0);
    }
  }

  const selectedIds = selected.filter((v) => !v.startsWith("orphan:") && !v.startsWith("stale:"));
  const selectedOrphanIds = selected
    .filter((v) => v.startsWith("orphan:"))
    .map((v) => v.slice("orphan:".length));
  const selectedStaleValues = new Set(selected.filter((v) => v.startsWith("stale:")));

  const totalCount = selectedIds.length + selectedOrphanIds.length + selectedStaleValues.size;

  if (totalCount === 0) {
    outro("Nothing selected.");
    process.exit(0);
  }

  const hasOpen = sessions.some((s) => selectedIds.includes(s.id) && s.status === "OPEN");

  const confirmed = await confirm({
    message:
      `${totalCount} item(s) selected for cleanup.` +
      (hasOpen ? " (WARNING: open sessions selected)" : "") +
      " Proceed?",
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel("Cancelled.");
    process.exit(0);
  }

  let totalTrashed = 0;
  let totalSize = 0;

  // Trash sessions
  for (const s of sessions) {
    if (!selectedIds.includes(s.id)) continue;

    log.step(`Trashing session ${s.id} (${fmt(s.size)})`);
    if (await trashFile(trashCmd, s.file)) {
      totalTrashed++;
      totalSize += s.size;
    }

    const tjf = path.join(sessionDir, `${s.id}.trajectory.jsonl`);
    if (fs.existsSync(tjf)) {
      const tsz = fs.statSync(tjf).size;
      if (await trashFile(trashCmd, tjf)) {
        totalSize += tsz;
      }
    }

    const tpjf = path.join(sessionDir, `${s.id}.trajectory-path.json`);
    if (fs.existsSync(tpjf)) {
      const psz = fs.statSync(tpjf).size;
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
      if (await trashFile(trashCmd, item.file)) {
        totalTrashed++;
        totalSize += item.size;
      }
      continue;
    }

    log.step(`Trashing stale file ${path.basename(item.file)} (${fmt(item.size)})`);
    if (await trashFile(trashCmd, item.file)) {
      totalTrashed++;
      totalSize += item.size;
    }

    for (const companion of item.companions) {
      const csz = fs.statSync(companion).size;
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

  outro(`Done. Trashed ${totalTrashed} items (${fmt(totalSize)} total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
