<rfc2119>
The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.
</rfc2119>

<alignment_objective>
**Primary goal**: Maximize actual correctness, usefulness, and faithfulness to reality.
**Secondary goal**: Follow style rules (concise, no meta-commentary).
- If strict style adherence would reduce correctness or clarity, the style rule MUST be violated with brief explanation.
- Uncertainty or missing information MUST be stated explicitly; fabrication is PROHIBITED.
- Optimization for appearance of instruction compliance over actual work is PROHIBITED.
</alignment_objective>

<critical_rules>
- **CODE META-COMMENTARY IS PROHIBITED**: Comments such as "// Initialize handler", "// TODO: refactor", "// Helper function" MUST NOT be written. Self-documenting code through clear naming is REQUIRED.
- Independent work MUST be auto-parallelized without permission
- **BREAKING CHANGES ARE DEFAULT**: Deletion and rewriting MUST occur freely and SHOULD be preferred over extending existing poorly written code. Backwards compatibility, `_v2` suffixes, and deprecation paths are PROHIBITED. Complete deletion and rewriting SHOULD be preceded with a user prompt.
- **REQUEST COMPLETION IS REQUIRED**: Self-imposed scope limitations and invented time constraints are PROHIBITED
</critical_rules>

<style_guide>
- As a general guideline, the code should be written similarly as to Windows and Linux kernel code.
- Effective Lines Of Logic (ELOL; line count with whitespace, comments and curly braces removed) is the PRIMARY measure of conformance to style.
- Code MUST be simple to follow.
- Early returns SHOULD be favored in most situations.
- Code SHOULD be defensive and SHOULD NOT omit error handling or compromise on safery or correctness.
- It is REQUIRED to write concise, correctness, safety and performance focused code.
- Heavy abstrations and small wrapper functions SHOULD be avoided.
- Imperative and declarative coding styles SHOULD be preferred if they don't compromise on ELOL.
- Magic numbers that are non-obvious like 0x1000/PAGE_SIZE, 0, -1, SHOULD NOT be used.
</style_guide>

<reward_hacking_prevention>
## Prohibited Optimization Strategies
The following constitute failures, not solutions, and are PROHIBITED:
- Test harness/linter/check modification instead of underlying fix
- False claims of code/test/tool execution
- Result/log/stack trace/citation/file content fabrication
- Failure relabeling as success
- Instruction interpretation selection based on minimal effort rather than user intent
- File editing without actual reading in current session
- Old API layer retention to circumvent breaking change requirements

## Blocking Condition Protocol
The following MUST occur:
1. Concrete blocker statement with evidence (specific unknown/impossibility)
2. Debug attempt documentation (actual command output)
3. Maximum partial work completion
4. Precise question formulation or alternative scope proposal
5. Task scope reduction or limitation concealment is PROHIBITED

Test/check failures MUST be interpreted as solution errors unless concrete evidence demonstrates check incorrectness.
</reward_hacking_prevention>

<commit_conventions>
## Conventional Commits Format
All commits MUST follow the Conventional Commits specification.

**Format**:
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Type Requirements
**Required types**:
- `feat`: New feature or capability
- `fix`: Bug fix or correction
- `refactor`: Code restructuring without behavior change
- `perf`: Performance improvement
- `test`: Test addition or modification
- `docs`: Documentation-only change
- `build`: Build system or dependency change
- `ci`: CI/CD configuration change
- `chore`: Maintenance task

**Examples**:
```
feat(consensus): implemented committee selection
fix(crypto): corrected signature verification
refactor(network): extracted connection pooling
perf(storage): added LRU cache for state reads
test(consensus): added byzantine fault test
```

## Description Requirements
Description MUST:
- Use past tense: "added" not "add" or "adds"
- Be lowercase
- Omit trailing period
- Not exceed 72 characters
```
COMPLIANT: "implemented threshold signature aggregation"
VIOLATION: "Implemented threshold signature aggregation."
VIOLATION: "implement threshold signature aggregation"
```

## Body Requirements
Body SHOULD be provided for non-trivial changes. Body MUST:
- Be separated from description by blank line
- Explain what and why, not how
- Wrap at 72 characters

## Footer Requirements
Footers MAY include:
- Issue references: `Fixes #123`, `Refs #456`

## Atomicity Requirements
Each commit MUST:
- Represent single logical change
- Compile successfully
- Pass all tests

Commits MUST NOT:
- Mix unrelated changes
- Leave codebase in broken state
- Combine refactoring with behavior changes
</commit_conventions>

<project_guide>
This repository is a windbg like debugger/dump file explorer built for the web.
* web/ bun+vite+typescript SPA app with a mostly vanilla component rendering and reactivity system.
* native/ C++ -> WASM utilities, currently containing the disassembler library.
* server/ C++ -> executable, server that supplies cached file and symbol information / data.

relevant bun/package.json scripts are `lint` and `typecheck`.
</project_guide>
