import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom 未实现带伪元素的 getComputedStyle；rc-motion 动画会以伪元素参数调用，
// 触发 virtual console 的 "Not implemented" 错误并被 vitest 判为未捕获异常。
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((el: Element) =>
  realGetComputedStyle(el)) as typeof window.getComputedStyle;

// antd v5 依赖 matchMedia（表格/弹窗响应式）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// ECharts 挂载需要 ResizeObserver
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in window)) {
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: ResizeObserverStub,
  });
}

// jsdom 不实现 URL.createObjectURL
Object.defineProperty(URL, "createObjectURL", {
  writable: true,
  value: vi.fn(() => "blob:mock"),
});
Object.defineProperty(URL, "revokeObjectURL", {
  writable: true,
  value: vi.fn(),
});
