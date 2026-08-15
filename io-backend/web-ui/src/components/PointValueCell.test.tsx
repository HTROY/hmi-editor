import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PointValueCell, { formatPointValue } from "./PointValueCell";

describe("formatPointValue", () => {
  it("null/undefined 显示 --", () => {
    expect(formatPointValue(null)).toBe("--");
    expect(formatPointValue(undefined)).toBe("--");
  });

  it("整型数字原样、小数保留 3 位", () => {
    expect(formatPointValue(12)).toBe("12");
    expect(formatPointValue(12.34567)).toBe("12.346");
  });

  it("布尔显示 1/0", () => {
    expect(formatPointValue(true)).toBe("1");
    expect(formatPointValue(false)).toBe("0");
  });
});

describe("PointValueCell", () => {
  it("渲染等宽点值", () => {
    render(<PointValueCell value={12.5} />);
    const el = screen.getByText("12.500");
    expect(el).toHaveClass("mono");
    expect(el).toHaveStyle({ fontWeight: 600 });
  });

  it("stale 时降为继承色并半透明", () => {
    render(<PointValueCell value={null} stale color="#22c55e" />);
    const el = screen.getByText("--");
    expect(el).toHaveStyle({ opacity: 0.4 });
  });
});
