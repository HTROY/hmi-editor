# Deepened Seam: ShapeBehaviour - one-place per-type behaviour for 15+ shape types

> 设计草案（design-it-twice 三方案之一）。最终决策见 docs/adr/0007-shape-capability-bundle.md：
> 采用类型键控能力表 + 编译期穷尽、函数式 resize 覆盖、构造器即默认值 seam，
> 模块名 capability.ts（ShapeCapability / capabilityOf）。

Candidate = friction survey finding #1 + #3. A single polymorphic seam replaces the 6+
string/instanceof re-dispatch sites. Pure internal refactor: serialized ShapeProps schema stays
byte-stable (constraint 1), core stays React-free (2), in-process no-I/O interface-as-test-surface
(3), behaviour semantics preserved (4), a 16th type costs ONE registration instead of 6+ edits (5).

## 1. Interface

The seam is a registry of per-{shapeType} capability descriptors. A descriptor is a plain object
whose values are either values or callbacks that receive the live ShapeBase instance (for
instance-derived geometry) or pure ShapeProps transforms (for the flat-JSON sites like
library.ts / SvgImporter / store.addShape that never materialize an instance).

  // src/core/shapes/behaviour.ts  (the deepened module: interface + registry + helper fns)
  import type { ShapeType, ShapeProps, Point, BoundingBox, ResizeOptions } from "../types";

  /** A handle-indexed resize gesture in world coordinates (options pre-normalized). */
  export interface ResizeGesture {
    handle: "nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w";
    pointer: Point;                 // world coords; module applies snap/min/clamp internally
    options: ResizeOptions;         // proportional, snap, gridSize, minSize (already normalized)
  }

  /** One descriptor = ONE place per shape type. Every method optional; defaults fall back. */
  export interface ShapeBehaviour {
    type: ShapeType;                                          // registry key

    // ---- instance-level behaviour (receive the created ShapeBase) ----
    resize?(shape: ShapeBase, g: ResizeGesture): BoundingBox | null;   // null => run default box path
    aabbKind?(): "center" | "origin" | "endpoints" | "fitPoints"; // rotation pivot / box flavour
    uniformResize?(): boolean;          // true => metro-like, must scale uniformly
    boundingBox?(shape: ShapeBase): BoundingBox | null;        // own-bounds override
    syncDerived?(shape: ShapeBase, applied: Partial<ShapeProps>): void; // e.g. breakerStatus->fill
    advanceAnimation?(shape: ShapeBase, deltaMs: number): boolean;     // e.g. MetroFan blade spin

    // ---- flat ShapeProps behaviour (no instance; addShape / library / importer) ----
    defaults?(): Partial<ShapeProps>;            // type-specific seed for fresh construction
    bindableProps?(): ReadonlySet<string>;       // inspector terminal whitelist
    numericProps?(): ReadonlySet<string>;        // drives smooth=true on new bindings
    offset?(props: ShapeProps, dx: number, dy: number): ShapeProps;    // pure, never mutates arg
    boundsFromProps?(props: ShapeProps): BoundingBox | null;           // pure own-bounds
    editorDescriptor?(): EditorDescriptor | null; // optional inspector SEM section fields
  }

  // ---- registry + zero-effort helpers callers use instead of dispatch ----
  export function registerBehaviour(b: ShapeBehaviour): void;
  export function behaviourFor(shape: ShapeBase): ResolvedBehaviour;        // instance callers
  export function behaviourForType(type: string): ResolvedBehaviour;        // flat-JSON callers


ResolvedBehaviour is a non-optional, fully-defaulted view: every method has a builtin fallback that
mirrors today's applyBoxResize / base boundingBox / base defaults, so callers only call
behaviourFor(shape).resize(...) and never branch on type.

Invariants / ordering / error modes:
- Registration is module-load-time, idempotent per type (a later duplicate replaces - enables
  plugin/test overrides). A descriptor without a type key throws at register.
- behaviourFor never throws: an unknown instance type falls back to a frozen shared default. So a
  16th type stub compiles and behaves sanely everywhere with zero dispatch-site edits, and real
  behaviour is one file. A registered-but-missing-type read logs a dev warning (cheaper than a hard
  failure, and visibility of the load-order footgun).
- resize contract: fully apply the gesture to the live instance (snap / min-size / clamp /
  proportional / rotated-solve / own-bounds), return the final world AABB (used by text font
  linkage), or null to mean "re-run default box path". The default box path is exactly today's
  applyBoxResize.
- aabbKind: "endpoints" (line) short-circuits the rotated AABB to the endpoint box; "origin" (group)
  pivots at top-left; "fitPoints" (polyline/polygon) yields the point-union box; default "center".
- offset / boundsFromProps are pure: take ShapeProps, return a new/derived value, never mutate the
  arg. Errors are value-shaped (null => caller falls back to the x/y box), never thrown.
- ordering: defaults() is applied over the ShapeBase seed in the factory path BEFORE user-supplied
  props, so user props always win (constructors already merge ??-defaults; semantics preserved).
- The descriptor is documented (in the friction doc rewrite) as THE single extension point.


## 2. Usage - three real call-site conversions

resize.ts - delete the three private functions and the six inline branches:
    // BEFORE (applyResize :488-504 plus applyBoxResize :314-376, getRotatedAABB :85-123,
    //          METRO_TYPES :55)
    export function applyResize(shape, handle, pointer, options = {}) {
      const o = normalizeOptions(options);
      if (shape.type === "line")  { applyLineResize(shape as LineShape, handle, pointer, o); return; }
      if (shape.type === "group") { applyGroupResize(shape as GroupShape, handle, pointer, o); return; }
      applyBoxResize(shape, handle, pointer, o);
    }
    // AFTER
    export function applyResize(shape, handle, pointer, options = {}) {
      const g = { handle, pointer, options: normalizeOptions(options) };
      return behaviourFor(shape).resize(shape, g)          // one seam
          ?? defaultBoxResize(shape, g);                   // shared fallback
    }
    // getRotatedAABB:  rotation===0 || aabbKind()==="endpoints" -> local box;
    //   else pivot = aabbKind()==="origin" ? {x,y} : center.
    //   The METRO_TYPES set and the text/path/polyline resize branches move into descriptors.

PropertyPanel.tsx - the 11x instanceof isX flags (:298-308) and the per-type JSX blocks
(:455-750) become a data-driven section:
    // BEFORE
    const isRect = shape instanceof RectShape; const isText = shape instanceof TextShape; // ... 11 flags
    {isRect && <div className="prop-row">... cornerRadius ...</div>}
    {isBreaker && (<>... 状态 / 标签 ...</>)}
    // AFTER
    const desc = behaviourFor(shape).editorDescriptor();       // [{prop:"cornerRadius",...}, ...]
    {Array.isArray(desc?.fields) && desc.fields.map(f => <EditorField key={f.prop} field={f} ... />)}
    // NUMERIC_PROPS / BINDABLE_PROPS move into per-type descriptor sets; the multi-select branch
    // keeps a shared constant set built by unioning all descriptors at module load.

store.addShape (:526-583) - the 40-line flat ternary bag collapses to two lines:
    // BEFORE
    addShape: (type, x, y) => sceneEditor.addShape({
      type, x: x ?? 200, y: y ?? 200,
      width: type === "circle" ? 80 : 120, height: type === "circle" ? 80 : 80,
      fill: type === "text" ? "#000000" : "#4A90D9", stroke: "#333333", strokeWidth: 2,
      text: type === "text" ? "双击编辑" : undefined, fontSize: type === "text" ? 24 : undefined,
      d: type === "path" ? "M15 10 ..." : undefined,
      children: type === "group" ? [...] : undefined, src: type === "image" ? "" : undefined,
      breakerStatus: "open", signalColor: type === "metro-signal" ? "gray" : undefined,
      running: false, speedPercent: 0, value: 0, min: 0, max: 100, unit: "A",
      primaryVoltage: "35kV", secondaryVoltage: "400V", voltageLevel: "400V",
      energized: true, label: "", labelPosition: "bottom",
    })
    // AFTER
    addShape: (type, x, y) => sceneEditor.addShape({
      type, x: x ?? 200, y: y ?? 200,
      ...behaviourForType(type).defaults(),     // every type-specific seed lives beside its class
      label: "", labelPosition: "bottom",       // shared metro scaffold (optional common default)
    })
    The metro-only fields (breakerStatus, speedPercent, value, ...) stop leaking onto rect/circle;
    their redundancy dies with the constructors that already own defaults. For every produced shape
    the merge (user prop wins) is byte-identical to the old per-type ternary (constraint 4).


## 3. What the implementation hides

Behind the seam (a deepened module over descriptor fan-out + shared fallbacks):
- per-type resize-handle reaction: line endpoint projection, group origin-scaling of children, box
  uniform / rotated-solve for the rest, text font linkage, path transformPathData, polyline/polygon
  uniform point-rescale, metro always-uniform. The whole applyLineResize / applyGroupResize /
  applyBoxResize cluster and the METRO_TYPES set.
- AABB / pivot rules: "endpoints" line, "origin" group, fit-points polylines, center default; the
  rotated-AABB corner math stays in resize.ts but the per-type pivot/branch is a descriptor read.
- own-bounds: the boundingBox override AND the flat-JSON boundsFromProps (library thumbnails,
  placement centering, getShapeBounds).
- default construction: store.addShape seeds per type; constructors keep field defaults.
- bindable / numeric prop tables: NUMERIC_PROPS / BINDABLE_PROPS relocate into descriptors, unioned
  for the multi-select branch.
- inspector editor descriptors: per-type SEM property sections (optional).
- metro fan animation advance: the instanceof MetroFan in AnimationEngine becomes
  behaviourFor(shape).advanceAnimation?.(shape, deltaMs).


## 4. Dependency strategy (in-process)

Dependency category: in-process - pure TS computation, no I/O, no ports/adapters. The descriptor
registry is a plain Map with static registration; callers import it directly. The seam IS the test
surface (constraint 3).

- Surviving tests (run unchanged, behaviour-preservation gate): SceneGraph / SceneEditor /
  groupOps / libraryGroups tests exercise resize, group ops, and defaults - exactly the behaviour
  that must not change - so they become regression locks on the refactor. (No test runner exists
  yet per AGENTS.md; logic stays core-plain-TS so tests remain addable.)
- New tests at the interface (target behaviourFor / behaviourForType, never past it):
  - per-method fallback-contract tests (default resize equals old applyBoxResize on a rotated rect).
  - a 16th-type regression test: register a stub "widget" descriptor and assert all six call sites
    degrade to fallbacks without any dispatch-site edit - proving constraint 5.
  - invariance tests: a corpus of types x the 8 resize handles must reproduce pre-refactor golden
    AABB snapshots (fixtures captured from current behaviour before the refactor).


## 5. Trade-offs

- Leverage high: one descriptor per type repays across all 6+ dispatch sites plus the store branch.
  PropertyPanel's ~300 lines of per-type JSX collapse to data; a 16th type is one file + one
  registerBehaviour + one ShapeType union entry. ADR-0005 custom types become cheap by construction:
  a TS- or WASM-supplied descriptor calls registerBehaviour at runtime with no shared-code edits.
- Where thin: the shared ResolvedBehaviour fallback (default methods, defaultBoxResize, base
  bounds/offset) is a pass-through of existing logic - it earns its keep only because it is the
  single default reused by all 15 types. Per-method tests keep it honest.
- What gets worse: (a) indirect dispatch - a reader now follows descriptor->method instead of one
  branch; mitigated by keeping descriptor method names isomorphic to old branch intent. (b)
  registration-order coupling - descriptors must load before first use; forced module-load
  registration, but a load-order slip degrades to a silent default (mitigated by the dev warning).
  (c) group children recursion stays instance-special inside GroupShape - the descriptor does not
  fully absorb nested scaling; acceptable since it is already local.
- No byte-change risk: descriptors only relocate existing semantics; the refactor is add-registry
  then enumerate-and-delete per site, so no slice can drift from current output.


## 6. Migration sketch (slice order)

Each slice is behaviour-preserving and independently commit/testable; convert one dispatch site per
slice.

1. Register - create behaviour.ts, seed one descriptor per existing type by MOVING logic, not
   rewriting. Nothing consumes it yet (registry is additive). Add the dispatch-site-deduction table
   (current type -> which branches) as an inline doc block.
2. resize.ts - convert applyResize to behaviourFor(shape).resize + shared fallback; move line/group/
   box branches into descriptors; fold text/path/polyline/metro-uniform into descriptor methods.
   Run existing groupOps / SceneEditor tests.
3. store.addShape - replace the ternary bag with ...behaviourForType(type).defaults(); delete the
   leaked metro spread. Assert produced ShapeProps byte-equal to old output for every type.
4. library.ts / SvgImporter - convert offsetShapeProps and getShapeBounds (flat-JSON) to
   behaviourForType(type).offset / .boundsFromProps, and importer translateShape / localizeShape to
   the same (importer currently duplicates library's offset logic; the seam removes that dup too).
5. groupOps.ts - convert the instanceof Line/Polyline/Polygon child-transform branch to a new
   optional descriptor method (transformOwnPoints under a rotation matrix), and GroupShape
   instanceof checks become behaviourFor reads.
6. PropertyPanel.tsx - replace the 11 instanceof flags + per-type JSX with editorDescriptor-driven
   rendering; move NUMERIC/BINDABLE sets into descriptors; multi-select keeps the union.
7. AnimationEngine.ts - instanceof MetroFan -> behaviourFor(shape).advanceAnimation.
8. Wash - delete now-unused imports/branches; add the 16th-type regression test; update the friction
   doc + ADR-0005 note that the future custom-type point is registerBehaviour.
