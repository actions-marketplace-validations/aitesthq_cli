# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-07-30

### 🚀 Features
- **Dynamic Dependency Auto-Installer**: Running `aitest run` will now automatically detect if you are missing any testing dependencies (like `@vitest/coverage-v8`) and provide an interactive prompt to instantly install them for you.
- **Smarter Execution Analysis**: The AI now intelligently cross-references the test runner's exit status with the console logs. It will no longer hallucinate "test failures" when expected errors or stack traces are logged during a perfectly passing test suite.

### 🛡️ Safety & Configuration
- **Boundary Enforcement**: Added strict filesystem boundaries. The Agentic repair loop is now explicitly forbidden from modifying or deleting your application's source code, keeping your codebase completely safe during testing loops.
- **Billing Protection**: Added `maxSteps: 50` and `maxExplorationSteps: 5` as default configuration flags in `aitest init` to prevent infinite LLM loops and protect your API credits.
