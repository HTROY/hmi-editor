export { importSvg } from "./SvgImporter";
export type { SvgImportOptions, SvgImportResult } from "./SvgImporter";
export { parseXml, getAttr, getHref, collectText, decodeEntities } from "./xml";
export type { XmlElement } from "./xml";
export {
  parseTransform,
  multiply,
  transformPoint,
  decomposeRotateScale,
  IDENTITY,
} from "./transform";
export { normalizeColor, withAlpha, toRgb } from "./color";
