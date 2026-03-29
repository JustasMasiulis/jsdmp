# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based interactive debugger for Windows minidump (`.dmp`/`.mdmp`) files. Combines a TypeScript/Vite frontend with a C++ Zydis disassembler compiled to WebAssembly.

## Commands

All commands run from the `web/` directory. Use `bun` instead of `npm`.

```bash
bun run dev      # Vite dev server on port 3000
bun run build    # Production build
bun run test     # Run tests
bun run lint     # Biome linter with auto-fix
```

## Architecture

### Data flow

1. User drops a `.dmp` file onto the dropzone (`WasmDumpDebugger.ts`)
2. File is parsed into a `MiniDump` object (`lib/minidump.ts`)
3. `MinidumpDebugInterface` wraps the parsed dump and provides querying APIs
4. `resolveDumpContext()` extracts active thread, registers, exception context
5. `DockviewDumpLayout` renders the multi-panel UI with all views

### Key directories

- `web/src/lib/` — Core logic: dump parsing, WASM bindings, reactive state, disassembly
- `web/src/components/` — UI views: disassembly, memory, threads, CFG graph, summary
- `native/src/` — C++ WASM wrapper around Zydis disassembler

### WASM integration

`lib/wasm.ts` loads `web_dmp.wasm` (Zydis x86/x64 disassembler). The WASM module is initialized at startup as `WASM_PROMISE` before the app mounts.

### UI layout

Dockview (`dockview-core`) manages resizable/dockable panels. Each view is a `VanillaXxxView` class that renders to a DOM container directly (no virtual DOM).

### Global debug state

`lib/debugState.ts` holds the global `MinidumpDebugInterface` instance and current selection state (selected thread, address, etc.), accessed across all components.
