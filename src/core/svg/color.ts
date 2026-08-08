// ============================================================
// SVG 颜色解析：hex / rgb() / rgba() / hsl() / hsla() /
// 常用命名色 / currentColor，并支持透明度合成
// ============================================================

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  navy: "#000080",
  teal: "#008080",
  purple: "#800080",
  orange: "#ffa500",
  brown: "#a52a2a",
  pink: "#ffc0cb",
};

export function hexToRgb(hex: string): Rgb | null {
  let h = hex.replace(/^#/, "").trim();
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
  return { r, g, b };
}

export function rgbToRgb(input: string): Rgb | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(input.trim());
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const parseChannel = (v: string) => {
    if (v.endsWith("%")) {
      return (Number.parseFloat(v) / 100) * 255;
    }
    return Number.parseFloat(v);
  };
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
  return { r, g, b };
}

function hslToRgbValues(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const light = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

export function hslToRgb(input: string): Rgb | null {
  const m = /^hsla?\(([^)]+)\)$/i.exec(input.trim());
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = Number.parseFloat(parts[0]);
  const parsePct = (v: string) => Number.parseFloat(v) / 100;
  const s = parsePct(parts[1]);
  const l = parsePct(parts[2]);
  if ([h, s, l].some((v) => !Number.isFinite(v))) return null;
  return hslToRgbValues(h, s, l);
}

export function toRgb(color: string): Rgb | null {
  const value = color.trim();
  if (value.startsWith("#")) return hexToRgb(value);
  if (/^rgb/i.test(value)) return rgbToRgb(value);
  if (/^hsl/i.test(value)) return hslToRgb(value);
  const named = NAMED_COLORS[value.toLowerCase()];
  return named ? hexToRgb(named) : null;
}

/** 在颜色上叠加 alpha，输出 rgba() 字符串；无法解析时原样返回 */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1 - 1e-6) return color;
  const rgb = toRgb(color);
  if (!rgb) return color;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(
    rgb.b
  )}, ${a})`;
}

/** 规范化颜色：hex/rgb/hsl/命名色转小写 hex，无法解析时原样返回 */
export function normalizeColor(color: string): string {
  const value = color.trim();
  if (value === "none" || value === "transparent") return "transparent";
  if (value.startsWith("#")) {
    const rgb = hexToRgb(value);
    if (rgb) {
      return (
        "#" +
        [rgb.r, rgb.g, rgb.b]
          .map((v) => Math.round(v).toString(16).padStart(2, "0"))
          .join("")
      );
    }
    return value;
  }
  const rgb = /^rgb/i.test(value)
    ? rgbToRgb(value)
    : /^hsl/i.test(value)
      ? hslToRgb(value)
      : null;
  if (rgb) {
    return (
      "#" +
      [rgb.r, rgb.g, rgb.b]
        .map((v) => Math.round(v).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  const named = NAMED_COLORS[value.toLowerCase()];
  return named ?? value;
}
