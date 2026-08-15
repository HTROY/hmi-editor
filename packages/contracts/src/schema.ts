// ============================================================
// 轻量 JSON Schema（draft-07 子集）校验器
//
// 用于契约测试与运行时校验，支持：$ref（仅 #/definitions/*）、type
// （含数组多类型）、const、enum、properties/required、items、anyOf。
// 未知字段不校验（additionalProperties 默认宽松），与后端 serde
// `#[serde(default)]` 语义对齐。零依赖，Node/浏览器均可用。
// ============================================================

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  description?: string;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true; // 未识别类型不拦截
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
      )
    );
  }
  return false;
}

function refName(schema: JsonSchema): string | null {
  const ref = schema.$ref;
  if (!ref) return null;
  const m = /^#\/definitions\/(.+)$/.exec(ref);
  return m ? m[1] : null;
}

/**
 * 校验 value 是否符合 schema，返回错误信息数组（空数组 = 通过）。
 */
export function validateJson(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = "$"
): string[] {
  const errors: string[] = [];

  // $ref 解析（仅支持本地 #/definitions/*）
  const ref = refName(schema);
  if (ref !== null) {
    const target = root.definitions?.[ref];
    if (!target) {
      errors.push(`${path}: 无法解析 $ref "${schema.$ref}"`);
      return errors;
    }
    return validateJson(value, target, root, path);
  }

  // 多类型
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: 类型不匹配，期望 ${types.join("|")}`);
      return errors;
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: 期望常量 ${JSON.stringify(schema.const)}`);
  }

  if (
    schema.enum !== undefined &&
    !schema.enum.some((e) => deepEqual(value, e))
  ) {
    errors.push(`${path}: 不在枚举范围内 ${JSON.stringify(schema.enum)}`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateJson(item, schema.items!, root, `${path}[${i}]`));
    });
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    schema.properties
  ) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${path}: 缺少必填字段 "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) {
        errors.push(...validateJson(obj[key], sub, root, `${path}.${key}`));
      }
    }
  }

  if (schema.anyOf) {
    const matched = schema.anyOf.some(
      (sub) => validateJson(value, sub, root, path).length === 0
    );
    if (!matched) {
      errors.push(`${path}: 不满足 anyOf 任一分支`);
    }
  }

  return errors;
}

/** 校验是否通过（无错误） */
export function isValidJson(value: unknown, schema: JsonSchema): boolean {
  return validateJson(value, schema).length === 0;
}
