// ============================================================
// 轻量 XML 解析器（core 层不依赖 DOM）
// 支持 SVG 常用语法：属性、嵌套、自闭合、注释、CDATA、DOCTYPE、
// 处理指令与常见实体。
// ============================================================

export type XmlNode =
  { type: "text"; text: string } | { type: "element"; element: XmlElement };

export interface XmlElement {
  /** 本地标签名（已去除命名空间前缀，如 svg:svg -> svg） */
  tagName: string;
  /** 原始标签名（保留前缀） */
  rawName: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** 按文档顺序排列的子节点（文本与元素交替） */
  nodes: XmlNode[];
  /** 元素内部直接文本（含 CDATA，未 trim） */
  text: string;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity[1].toLowerCase() === "x";
        const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) && code >= 0
          ? String.fromCodePoint(code)
          : match;
      }
      return ENTITY_MAP[entity] ?? match;
    }
  );
}

function localName(name: string): string {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(idx + 1);
}

function findTagEnd(input: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  throw new Error("XML 解析失败：标签未闭合");
}

function parseTagBody(body: string): {
  name: string;
  attributes: Record<string, string>;
} {
  const attributes: Record<string, string> = {};
  let i = 0;
  while (i < body.length && /\s/.test(body[i])) i++;
  const nameMatch = /^[^\s=/>]+/.exec(body.slice(i));
  if (!nameMatch) throw new Error("XML 解析失败：缺少标签名");
  const name = nameMatch[0];
  i += name.length;

  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    const keyMatch = /^[^\s=/>]+/.exec(body.slice(i));
    if (!keyMatch) throw new Error("XML 解析失败：属性格式错误");
    const key = keyMatch[0];
    i += key.length;
    while (i < body.length && /\s/.test(body[i])) i++;

    let value = "";
    if (body[i] === "=") {
      i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        const end = body.indexOf(quote, i + 1);
        if (end === -1) throw new Error("XML 解析失败：属性值引号未闭合");
        value = decodeEntities(body.slice(i + 1, end));
        i = end + 1;
      } else {
        const valueMatch = /^[^\s>]+/.exec(body.slice(i));
        value = decodeEntities(valueMatch?.[0] ?? "");
        i += valueMatch?.[0].length ?? 0;
      }
    }
    attributes[key] = value;
  }
  return { name, attributes };
}

/** 解析 XML 字符串，返回根元素 */
export function parseXml(input: string): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  while (i < input.length) {
    if (input[i] !== "<") {
      const next = input.indexOf("<", i);
      const end = next === -1 ? input.length : next;
      const text = decodeEntities(input.slice(i, end));
      if (stack.length > 0) {
        const el = stack[stack.length - 1];
        el.text += text;
        el.nodes.push({ type: "text", text });
      }
      i = end;
      continue;
    }

    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9);
      const content = input.slice(i + 9, end === -1 ? input.length : end);
      if (stack.length > 0) {
        const el = stack[stack.length - 1];
        el.text += content;
        el.nodes.push({ type: "text", text: content });
      }
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i);
      i = end === -1 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith("<!", i)) {
      const end = input.indexOf(">", i);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (input.startsWith("</", i)) {
      const end = input.indexOf(">", i);
      if (end === -1) throw new Error("XML 解析失败：结束标签未闭合");
      const name = input.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top) {
        throw new Error("XML 解析失败：多余的结束标签 </" + name + ">");
      }
      if (top.rawName !== name && top.tagName !== localName(name)) {
        throw new Error(
          "XML 解析失败：标签不匹配 <" + top.rawName + "> 与 </" + name + ">"
        );
      }
      i = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(input, i + 1);
    const raw = input.slice(i + 1, tagEnd);
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const { name, attributes } = parseTagBody(body);
    const el: XmlElement = {
      tagName: localName(name),
      rawName: name,
      attributes,
      children: [],
      nodes: [],
      text: "",
    };
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      parent.children.push(el);
      parent.nodes.push({ type: "element", element: el });
    } else {
      if (root) throw new Error("XML 解析失败：存在多个根元素");
      root = el;
    }
    if (!selfClosing) stack.push(el);
    i = tagEnd + 1;
  }

  if (!root) throw new Error("XML 解析失败：空文档");
  if (stack.length > 0) {
    throw new Error(
      "XML 解析失败：未闭合的标签 <" + stack[stack.length - 1].rawName + ">"
    );
  }
  return root;
}

/** 读取属性（大小写不敏感，兼容 xlink:href 等） */
export function getAttr(el: XmlElement, name: string): string | undefined {
  if (el.attributes[name] !== undefined) return el.attributes[name];
  const lower = name.toLowerCase();
  const key = Object.keys(el.attributes).find((k) => k.toLowerCase() === lower);
  return key !== undefined ? el.attributes[key] : undefined;
}

/** 读取 href（优先 href，兼容 xlink:href） */
export function getHref(el: XmlElement): string | undefined {
  return getAttr(el, "href") ?? getAttr(el, "xlink:href");
}

/** 收集元素文本（含子元素文本，如 <text><tspan>…</tspan></text>） */
export function collectText(el: XmlElement): string {
  let out = "";
  for (const node of el.nodes) {
    out += node.type === "text" ? node.text : collectText(node.element);
  }
  return out;
}
