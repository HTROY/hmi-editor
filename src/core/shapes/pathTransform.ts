/**
 * SVG path 数据变换：按缩放系数改写所有坐标参数。
 * 仅缩放几何量（x/y/rx/ry），保持旋转角、大弧/扫掠标志不变。
 */

const TOKEN_RE =
  /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;

const ARITY: Record<string, number> = {
  M: 2,
  m: 2,
  L: 2,
  l: 2,
  T: 2,
  t: 2,
  H: 1,
  h: 1,
  V: 1,
  v: 1,
  C: 6,
  c: 6,
  S: 4,
  s: 4,
  Q: 4,
  q: 4,
  A: 7,
  a: 7,
  Z: 0,
  z: 0,
};

interface Segment {
  cmd: string;
  params: number[];
}

function parsePath(d: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const match of d.matchAll(TOKEN_RE)) {
    const cmd = match[1];
    if (cmd) {
      current = { cmd, params: [] };
      segments.push(current);
    } else if (match[2] !== undefined && current) {
      current.params.push(Number(match[2]));
    }
  }
  return segments;
}

function formatNum(v: number): string {
  const rounded = Math.round(v * 10000) / 10000;
  return String(rounded);
}

function transformSegment(seg: Segment, sx: number, sy: number): string {
  const parts: string[] = [];
  const arity = ARITY[seg.cmd] ?? 2;
  const isArc = seg.cmd === "A" || seg.cmd === "a";

  for (let i = 0; i < seg.params.length; i++) {
    let v = seg.params[i];
    if (arity === 1) {
      // H/h 只含 x，V/v 只含 y
      if (seg.cmd === "H" || seg.cmd === "h") v *= sx;
      else v *= sy;
    } else if (isArc) {
      // A/a 参数：rx ry x轴旋转 大弧标志 扫掠标志 x y
      const j = i % 7;
      if (j === 0 || j === 5) v *= sx;
      else if (j === 1 || j === 6) v *= sy;
    } else {
      const j = i % arity;
      if (j % 2 === 0) v *= sx;
      else v *= sy;
    }
    parts.push(formatNum(v));
  }
  return parts.length > 0 ? seg.cmd + parts.join(" ") : seg.cmd;
}

export function transformPathData(d: string, sx: number, sy: number): string {
  if (!d) return d;
  return parsePath(d)
    .map((seg) => transformSegment(seg, sx, sy))
    .join(" ");
}
