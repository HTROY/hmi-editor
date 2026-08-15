import React, { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { getSelectedShape } from "../../core";
import { ShapeTree } from "./ShapeTree";
import { PropertyPanel } from "../panels/PropertyPanel";
import { BindingPanel } from "../panels/BindingPanel";
import { AnimationPanel } from "../panels/AnimationPanel";
import { Icon, type IconName } from "../icons";

type SectionKey = "properties" | "bindings" | "animations";

const SECTIONS: { key: SectionKey; label: string; icon: IconName }[] = [
  { key: "properties", label: "属性", icon: "sliders" },
  { key: "bindings", label: "绑定", icon: "link" },
  { key: "animations", label: "动画", icon: "motion" },
];

export function InspectorPanel() {
  const scene = useEditorStore((s) => s.scene);
  const selection = useEditorStore((s) => s.selection);

  const [treeHeight, setTreeHeight] = useState(220);
  const [sections, setSections] = useState<Record<SectionKey, boolean>>({
    properties: true,
    bindings: true,
    animations: true,
  });
  const treeDrag = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!treeDrag.current) return;
      const next =
        treeDrag.current.startH + (e.clientY - treeDrag.current.startY);
      setTreeHeight(Math.min(560, Math.max(120, next)));
    };
    const onUp = () => {
      treeDrag.current = null;
      document.body.classList.remove("resizing-v");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startTreeDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    treeDrag.current = { startY: e.clientY, startH: treeHeight };
    document.body.classList.add("resizing-v");
  };

  const shape = getSelectedShape(scene, selection);
  const multiCount = selection.count;

  const toggleSection = (key: SectionKey) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <>
      <div className="inspector-tree" style={{ height: treeHeight }}>
        <ShapeTree />
      </div>
      <div
        className="inspector-divider"
        title="拖拽调整图元树高度"
        onMouseDown={startTreeDrag}
      />
      <div className="inspector-editor">
        {!shape ? (
          <div className="prop-empty">
            <span className="prop-empty-dot" />
            <div>
              <div className="prop-empty-title">未选择图元</div>
              <div className="prop-empty-desc">
                在图元树或画布上选择图元后，在这里编辑属性/绑定/动画
              </div>
            </div>
          </div>
        ) : multiCount > 1 ? (
          <div className="inspector-section">
            <div className="inspector-section-header static">
              <Icon name="sliders" size={12} />
              <span>公共属性</span>
            </div>
            <div className="inspector-section-body">
              <PropertyPanel />
            </div>
            <div className="panel-hint">
              多选时仅支持公共属性批量编辑；绑定与动画请单选图元
            </div>
          </div>
        ) : (
          SECTIONS.map((s) => (
            <div key={s.key} className="inspector-section">
              <button
                className="inspector-section-header"
                onClick={() => toggleSection(s.key)}
              >
                <Icon name={s.icon} size={12} />
                <span>{s.label}</span>
                <Icon
                  name={sections[s.key] ? "down" : "up"}
                  size={11}
                  className="inspector-section-chevron"
                />
              </button>
              {sections[s.key] && (
                <div className="inspector-section-body">
                  {s.key === "properties" && (
                    <PropertyPanel
                      onOpenBindings={() =>
                        setSections((prev) => ({ ...prev, bindings: true }))
                      }
                    />
                  )}
                  {s.key === "bindings" && <BindingPanel />}
                  {s.key === "animations" && <AnimationPanel />}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
