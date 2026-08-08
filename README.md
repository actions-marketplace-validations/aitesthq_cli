<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/aitesthq/cli/main/assets/logo.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/aitesthq/cli/main/assets/logo-light.svg">
    <img alt="AI Test CLI Logo" src="https://raw.githubusercontent.com/aitesthq/cli/main/assets/logo.svg" width="150" style="border-radius:50%;">
  </picture>
</p>

<h1 align="center">AI Test CLI 🧪🤖</h1>

<p align="center">
  <strong>An autonomous AI software testing engineer that dynamically generates, evaluates, and auto-fixes test suites for complex codebases.</strong>
</p>

<p align="center">
  <a href="https://badge.fury.io/js/ai-test-cli"><img src="https://badge.fury.io/js/ai-test-cli.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
</p>

---

## 🌟 Why AI Test CLI?

Most AI testing tools just write boilerplate code and give up when tests fail. **AI Test CLI is different.** It operates like a real Senior QA engineer using a fully autonomous "Agentic Loop":

1. **Intelligent Generation**: It reads your source file, maps your workspace architecture via AST parsing, and writes comprehensive tests using your existing framework (Jest, Vitest, Mocha, etc.).
2. **Massive File Support**: The **Agentic Chunking Generator** explores massive files function-by-function, incrementally building out coverage without blowing up LLM token limits.
3. **Autonomous Auto-Fixing**: It actually *runs* the tests it writes. If they fail, it reads the error stack trace, maps it back to your source code, and dynamically applies patches until the pipeline turns green.
4. **Bring Your Own Key (BYOK)**: Supports DeepSeek, OpenAI, Anthropic, Gemini, and Local Models (Ollama/LMStudio) via the Vercel AI SDK. 

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
```

---

## 🛠️ Usage

### Auto-Fix Broken Tests (Self-Healing)

Got a test suite that's failing because of broken mocks or outdated logic? Unleash the agentic fixer:
```bash
aitest fix
```
The AI will run your entire test suite, isolate the failures, analyze the error stack traces, and patch the broken test file until it turns green. *(Note: The CLI currently handles fixing one failing file per run).*

### Generate Tests

Generate a test suite for a single file:
```bash
aitest generate --file src/controllers/userController.ts
```

Generate tests for your entire project (this will gracefully skip files that already have tests or lack testable logic):
```bash
aitest generate --all
```

**Iterative Coverage**: Run `aitest generate --coverage` to automatically run a coverage report, identify files missing branch coverage, and have the AI rewrite them for 100% coverage!

### Generate Global Mocks
Mocking external dependencies (like Stripe or AWS) by hand is incredibly tedious. Tell the AI to read your `package.json` and generate global `__mocks__`:
```bash
aitest mock --dependencies
```

### Continuous Integration (GitHub Action)
You can automate your team's debugging by dropping `ai-test-cli` directly into your GitHub Actions! If a developer breaks a test in a Pull Request, the Action will autonomously fix it.

Create `.github/workflows/ai-test-fix.yml`:

```yaml
name: AI Test Auto-Fix
on: [pull_request]

jobs:
  auto-fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install Dependencies
        run: npm install
      
      - name: Run AI Test CLI (Auto-Fix)
        uses: aitesthq/cli@main
        with:
          provider: 'deepseek'
          api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          command: 'fix'
          
      - name: Create Pull Request with Fixes
        uses: peter-evans/create-pull-request@v6
        with:
          title: "🤖 AI Test CLI: Auto-fixed broken tests"
          commit-message: "chore: Auto-fixed broken tests via AI"
```

#### Advanced Optional Inputs
You can lock down the action with enterprise-grade settings to completely override the developers' local `.aitestrc.json` configuration during the CI run:

```yaml
      - name: Run AI Test CLI (Auto-Fix)
        uses: aitesthq/cli@main
        with:
          provider: 'custom'
          api_key: 'not-needed-for-proxy'
          command: 'fix'
          model: 'gpt-4o'                           # Force a specific model in CI
          max_loops: '10'                           # Allow up to 10 files to be fixed automatically
          custom_headers: '{"X-Token": "${{ secrets.PROXY }}"}' # Safely inject secret headers
```

#### GitLab CI (`.gitlab-ci.yml`)
```yaml
ai-test-fix:
  stage: test
  image: node:20
  script:
    - npm install
    - npm install -g ai-test-cli
    - aitest fix --ci
  variables:
    DEEPSEEK_API_KEY: $DEEPSEEK_API_KEY
  only:
    - merge_requests
```

#### Bitbucket Pipelines (`bitbucket-pipelines.yml`)
```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: AI Test Auto-Fix
          image: node:20
          script:
            - npm install
            - npm install -g ai-test-cli
            - aitest fix --ci
```


---

## 📄 License
MIT License. See [LICENSE](LICENSE) for more information.
