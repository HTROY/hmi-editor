import { AlarmManager } from "../../src/core/alarm/AlarmManager";
import type { AlarmOccurrence, SOERecord } from "../../src/core/alarm/types";
import { VariableManager } from "../../src/core/variables/VariableManager";

interface MockWs {
  onAlarmMessage: (h: (m: { type: string; data?: any }) => void) => () => void;
  subscribe: (cb: {
    onData: () => void;
    onStatus: (s: string) => void;
    onError: () => void;
  }) => () => void;
}

function makeMockWs(): {
  ws: MockWs;
  emit: (m: { type: string; data?: any }) => void;
} {
  const handlers = new Set<(m: { type: string; data?: any }) => void>();
  const ws: MockWs = {
    onAlarmMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    subscribe: () => () => {},
  };
  return {
    ws,
    emit: (m) => {
      for (const h of handlers) h(m);
    },
  };
}

function occ(id: string, status: AlarmOccurrence["status"]): AlarmOccurrence {
  return {
    id,
    ruleId: "R1",
    variableId: "P1",
    name: "高限",
    severity: "major",
    group: "测试",
    message: "P1 越限",
    value: 120,
    threshold: 100,
    status,
    triggeredAt: 1000,
    recoveredAt: null,
    recoveredReason: "",
    acknowledgedAt: null,
    acknowledgedBy: "",
  };
}

function soeRecord(seq: number): SOERecord {
  return {
    id: seq,
    seq,
    variableId: "P1",
    value: 120,
    quality: "good",
    deviceTime: 1000,
    receiveTime: 2000,
    source: "backend",
  };
}

function freshManager() {
  const { ws, emit } = makeMockWs();
  const am = new AlarmManager(new VariableManager());
  am.setMode("remote");
  am.setRemote(ws as any, "http://localhost:8081");
  return { am, emit };
}

const failures: string[] = [];

// Scenario 1: backend alarm_update trigger payload exactly as produced by
// io-backend/crates/alarm/src/persist.rs (event_type, occurrence)
{
  const { am, emit } = freshManager();
  emit({
    type: "alarm_update",
    data: {
      event_type: "trigger",
      occurrence: occ("OCC_TRIGGER", "active"),
    },
  });
  console.log("active after alarm_update:", am.getActiveAlarms().length);
  if (!am.getActiveAlarms().some((a) => a.id === "OCC_TRIGGER")) {
    failures.push("backend alarm_update trigger did not show in active list");
  }
}

// Scenario 2: alarm_snapshot (initial state on WS connect)
{
  const { am, emit } = freshManager();
  emit({ type: "alarm_snapshot", data: [occ("OCC_SNAP", "active")] });
  console.log("active after alarm_snapshot:", am.getActiveAlarms().length);
  if (!am.getActiveAlarms().some((a) => a.id === "OCC_SNAP")) {
    failures.push("alarm_snapshot did not populate active list");
  }
}

// Scenario 3: SOE push
{
  const { am, emit } = freshManager();
  emit({ type: "soe", data: [soeRecord(1)] });
  console.log("soe records:", am.getSOERecords().length);
  if (!am.getSOERecords().some((r) => r.seq === 1)) {
    failures.push("soe push did not populate SOE list");
  }
}

// Scenario 4: alarm_rules snapshot must populate the rule map in remote mode
{
  const { am, emit } = freshManager();
  emit({
    type: "alarm_rules",
    data: [
      {
        id: "R1",
        variableId: "P1",
        name: "高限",
        description: "",
        severity: "major",
        group: "测试",
        condition: "high",
        threshold: 100,
        enabled: true,
        hysteresis: 0,
        confirmMs: 0,
      },
    ],
  });
  console.log("rules after alarm_rules:", am.listRules().length);
  if (!am.listRules().some((r) => r.id === "R1")) {
    failures.push("alarm_rules snapshot did not populate rule map");
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error("FAIL:", f);
  throw new Error("alarm remote flow regression test failed");
} else {
  console.log("PASS");
}
