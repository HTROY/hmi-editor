import { describe, expect, it } from "vitest";
import { errMsg } from "./error";

describe("errMsg", () => {
  it("Error 取 message", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
  });

  it("字符串原样返回", () => {
    expect(errMsg("原始字符串")).toBe("原始字符串");
  });

  it("null/undefined 归为未知错误", () => {
    expect(errMsg(null)).toBe("未知错误");
    expect(errMsg(undefined)).toBe("未知错误");
  });

  it("其他类型转字符串", () => {
    expect(errMsg(42)).toBe("42");
  });
});
