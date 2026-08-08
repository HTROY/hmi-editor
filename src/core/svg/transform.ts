import type { TransformMatrix } from "../types";

// ============================================================
// SVG transform 解析与矩阵运算
// 约定：multiply(a, b) 返回 a·b，即先应用 b 再应用 a，
// 与 SVG transform 列表“从左到右组合”一致。
// ============================================================

export const IDENTITY: TransformMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(
  m1: TransformMatrix,
  m2: TransformMatrix
): TransformMatrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function transformPoint(
  m: TransformMatrix,
  x: number,
  y: number
): { x: number; y: number } {
  return {
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
  };
}

function parseArgs(raw: string): number[] {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  return parts
    .map((p) => Number.parseFloat(p))
    .filter((n) => Number.isFinite(n));
}

function translate(tx: number, ty: number): TransformMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function scale(sx: number, sy: number): TransformMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function rotateRad(rad: number): TransformMatrix {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function skewX(rad: number): TransformMatrix {
  return { a: 1, b: 0, c: Math.tan(rad), d: 1, e: 0, f: 0 };
}

function skewY(rad: number): TransformMatrix {
  return { a: 1, b: Math.tan(rad), c: 0, d: 1, e: 0, f: 0 };
}

/** 解析 transform 属性；空/非法时返回单位矩阵 */
export function parseTransform(attr: string | undefined): TransformMatrix {
  if (!attr) return IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let result = IDENTITY;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr)) !== null) {
    const fn = match[1];
    const args = parseArgs(match[2]);
    let m = IDENTITY;
    switch (fn) {
      case "matrix":
        if (args.length >= 6) {
          m = {
            a: args[0],
            b: args[1],
            c: args[2],
            d: args[3],
            e: args[4],
            f: args[5],
          };
        }
        break;
      case "translate":
        m = translate(args[0] ?? 0, args[1] ?? 0);
        break;
      case "scale":
        m = scale(args[0] ?? 1, args[1] ?? args[0] ?? 1);
        break;
      case "rotate": {
        const deg = args[0] ?? 0;
        const rad = (deg * Math.PI) / 180;
        if (args.length >= 3) {
          const cx = args[1];
          const cy = args[2];
          m = multiply(
            translate(cx, cy),
            multiply(rotateRad(rad), translate(-cx, -cy))
          );
        } else {
          m = rotateRad(rad);
        }
        break;
      }
      case "skewX":
        m = skewX(((args[0] ?? 0) * Math.PI) / 180);
        break;
      case "skewY":
        m = skewY(((args[0] ?? 0) * Math.PI) / 180);
        break;
    }
    result = multiply(result, m);
  }
  return result;
}

export interface MatrixDecomposition {
  rotationDeg: number;
  sx: number;
  sy: number;
}

/**
 * 判断矩阵是否为“纯旋转 + 缩放”（无倾斜）。
 * 若成立返回分解结果；含倾斜时返回 null（调用方回退为路径）。
 */
export function decomposeRotateScale(
  m: TransformMatrix
): MatrixDecomposition | null {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  if (sx < 1e-9 || sy < 1e-9) return null;
  const rotationRad = Math.atan2(m.b, m.a);
  const sin = Math.sin(rotationRad);
  const cos = Math.cos(rotationRad);
  const expectedC = -sy * sin;
  const expectedD = sy * cos;
  if (Math.abs(m.c - expectedC) > 1e-6 || Math.abs(m.d - expectedD) > 1e-6) {
    return null;
  }
  return {
    rotationDeg: (rotationRad * 180) / Math.PI,
    sx,
    sy,
  };
}
