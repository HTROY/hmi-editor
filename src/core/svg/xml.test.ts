import { describe, expect, it } from "vitest";
import { collectText, decodeEntities, getAttr, getHref, parseXml } from "./xml";

describe("xml 解析器", () => {
  it("解析嵌套元素、属性与文本", () => {
    const root = parseXml(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g id="a"><rect x="1" y="2" width="10" height="20" /></g></svg>'
    );
    expect(root.tagName).toBe("svg");
    expect(getAttr(root, "viewBox")).toBe("0 0 100 50");
    const g = root.children[0];
    expect(g.tagName).toBe("g");
    expect(getAttr(g, "id")).toBe("a");
    const rect = g.children[0];
    expect(rect.tagName).toBe("rect");
    expect(Number(getAttr(rect, "width"))).toBe(10);
  });

  it("处理命名空间前缀、自闭合与注释", () => {
    const root = parseXml(
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><!-- 注释 --><svg:circle cx="5"/></svg:svg>'
    );
    expect(root.tagName).toBe("svg");
    expect(root.children[0].tagName).toBe("circle");
  });

  it("解码实体与 CDATA", () => {
    expect(decodeEntities("a &lt; b &amp;&#32;c &#x41;")).toBe("a < b & c A");
    const root = parseXml("<svg><text><![CDATA[1 < 2 && 3 > 1]]></text></svg>");
    expect(root.children[0].text.trim()).toBe("1 < 2 && 3 > 1");
  });

  it("collectText 汇总子元素文本", () => {
    const root = parseXml(
      "<svg><text>Hello <tspan>World</tspan>!</text></svg>"
    );
    expect(collectText(root.children[0])).toBe("Hello World!");
  });

  it("getHref 兼容 xlink:href", () => {
    const root = parseXml(
      '<svg><image xlink:href="data:image/png;base64,AA=="/></svg>'
    );
    expect(getHref(root.children[0])).toBe("data:image/png;base64,AA==");
  });

  it("未闭合标签与多根元素抛错", () => {
    expect(() => parseXml("<svg><rect></svg>")).toThrow();
    expect(() => parseXml("<a/><b/>")).toThrow();
    expect(() => parseXml("")).toThrow();
  });
});
