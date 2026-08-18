import type { ValueMapping } from "../../core/types";

// ============================================================
// MappingEditor — 值映射编辑器（绑定面板与动画面板共用）
// 支持直接值 / 范围映射 / 枚举映射；绑定面板可开启颜色选择器
// ============================================================

export function MappingEditor({
  mapping,
  onChange,
  colorPickers = false,
  showStateColor = true,
  enumPlaceholders = ["#808080", "#00FF00"],
}: {
  mapping: ValueMapping;
  onChange: (m: ValueMapping) => void;
  colorPickers?: boolean;
  showStateColor?: boolean;
  enumPlaceholders?: [string, string];
}) {
  return (
    <div className="binding-mapping-config">
      <div className="prop-group">
        <label>映射</label>
        <select
          value={mapping.type}
          onChange={(e) => {
            const type = e.target.value as ValueMapping["type"];
            if (type === "range") {
              onChange({ type: "range", from: [0, 100], to: [0, 1] });
            } else if (type === "enum") {
              onChange({ type: "enum", map: { "0": "", "1": "" } });
            } else if (type === "direct" || type === "stateColor") {
              onChange({ type });
            }
            // type "bitmask" 不在选择器中表达，无需处理
          }}
        >
          <option value="direct">直接值</option>
          <option value="range">范围映射</option>
          <option value="enum">枚举映射</option>
          {showStateColor && <option value="stateColor">状态颜色</option>}
        </select>
      </div>

      {mapping.type === "range" && (
        <>
          <div className="prop-group">
            <label>输入范围</label>
            <input
              type="number"
              style={{ width: "45%" }}
              value={mapping.from[0] ?? 0}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  from: [Number(e.target.value), mapping.from[1]] as [
                    number,
                    number,
                  ],
                })
              }
            />
            <span>~</span>
            <input
              type="number"
              style={{ width: "45%" }}
              value={mapping.from[1] ?? 100}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  from: [mapping.from[0], Number(e.target.value)] as [
                    number,
                    number,
                  ],
                })
              }
            />
          </div>
          <div className="prop-group">
            <label>输出范围</label>
            <input
              type="number"
              step={0.1}
              style={{ width: "45%" }}
              value={mapping.to[0] ?? 0}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  to: [Number(e.target.value), mapping.to[1]] as [
                    number,
                    number,
                  ],
                })
              }
            />
            <span>~</span>
            <input
              type="number"
              step={0.1}
              style={{ width: "45%" }}
              value={mapping.to[1] ?? 1}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  to: [mapping.to[0], Number(e.target.value)] as [
                    number,
                    number,
                  ],
                })
              }
            />
          </div>
        </>
      )}

      {mapping.type === "enum" && (
        <div className="binding-mapping-config">
          <div className="prop-group">
            <label>0→</label>
            <input
              value={mapping.map["0"] ?? ""}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  map: { ...mapping.map, "0": e.target.value },
                })
              }
              placeholder={enumPlaceholders[0]}
            />
            {colorPickers && (
              <input
                type="color"
                value={mapping.map["0"] || "#808080"}
                onChange={(e) =>
                  onChange({
                    ...mapping,
                    map: { ...mapping.map, "0": e.target.value },
                  })
                }
              />
            )}
          </div>
          <div className="prop-group">
            <label>1→</label>
            <input
              value={mapping.map["1"] ?? ""}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  map: { ...mapping.map, "1": e.target.value },
                })
              }
              placeholder={enumPlaceholders[1]}
            />
            {colorPickers && (
              <input
                type="color"
                value={mapping.map["1"] || "#00FF00"}
                onChange={(e) =>
                  onChange({
                    ...mapping,
                    map: { ...mapping.map, "1": e.target.value },
                  })
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
