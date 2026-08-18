// ============================================================
// F12 ④ — 前后端共享报警引擎夹具对拍测试
//
// 与 io-backend/crates/alarm/src/engine/parity.rs 读取同一份
// packages/contracts/src/alarm-fixtures.json，驱动前端 LocalAlarmEngine
// 逐 case 断言 observable 状态，保证本地仿真引擎与后端 Rust 引擎
// （高限/滞回/确认延时/变位/质量保持/确认）语义一致。
//
// steps 语义（与 Rust 测试对齐）：
//   point: 喂入点位值；tick: 推进虚拟时钟越过确认延时；ack: 确认首条活跃报警。
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../packages/contracts/src/alarm-fixtures.json";
import { VariableManager } from "../variables/VariableManager";
import { LocalAlarmEngine } from "./LocalAlarmEngine";
import type { AlarmRule } from "./types";

interface FixtureCase {
  name: string;
  rule: AlarmRule;
  steps: (
    | { point: { value: number; quality: string } }
    | { tick: Record<string, never> }
    | { ack: Record<string, never> }
  )[];
  expect: { active: number; recoveredUnacked: number }[];
}

interface Fixture {
  cases: FixtureCase[];
}

const fixture = fixtures as Fixture;

afterEach(() => {
  vi.useRealTimers();
});

describe("alarm engine fixture parity (F12)", () => {
  it("shares the same cases with the Rust engine", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(fixture.cases.map((c) => c.name)).toEqual([
      "high-trigger-and-recover",
      "hysteresis-keeps-alarm-in-band",
      "confirm-delay-fires-after-deadline",
      "change-condition-is-transient",
      "quality-hold-skips-recovery",
      "ack-active-occurrence",
    ]);
  });

  for (const case_ of fixture.cases) {
    it(`case: ${case_.name}`, async () => {
      expect(case_.steps.length).toBe(case_.expect.length);
      vi.useFakeTimers();

      const varManager = new VariableManager();
      varManager.define({
        id: case_.rule.variableId,
        name: "P1",
        type: "AI",
        address: "x",
        defaultValue: 0,
        unit: "",
        description: "",
        group: "测试",
        min: 0,
        max: 1000,
      });
      const engine = new LocalAlarmEngine(varManager);
      await engine.saveRule(case_.rule);
      engine.start();

      for (let i = 0; i < case_.steps.length; i++) {
        const step = case_.steps[i];
        if ("point" in step && step.point) {
          varManager.setValue(
            case_.rule.variableId,
            step.point.value,
            step.point.quality as "good" | "bad" | "uncertain"
          );
        } else if ("tick" in step) {
          vi.advanceTimersByTime(case_.rule.confirmMs + 200);
        } else if ("ack" in step) {
          const firstActive = engine
            .getActiveAlarms()
            .find((o) => o.status === "active");
          if (firstActive) await engine.acknowledge(firstActive.id);
        }
        const active = engine
          .getActiveAlarms()
          .filter((o) => o.status === "active").length;
        const recoveredUnacked = engine
          .getHistoryAlarms()
          .filter(
            (o) => o.status === "recovered" && o.acknowledgedAt == null
          ).length;
        const want = case_.expect[i];
        expect({ active, recoveredUnacked }).toEqual({
          active: want.active,
          recoveredUnacked: want.recoveredUnacked,
        });
      }

      engine.stop();
    });
  }
});
