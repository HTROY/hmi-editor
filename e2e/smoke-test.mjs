#!/usr/bin/env node
// ============================================================
// E2E smoke regression: backend + plugins + WS push (F21 入门版)
//
// Spins up the real HMI I/O backend against a throwaway SQLite DB
// and the local test-servers (iec104-slave / opcua-server), then
// asserts the full data path end to end:
//   1. plugins reach "connected" (monitor API)
//   2. point values arrive over WS with quality "good"
//   3. alarm rules are served over REST
//
// Requires (prebuilt):
//   - io-backend/target/debug/hmi-io-backend(.exe)
//   - io-backend/target/debug/iec104-slave(.exe)
//   - io-backend/target/debug/opcua-server(.exe)
//   - io-backend/plugins/{iec104,opc_ua,modbus_tcp}.wasm
// Override any binary path with HMI_BACKEND / HMI_IEC104_SLAVE /
// HMI_OPCUA_SERVER env vars.
//
// Run: node e2e/smoke-test.mjs   (or: npm run test:e2e)
// ============================================================

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

const ROOT = resolve(import.meta.dirname, "..");
const EXE = process.platform === "win32" ? ".exe" : "";

const BACKEND =
  process.env.HMI_BACKEND ||
  join(ROOT, "io-backend", "target", "debug", `hmi-io-backend${EXE}`);
const IEC104_SLAVE =
  process.env.HMI_IEC104_SLAVE ||
  join(ROOT, "io-backend", "target", "debug", `iec104-slave${EXE}`);
const OPCUA_SERVER =
  process.env.HMI_OPCUA_SERVER ||
  join(ROOT, "io-backend", "target", "debug", `opcua-server${EXE}`);
const PLUGIN_DIR = join(ROOT, "io-backend", "plugins");

const WAIT_PLUGIN_CONNECTED_MS = 30_000;
const WS_COLLECT_MS = 10_000;

function freePort() {
  return new Promise((resolvePort) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}

async function getJson(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function pass(msg) {
  console.log(`  ok: ${msg}`);
}

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  for (const [name, p] of [
    ["backend", BACKEND],
    ["iec104-slave", IEC104_SLAVE],
    ["opcua-server", OPCUA_SERVER],
  ]) {
    if (!existsSync(p)) {
      fail(
        `${name} binary not found at ${p} (build with scripts/build.ps1 first)`
      );
      return;
    }
  }
  for (const wasm of ["iec104.wasm", "opc_ua.wasm", "modbus_tcp.wasm"]) {
    if (!existsSync(join(PLUGIN_DIR, wasm))) {
      fail(`plugin ${wasm} not found in ${PLUGIN_DIR}`);
      return;
    }
  }

  const wsPort = await freePort();
  const webPort = await freePort();
  const iec104Port = await freePort();
  const opcuaPort = await freePort();
  const work = mkdtempSync(join(tmpdir(), "hmi-e2e-"));
  console.log(`temp dir: ${work}`);
  console.log(
    `ports: ws=${wsPort} web=${webPort} iec104=${iec104Port} opcua=${opcuaPort}`
  );

  const config = `server:
  host: "127.0.0.1"
  port: ${wsPort}
  web_port: ${webPort}
plugins:
  directory: "${PLUGIN_DIR.replace(/\\/g, "/")}"
  scan_interval_ms: 500
  instances:
    - name: "iec104"
      wasm_file: "iec104.wasm"
      config:
        host: "127.0.0.1"
        port: ${iec104Port}
        common_address: 1
      points:
        - id: "STA1_211_IA"
          address: "1003"
          data_type: "float32"
          var_type: "AI"
        - id: "STA1_BUS_VOLTAGE"
          address: "1005"
          data_type: "float32"
          var_type: "AI"
        - id: "STA1_FAN_1_STATUS"
          address: "3001"
          data_type: "bool"
          var_type: "DI"
    - name: "opc_ua"
      wasm_file: "opc_ua.wasm"
      config:
        endpoint: "opc.tcp://127.0.0.1:${opcuaPort}"
      points:
        - id: "STA1_TEMP_ZONE1"
          address: "ns=2;s=Temperature.Zone1"
          var_type: "AI"
alarm:
  enabled: true
  retention_alarm_days: 90
  retention_soe_days: 30
  rules:
    - id: "ALM_IA_OVER"
      variable_id: "iec104:STA1_211_IA"
      name: "A相过流"
      description: "A相电流超过1600A"
      severity: "major"
      group: "供电/400V"
      condition: "high"
      threshold: 1600
      enabled: true
      hysteresis: 0
      confirm_ms: 0
`;

  writeFileSync(join(work, "config.yaml"), config, "utf-8");

  const children = [];
  const logs = { iec104: "", opcua: "", backend: "" };
  try {
    const iec104 = spawn(IEC104_SLAVE, [String(iec104Port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    iec104.stdout.on("data", (d) => (logs.iec104 += d));
    iec104.stderr.on("data", (d) => (logs.iec104 += d));
    children.push(iec104);

    const opcua = spawn(OPCUA_SERVER, [String(opcuaPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    opcua.stdout.on("data", (d) => (logs.opcua += d));
    opcua.stderr.on("data", (d) => (logs.opcua += d));
    children.push(opcua);

    const backend = spawn(BACKEND, ["config.yaml"], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (d) => (logs.backend += d));
    backend.stderr.on("data", (d) => (logs.backend += d));
    children.push(backend);

    const api = `http://127.0.0.1:${webPort}/api`;

    // 1) plugins reach connected
    const overview = await waitFor(async () => {
      const snap = await getJson(`${api}/monitor/overview`);
      if (!snap || !Array.isArray(snap.plugins) || snap.plugins.length < 2)
        return null;
      const allConnected = snap.plugins.every((p) => p.connection_state === 2);
      return allConnected ? snap : null;
    }, WAIT_PLUGIN_CONNECTED_MS);
    if (!overview) {
      fail(
        `plugins did not reach connected within ${WAIT_PLUGIN_CONNECTED_MS}ms; ` +
          `backend log tail:\n${logs.backend.slice(-2000)}`
      );
      return;
    }
    for (const p of overview.plugins) {
      pass(`plugin '${p.name}' connected (${p.connection_label})`);
    }

    // 2) point values over WS with quality good
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/iscs/data`);
    const seenPoints = new Map(); // variableId -> quality
    let sawAlarmRules = false;
    let sawSnapshot = false;
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        sawSnapshot = true;
        for (const p of msg.data ?? []) seenPoints.set(p.id, p.quality);
      } else if (msg.type === "data") {
        for (const p of msg.data ?? []) seenPoints.set(p.id, p.quality);
      } else if (msg.type === "alarm_rules") {
        sawAlarmRules = Array.isArray(msg.data) && msg.data.length > 0;
      }
    });
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", resolveOpen, { once: true });
      ws.addEventListener(
        "error",
        () => rejectOpen(new Error("ws open failed")),
        { once: true }
      );
    });
    await sleep(WS_COLLECT_MS);
    ws.close();

    for (const id of [
      "iec104:STA1_211_IA",
      "iec104:STA1_BUS_VOLTAGE",
      "iec104:STA1_FAN_1_STATUS",
      "opc_ua:STA1_TEMP_ZONE1",
    ]) {
      const q = seenPoints.get(id);
      if (!q) {
        fail(
          `point '${id}' never arrived over WS (seen: ${[...seenPoints.keys()].join(", ")})`
        );
      } else if (q !== "good") {
        fail(`point '${id}' arrived with quality '${q}', want 'good'`);
      } else {
        pass(`WS point '${id}' quality=good`);
      }
    }
    if (!sawSnapshot) fail("no initial WS snapshot received");
    else pass("WS snapshot received");
    if (!sawAlarmRules) fail("no alarm_rules message over WS");
    else pass("WS alarm_rules received");

    // 3) alarm rules via REST
    const rules = await getJson(`${api}/alarm/rules`);
    if (!rules || rules.length === 0) {
      fail("GET /api/alarm/rules returned no rules");
    } else {
      const r = rules.find((x) => x.id === "ALM_IA_OVER");
      if (!r) fail("ALM_IA_OVER rule missing from REST");
      else {
        pass(`REST alarm rule '${r.id}' (${r.variableId ?? r.variable_id})`);
      }
    }

    if (process.exitCode) {
      console.log("\nbackend log tail:\n" + logs.backend.slice(-3000));
    } else {
      console.log("\nPASS: backend + plugins + WS push smoke regression");
    }
  } finally {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* already dead */
      }
    }
    await sleep(300);
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL: unexpected error", err);
  process.exitCode = 1;
});
