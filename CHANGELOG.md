# Changelog

All notable changes to this project will be documented in this file.

## [0.2.7] - 2026-08-08

### 🚀 Features
- **Massive File Support (Agentic Chunking)**: Never hit a token limit again! The AI can now intelligently process massive, complex files by breaking them down and writing tests function-by-function. This guarantees deeper coverage without losing context or crashing.
- **Interactive Previews (Human-in-the-Loop)**: Added a new `--preview` mode. Instead of blindly overwriting your codebase, the CLI can now stream exact previews of its generated tests. This powers the new VS Code extension's gorgeous inline diffs, letting you safely accept or reject the AI's work line-by-line!



## [0.2.3] - 2026-07-30

### 🚀 Features
- **Dynamic Dependency Auto-Installer**: Running `aitest run` will now automatically detect if you are missing any testing dependencies (like `@vitest/coverage-v8`) and provide an interactive prompt to instantly install them for you.
- **Smarter Execution Analysis**: The AI now intelligently cross-references the test runner's exit status with the console logs. It will no longer hallucinate "test failures" when expected errors or stack traces are logged during a perfectly passing test suite.

### 🛡️ Safety & Configuration
- **Boundary Enforcement**: Added strict filesystem boundaries. The Agentic repair loop is now explicitly forbidden from modifying or deleting your application's source code, keeping your codebase completely safe during testing loops.
- **Billing Protection**: Added `maxSteps: 50` and `maxExplorationSteps: 5` as default configuration flags in `aitest init` to prevent infinite LLM loops and protect your API credits.
