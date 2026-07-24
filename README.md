<h1 align="center">AI Test CLI 🧪🤖</h1>

<p align="center">
  <strong>An autonomous AI software testing engineer that dynamically generates, evaluates, and auto-fixes test suites for complex codebases.</strong>
</p>

<p align="center">
  <a href="https://badge.fury.io/js/ai-test-cli"><img src="https://badge.fury.io/js/ai-test-cli.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

---

## 🌟 Why AI Test CLI?

Most AI testing tools just write boilerplate code and give up when tests fail. **AI Test CLI is different.** It operates like a real Senior QA engineer using a fully autonomous "Agentic Loop":

1. **Intelligent Generation**: It reads your file, understands its imports, scans your workspace structure, and writes comprehensive tests using your existing framework (Jest, Vitest, Mocha, etc.).
2. **Massive File Support**: Got an 11,000+ line controller? No problem. The **Agentic Chunking Generator** explores the file function-by-function, incrementally building out coverage without blowing up LLM token limits.
3. **Smart Context for Local Models**: Running Ollama on a MacBook? The CLI automatically detects Local LLMs and engages "Extreme Chunking Mode" to guarantee your computer never crashes from context-window overflow.
4. **Autonomous Auto-Fixing**: It actually *runs* the tests it writes. If they fail, it reads the error stack trace, uses search tools to inspect the broken dependencies, and dynamically applies patches until the test passes.
5. **Bring Your Own Key (BYOK)**: Supports DeepSeek, OpenAI, Anthropic, Gemini, and Local Models (Ollama/LMStudio) via the Vercel AI SDK. 

---

## 🚀 Quickstart

Install globally via npm:

```bash
npm install -g ai-test-cli
```

Initialize the configuration in your project root. This creates an `.aitestrc.json` file.

```bash
aitest init
```

Set your API key in your `.env` file, or set it in your environment:

```bash
# Depending on your chosen provider:
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-..."
export GEMINI_API_KEY="AIza..."
export CUSTOM_API_KEY="sk-..."
```

---

## 🛠️ Usage

### Generate Tests

Generate a test suite for a single file:
```bash
aitest generate --file path/to/your/file.ts
```

Generate tests for your entire project (this will skip files that already have tests):
```bash
aitest generate --all
```

**Iterative Coverage**: If a test file already exists, running `aitest generate` again will automatically evaluate the existing file for missing coverage and append tests for untested functions!

### Auto-Fix Broken Tests

Got a test suite that's failing because of broken mocks or outdated logic? Unleash the agentic fixer:
```bash
aitest fix
```
The AI will run your entire test suite, isolate the failures, analyze the error stack traces, and incrementally patch your test files until they turn green.

### Generate Global Mocks
Mocking external dependencies (like Stripe or AWS) by hand is incredibly tedious. You can tell the AI to automatically read your `package.json` and generate global `__mocks__` for all your third-party dependencies:
```bash
aitest mock --dependencies
```
You can also generate a mock for a specific internal file to isolate your unit tests:
```bash
aitest mock --file src/utils/database.js
```

### Explain Failures
Don't want the AI to fix it for you? Just ask it to explain why a test is failing:
```bash
aitest explain
```

### Continuous Integration (CI) Mode
You can automate your entire team's debugging by dropping `aitest` directly into your GitHub Actions! If a developer breaks a test, the CLI will autonomously fix it and open a PR:

```yaml
steps:
  - name: Run AI Test Auto-Fix
    run: aitest fix --ci
    
  - name: Create Pull Request
    uses: peter-evans/create-pull-request@v6
    with:
      title: "🤖 AI Test CLI: Fixed broken tests"
      commit-message: "chore: Auto-fixed broken tests via AI"
```

---

## 🧠 Supported Providers

The CLI supports the following providers out of the box via your `.aitestrc.json`:
- `deepseek` (Highly Recommended: 128k context, extremely cheap)
- `openai` 
- `anthropic`
- `gemini`
- `ollama` (Local models, automatically triggers Smart Context chunking)

---

## 🛡️ Safety Mechanisms

AI Test CLI is built with strict API billing safeguards:
- **Stagnation Protection**: If the AI gets confused and fails to write a test chunk after 10 attempts, it safely aborts.
- **Duplicate Action Protection**: If the AI falls into a hallucinatory repetition loop, the CLI detects it and breaks the loop instantly to save your API credits.
- **Smart Context**: Drastically reduces token consumption for massive files by chunking out irrelevant lines during the repair loop.

---

## ☕ Support the Project

Did AI Test CLI just save you 20 hours of grueling unit testing? Support the creator and buy them a coffee!

<a href="https://buymeacoffee.com/cijaytechnh" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for more information.
