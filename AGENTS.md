# Repository Guidelines

Contributor guide for HMI Editor, a rail-transit HMI configuration tool with a React/TypeScript frontend and a Rust/WASM I/O backend.

## Project Structure & Module Organization

- Frontend in `src/`: `core/` holds framework-agnostic engines (shapes, scene, variables, bindings, io, alarm, historian, auth, script, report); `editor/` holds React components (canvas, toolbar, panels); `store/editorStore.ts` is the Zustand hub. Entry: `index.html` + `src/main.tsx`; output: `dist/` (gitignored).
- Backend in `io-backend/`: Rust modules in `src/` (bridge, db, monitor, plugin, point, server, web), compiled plugins in `plugins/`, sources in `plugins-src/<plugin>/`.
- `ARCHITECTURE.md` documents the architecture; `config.yaml` files hold runtime configuration.

## Build, Test, and Development Commands

Frontend (repo root):

- `npm install` — install dependencies
- `npm run dev` — Vite dev server with hot reload
- `npm run build` — type-check (`tsc -b`) then build (`vite build`)
- `npm run format` — format with Prettier (not yet a devDependency; install separately)

Backend (`io-backend/`):

- `.\build.ps1 -Release` — build WASM plugins and the Rust binary; `-PluginsOnly` / `-BackendOnly` split the steps
- `cargo run -- config.yaml` — start the backend (WebSocket :8080, web API :8081)
- `cargo test` — run Rust unit tests

## Coding Style & Naming Conventions

- TypeScript/React: 2-space indent, double quotes, semicolons, strict mode; format with Prettier.
- PascalCase components/classes (`EditorCanvas`, `ShapeBase`); camelCase functions/variables (`hitTest`, `editorStore`); shared types in per-module `types.ts`; import via `@/` alias.
- `src/core/` must never import React; keep engines framework-independent.
- Rust: rustfmt defaults (4-space indent, `snake_case`), `///` doc comments, one module per folder with `mod.rs`.

## Testing Guidelines

- Backend: `#[cfg(test)]` modules colocated with code (e.g. `src/point/manager.rs`); run with `cargo test`.
- Frontend: no test runner yet; keep logic in `src/core/` as plain TypeScript so tests can be added without a DOM.

## Commit & Pull Request Guidelines

- Short, imperative, capitalized summaries ("Fix binding refresh and panel state sync"); scoped `fix:`/`feat:` prefixes acceptable; bullet-list body explains what and why.
- Keep PRs focused, describe intent and testing, add screenshots for UI changes. No CI or templates exist yet.

## Security & Configuration Tips

- `config.yaml` controls ports, plugin instances, and point mappings; keep secrets out.
- Never commit `hmi_io.db` (local SQLite). Load `.wasm` plugins only from `plugins/`; treat plugin binaries as untrusted code.
