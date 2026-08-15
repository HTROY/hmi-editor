import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SeverityTag, { SEVERITY_META, SEVERITY_OPTIONS } from "./SeverityTag";

describe("SeverityTag", () => {
  it("级别映射完整且与下拉选项一致", () => {
    expect(Object.keys(SEVERITY_META).sort()).toEqual([
      "critical",
      "major",
      "minor",
      "warning",
    ]);
    expect(SEVERITY_OPTIONS.map((o) => o.value).sort()).toEqual(
      Object.keys(SEVERITY_META).sort()
    );
  });

  it("渲染中文标签", () => {
    render(<SeverityTag severity="critical" />);
    expect(screen.getByText("紧急")).toBeInTheDocument();
  });
});
