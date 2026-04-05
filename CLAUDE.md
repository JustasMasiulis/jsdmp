## Project Overview

This repository is a windbg like debugger/dump file explorer built for the web.
* web/ bun+vite+typescript SPA app with a mostly vanilla component rendering and reactivity system.
* native/ rust -> WASM utilities, currently containing the disassembler library.
* server/ C++ -> executable, server that supplies cached file and symbol information / data.

## Commands

- `bun lint` - run linter that formats code and finds code quality issues.
- `bun typecheck` - run typescript check. NEVER invoke tsc directly.
- `bun test` - run all tests.
