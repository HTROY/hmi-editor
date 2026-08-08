/**
 * SVG path 数据变换：按缩放系数改写所有坐标参数。
 * 仅缩放几何量（x/y/rx/ry），保持旋转角、大弧/扫掠标志不变。
 * 另提供仿射矩阵变换与包围盒计算，供 SVG 矢量导入使用。
 */
import type { BoundingBox, TransformMatrix } from "../types";

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

interface AbsoluteSegment {
  cmd: "M" | "L" | "C" | "S" | "Q" | "T" | "A" | "Z";
  pts: number[];
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

/** 把路径归一化为绝对坐标段（H/V 转为 L，相对命令转为绝对） */
function toAbsoluteSegments(d: string): AbsoluteSegment[] {
  const out: AbsoluteSegment[] = [];
  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };

  for (const seg of parsePath(d)) {
    const upper = seg.cmd.toUpperCase() as keyof typeof ARITY;
    const rel = seg.cmd !== upper && seg.cmd !== "z";
    const arity = ARITY[upper] ?? 2;
    if (arity === 0) {
      if (upper === "Z") out.push({ cmd: "Z", pts: [] });
      continue;
    }

    const groups: number[][] = [];
    for (let i = 0; i < seg.params.length; i += arity) {
      groups.push(seg.params.slice(i, i + arity));
    }

    for (let g = 0; g < groups.length; g++) {
      const p = groups[g];
      let cmd: AbsoluteSegment["cmd"];
      if (upper === "M") cmd = g === 0 ? "M" : "L";
      else if (upper === "H" || upper === "V") cmd = "L";
      else cmd = upper as AbsoluteSegment["cmd"];

      if (cmd === "M" || cmd === "L" || cmd === "T") {
        let x: number;
        let y: number;
        if (upper === "H") {
          x = rel ? cur.x + p[0] : p[0];
          y = cur.y;
        } else if (upper === "V") {
          x = cur.x;
          y = rel ? cur.y + p[0] : p[0];
        } else {
          x = rel ? cur.x + p[0] : p[0];
          y = rel ? cur.y + p[1] : p[1];
        }
        const pt = { x, y };
        out.push({ cmd, pts: [pt.x, pt.y] });
        cur = pt;
        if (cmd === "M") start = pt;
        continue;
      }

      if (cmd === "C" || cmd === "S" || cmd === "Q") {
        const pts: number[] = [];
        for (let i = 0; i < p.length; i += 2) {
          const x = rel ? cur.x + p[i] : p[i];
          const y = rel ? cur.y + p[i + 1] : p[i + 1];
          pts.push(x, y);
        }
        out.push({ cmd, pts });
        cur = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
        continue;
      }

      if (cmd === "A") {
        const x = rel ? cur.x + p[5] : p[5];
        const y = rel ? cur.y + p[6] : p[6];
        out.push({
          cmd: "A",
          pts: [p[0], p[1], p[2], p[3], p[4], x, y],
        });
        cur = { x, y };
        continue;
      }

      if (cmd === "Z") {
        out.push({ cmd: "Z", pts: [] });
        cur = start;
      }
    }
  }
  return out;
}

/** 用 2D 仿射矩阵变换路径（所有坐标转绝对后逐点变换，弧半径按矩阵缩放） */
export function transformPathDataMatrix(d: string, m: TransformMatrix): string {
  if (!d) return d;
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const rotDeg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  const tx = (x: number, y: number) => ({
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
  });

  return toAbsoluteSegments(d)
    .map((seg) => {
      if (seg.cmd === "Z") return "Z";
      if (seg.cmd === "A") {
        const [rx, ry, rot, laf, sf, x, y] = seg.pts;
        const end = tx(x, y);
        return (
          "A " +
          formatNum(Math.abs(rx * sx)) +
          " " +
          formatNum(Math.abs(ry * sy)) +
          " " +
          formatNum(rot + rotDeg) +
          " " +
          laf +
          " " +
          sf +
          " " +
          formatNum(end.x) +
          " " +
          formatNum(end.y)
        );
      }
      const pts: string[] = [];
      for (let i = 0; i < seg.pts.length; i += 2) {
        const p = tx(seg.pts[i], seg.pts[i + 1]);
        pts.push(formatNum(p.x), formatNum(p.y));
      }
      return seg.cmd + pts.join(" ");
    })
    .join(" ");
}

/** 平移路径数据 */
export function translatePathData(d: string, dx: number, dy: number): string {
  return transformPathDataMatrix(d, {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: dx,
    f: dy,
  });
}

/** SVG 椭圆弧端点参数化 -> 中心参数化并采样 */
function sampleArcPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  phiDeg: number,
  largeArc: number,
  sweep: number,
  samples = 12
): { x: number; y: number }[] {
  if (rx <= 0 || ry <= 0) return [{ x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let rxs = Math.abs(rx);
  let rys = Math.abs(ry);
  const lambda = (x1p * x1p) / (rxs * rxs) + (y1p * y1p) / (rys * rys);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rxs *= s;
    rys *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num =
    rxs * rxs * rys * rys - rxs * rxs * y1p * y1p - rys * rys * x1p * x1p;
  const den = rxs * rxs * y1p * y1p + rys * rys * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / Math.max(1e-9, den)));
  const cxp = coef * ((rxs * y1p) / rys);
  const cyp = coef * ((-rys * x1p) / rxs);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rxs;
  const uy = (y1p - cyp) / rys;
  const vx = (-x1p - cxp) / rxs;
  const vy = (-y1p - cyp) / rys;
  let startAngle = Math.atan2(uy, ux);
  let deltaAngle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  else if (sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const theta = startAngle + (deltaAngle * i) / samples;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    points.push({
      x: cx + rxs * cosTheta * cosPhi - rys * sinTheta * sinPhi,
      y: cy + rxs * cosTheta * sinPhi + rys * sinTheta * cosPhi,
    });
  }
  return points;
}

/** 路径包围盒（控制点参与计算，宁大勿小） */
export function getPathBounds(d: string): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let currentX = 0;
  let currentY = 0;
  const push = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const seg of toAbsoluteSegments(d)) {
    if (seg.cmd === "Z") continue;
    if (seg.cmd === "A") {
      const [rx, ry, rot, laf, sf, x, y] = seg.pts;
      for (const p of sampleArcPoints(
        currentX,
        currentY,
        x,
        y,
        rx,
        ry,
        rot,
        laf,
        sf
      )) {
        push(p.x, p.y);
      }
      currentX = x;
      currentY = y;
      continue;
    }
    for (let i = 0; i < seg.pts.length; i += 2) {
      push(seg.pts[i], seg.pts[i + 1]);
      currentX = seg.pts[i];
      currentY = seg.pts[i + 1];
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: minX,
    y: minY,
    width: Math.max(1e-6, maxX - minX) || 1,
    height: Math.max(1e-6, maxY - minY) || 1,
  };
}
