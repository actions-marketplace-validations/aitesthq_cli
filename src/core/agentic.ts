import { AITestConfig } from '../core/config.js';
import { ProjectInfo } from '../core/detector.js';
import { askAI } from '../core/ai.js';
import { runSingleTest } from '../core/runner.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { generateTestForFile } from '../commands/generate.js';
import { generateASTMap } from '../core/scanner.js';
import chalk from 'chalk';

const execAsync = promisify(exec);

type AgenticAction =
  | { action: 'apply_patch'; file: string; code: string }
  | { action: 'install_deps'; deps: string[] }
  | { action: 'abort'; reason: string }
  | { action: 'read_file'; path: string }
  | { action: 'list_dir'; path: string }
  | { action: 'generate_mock'; target: string; type: 'external' | 'internal' };

interface AgenticPlan {
  reasoning: string;
  steps: AgenticAction[];
}

/**
 * AgenticPlanner – lightweight LLM‑driven planning wrapper.
 *
 * Workflow:
 *   1️⃣ Generate an initial test (deterministic).
 *   2️⃣ Run the test. If it passes we are done.
 *   3️⃣ If it fails, ask the LLM for a **single‑step JSON plan** describing the next action.
 *   4️⃣ Parse, validate, and execute the plan.
 *   5️⃣ Loop up to a configurable max attempts (default 3).
 */
export class AgenticPlanner {
  constructor(public config: AITestConfig, public projectInfo: ProjectInfo, public workspaceMap: string = '') {}

  /** Detect if the AI provider is a cloud provider with a massive context window */
  private _isCloudProvider(): boolean {
    const p = (this.config.provider || '').toLowerCase();
    return p.includes('deepseek') || p.includes('openai') || p.includes('anthropic') || p.includes('gemini') || p.includes('google');
  }

  /** Generate tests for a file using the LLM planning loop. */
  async generateFile(
    sourceFilePath: string,
    options: { forceUpdate?: boolean; evaluateExisting?: boolean; workspaceMap?: string } = {}
  ): Promise<'generated' | 'skipped' | 'failed'> {
    const { forceUpdate = false, evaluateExisting = false } = options;

    let isMassive = false;
    let fileLength = 0;
    try {
      const content = readFileSync(sourceFilePath, 'utf-8');
      fileLength = content.length;
      isMassive = fileLength > 20000;
    } catch(e) {}

    let initialResult: 'generated' | 'skipped' | 'failed' = 'failed';

    if (isMassive) {
       console.log(chalk.yellow(`\n⚠ File ${sourceFilePath.split('/').pop()} is massive (${fileLength} chars). Engaging Agentic Chunking Generator...`));
       initialResult = await this._runAgenticGeneratorLoop(sourceFilePath, this._deriveTestPath(sourceFilePath));
    } else {
       // 1️⃣ Create an initial test file using the existing generator.
       initialResult = await generateTestForFile(
         sourceFilePath,
         this.config,
         this.projectInfo,
         forceUpdate,
         evaluateExisting,
         this.workspaceMap
       );
    }

    if (initialResult === 'skipped') return 'skipped';
    if (initialResult === 'failed') return 'failed';

    // 2️⃣ Enter the repair loop for generation
    return this._runAgenticLoop(this._deriveTestPath(sourceFilePath), sourceFilePath);
  }

  /** Run the agentic repair loop on an existing test file. */
  async fixTestFile(testFilePath: string, sourceFilePath?: string): Promise<'generated' | 'skipped' | 'failed'> {
    return this._runAgenticLoop(testFilePath, sourceFilePath);
  }

  private async _runAgenticGeneratorLoop(sourceFilePath: string, testFilePath: string): Promise<'generated' | 'skipped' | 'failed'> {
    let attempts = 0;
    const maxAttempts = this.config.maxSteps !== undefined ? this.config.maxSteps : 50; // Configurable limit, fallback to 50 to protect API billing
    let stagnationCounter = 0;
    let previousStepsHash = '';
    let duplicateCount = 0;
    let testCode = '';
    const history: string[] = [];
    let fileLines: string[] = [];
    try {
      fileLines = readFileSync(sourceFilePath, 'utf-8').split('\n');
    } catch(e) {
      return 'failed';
    }
    
    // Seed test code with an empty string or existing file if it exists
    if (existsSync(testFilePath)) {
       testCode = readFileSync(testFilePath, 'utf-8');
    } else {
       writeFileSync(testFilePath, testCode, 'utf-8');
    }

    console.log(chalk.blue(`ℹ Starting Agentic Chunking Generator for ${sourceFilePath.split('/').pop()} (${fileLines.length} lines)...`));
    
    while (attempts < maxAttempts) {
      attempts++;
      
      const testedFunctionsMatch = testCode.match(/describe\(['"\`](.+?)['"\`]\s*,/g) || [];
      const testedFunctions = testedFunctionsMatch.map(s => s.replace(/describe\(['"\`]|['"\`]\s*,/g, '')).filter(s => s.trim().length > 0 && !s.includes('.js') && !s.includes('.ts'));
      
      const astMap = generateASTMap(sourceFilePath, testedFunctions);
      
      const plan = await this._requestGenPlan(testCode, testFilePath, sourceFilePath, fileLines.length, history, astMap, testedFunctions);
      if (!plan) {
        console.log(chalk.red(`✖ AI failed to generate a valid generation plan. Retrying...`));
        history.push(`Attempt ${attempts}: SYSTEM ERROR - Last response was invalid JSON. Ensure you output raw JSON only, and properly escape quotes/newlines in any arrays or strings.`);
        continue;
      }

      const currentStepsHash = JSON.stringify(plan.steps);
      if (currentStepsHash === previousStepsHash) {
        duplicateCount++;
        if (duplicateCount >= 3) {
          console.log(chalk.red(`✖ AI generated the exact same action 3 times in a row. Forcibly breaking loop.`));
          break;
        }
      } else {
        duplicateCount = 0;
        previousStepsHash = currentStepsHash;
      }

      console.log(chalk.cyan(`🤖 AI Generator returned a plan:\n  🤔 Reasoning: ${plan.reasoning}`));
      
      let isFinished = false;
      let madeProgress = false;
      
      for (const step of plan.steps) {
        if (step.action === 'read_lines') {
          console.log(chalk.cyan(`  - 📖 Reading lines ${step.start} to ${step.end}`));
          const startIdx = Math.max(0, step.start - 1);
          const endIdx = Math.min(fileLines.length, step.end);
          const chunk = fileLines.slice(startIdx, endIdx).map((l, i) => `${startIdx + i + 1}: ${l}`).join('\n');
          history.push(`Attempt ${attempts}: Read lines ${step.start}-${step.end}:\n${chunk}`);
        } else if (step.action === 'search_file') {
          console.log(chalk.cyan(`  - 🔍 Searching for "${step.query}"`));
          const matches = fileLines
             .map((line, idx) => ({ line, idx: idx + 1 }))
             .filter(({ line }) => line.includes(step.query))
             .slice(0, 30); // limit to 30 matches
          const matchStr = matches.length > 0 ? matches.map(m => `Line ${m.idx}: ${m.line}`).join('\n') : 'No matches found.';
          history.push(`Attempt ${attempts}: Searched for "${step.query}". Results:\n${matchStr}`);
        } else if (step.action === 'append_test') {
          console.log(chalk.cyan(`  - 📝 Appending test code chunk`));
          const codeToAppend = Array.isArray(step.code) ? step.code.join('\n') : step.code;
          testCode += '\n' + codeToAppend;
          writeFileSync(testFilePath, testCode, 'utf-8');
          history.push(`Attempt ${attempts}: Appended test code.`);
          madeProgress = true;
        } else if (step.action === 'finish') {
          console.log(chalk.green(`  - ✅ AI finished generating the test file.`));
          history.push(`Attempt ${attempts}: Finished. Reason: ${step.reason}`);
          isFinished = true;
        } else if (step.action === 'skip_file') {
          console.log(chalk.yellow(`  - ⏭ Skipped: ${step.reason}`));
          return 'skipped';
        }
      }

      if (isFinished) {
         return 'generated';
      }

      if (madeProgress) {
         stagnationCounter = 0;
      } else {
         stagnationCounter++;
      }

      if (stagnationCounter >= 10) {
         console.log(chalk.red(`\n✖ AI exhausted 10 exploration attempts without making progress. Forcibly breaking loop.`));
         break;
      }
      
      // Wait a brief moment to avoid API spam
      await new Promise(r => setTimeout(r, 500));
    }
    
    if (attempts >= maxAttempts) {
       console.log(chalk.yellow(`\n⚠ Reached maximum limit of ${maxAttempts} attempts. Safe breaking. To continue generating coverage, run the command again.`));
    }
    
    return testCode.trim().length > 0 ? 'generated' : 'failed';
  }

  private async _requestGenPlan(testCode: string, testFilePath: string, sourceFilePath: string, totalLines: number, history: string[], astMap: string, testedFunctions: string[]): Promise<any | null> {
    const historyToKeep = history.slice(-3);
    const historyContext = historyToKeep.length > 0 ? `\n--- RECENT ACTIONS & RESULTS (Last 3) ---\n${historyToKeep.join('\n\n')}\n` : '';
    const testFramework = this.projectInfo.testRunner === 'unknown' ? 'Jest' : this.projectInfo.testRunner;
    
    const testedFunctionsContext = testedFunctions.length > 0 
        ? `\n--- ALREADY TESTED FUNCTIONS (DO NOT TEST THESE AGAIN) ---\n${testedFunctions.join(', ')}\n` 
        : '';

    const isCloud = this._isCloudProvider();
    const testLines = testCode.split('\n');
    let testContext = '';
    
    if (!isCloud && testLines.length > 500) {
      const topLines = testLines.slice(0, 50).map((l, i) => `${i + 1}: ${l}`).join('\n');
      const bottomLines = testLines.slice(-200).map((l, i) => `${testLines.length - 200 + i + 1}: ${l}`).join('\n');
      testContext = `\n--- CURRENT TEST FILE PROGRESS (${testFilePath}) ---\n${topLines}\n... [${testLines.length - 250} lines omitted for Local LLM context support] ...\n${bottomLines}`;
    } else {
      const testCodeWithLines = testLines.map((l, i) => `${i + 1}: ${l}`).join('\n');
      testContext = `\n--- CURRENT TEST FILE PROGRESS (${testFilePath}) ---\n${testCodeWithLines || '(Empty)'}`;
    }

    const prompt = `You are an expert QA engineer building a test suite for a massive file using an interactive chunking agent.
--- TARGET FILE INFO ---
File: ${sourceFilePath}
Total Lines: ${totalLines}
Test Framework: ${testFramework}

${astMap}
${testedFunctionsContext}
${testContext}
${historyContext}
Your goal is to explore the target file chunk-by-chunk and incrementally build the test suite by appending test blocks.
Based on the current progress, suggest ONE JSON plan describing your next steps. You can combine multiple actions in one plan.
The JSON must follow this exact schema:
{
  "reasoning": "<explain what you are looking for or writing>",
  "steps": [
    { "action": "read_lines", "start": <line number>, "end": <line number> }
    | { "action": "append_test", "code": "SEE_BELOW" }
    | { "action": "finish", "reason": "<explanation of completion>" }
    | { "action": "skip_file", "reason": "<explanation if file contains no testable logic (e.g. pure data/config)>" }
  ]
}

CRITICAL RULES:
1. Do NOT wrap the JSON in markdown blocks. Output ONLY raw JSON.
2. Use the FILE STRUCTURE MAP provided above to identify exported functions and their exact line numbers. Do NOT search for functions manually.
3. Use \`read_lines\` to read the implementation of a specific function based on the map's line numbers.
4. After reading the implementation, use \`append_test\` to write the test case(s) for that specific function.
5. If using \`append_test\`, ensure the code is a complete block (e.g. \`describe('...', () => { ... })\`).
6. When you have tested all major exported functions in the map, use \`finish\`.
7. CRITICAL: For \`append_test\`, set the \`code\` field in the JSON exactly to the string "SEE_BELOW". Then, AFTER the JSON object, provide the actual test code wrapped in a standard markdown javascript code block (\`\`\`javascript ... \`\`\`). This prevents JSON parsing errors for large code blocks.`;

    try {
      const raw = await askAI(this.config, 'Generate a JSON plan for incremental test generation.', prompt);
      
      // Separate JSON from the code block to prevent greedy regex matching
      const jsonPart = raw.split(/```(?:javascript|typescript|js|ts)/)[0];
      const cleaned = jsonPart.replace(/```json/g, '').replace(/```/g, '').trim();
      
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return null;
      
      const plan = JSON.parse(match[0]);
      
      // Extract code block if it exists
      const codeMatch = raw.match(/```(?:javascript|typescript|js|ts)\n([\s\S]*?)\n```/);
      if (codeMatch && plan.steps) {
        for (const step of plan.steps) {
          if (step.action === 'append_test' && step.code === 'SEE_BELOW') {
            step.code = codeMatch[1];
          }
        }
      }
      
      return plan;
    } catch (error: any) {
      const msg = (error.message || error).toString().toLowerCase();
      console.log(chalk.red(`\n✖ AI generator request failed: ${error.message || error}`));
      if (msg.includes('balance') || msg.includes('429') || msg.includes('too many requests')) {
         process.exit(1);
      }
      return null;
    }
  }

  /** Core agentic reasoning loop for generating and fixing tests. */
  private async _runAgenticLoop(testFilePath: string, sourceFilePath?: string): Promise<'generated' | 'skipped' | 'failed'> {
    let attempts = 0;
    const maxAttempts = this.config.maxRetries !== undefined ? this.config.maxRetries : 3;
    let lastError = '';
    let testCode = readFileSync(testFilePath, 'utf-8');
    const history: string[] = [];
    const recentPatches: string[] = []; // To detect loops
    const fileLabel = sourceFilePath ? sourceFilePath.split('/').pop() : testFilePath.split('/').pop();

    while (maxAttempts === -1 || attempts < maxAttempts) {
      attempts++;
      const result = await runSingleTest(testFilePath, this.projectInfo);
      if (result.passed) {
        if (attempts > 1) {
          console.log(chalk.green(`\n✔ AI successfully fixed the test for ${fileLabel} after ${attempts - 1} attempt(s)!`));
        } else {
          console.log(chalk.green(`\n✔ Test ${fileLabel} passed successfully in isolation. No AI fixes were needed!`));
        }
        return 'generated';
      }
      
      lastError = result.output;
      const maxText = maxAttempts === -1 ? '∞' : maxAttempts;
      console.log(chalk.yellow(`\n⚠ Test failed for ${fileLabel}. Requesting fix from AI (Attempt ${attempts} of ${maxText})...`));
      
      const snippet = lastError.split('\n').slice(0, 15).join('\n');
      console.log(chalk.dim(`  Error Snippet:\n    ${snippet.replace(/\n/g, '\n    ')}`));

      let explorationContext = '';
      let explorationAttempts = 0;
      let planExecuted = false;
      let previousStepsHash = '';
      let duplicateCount = 0;
      
      const maxExplorationSteps = this.config.maxExplorationSteps !== undefined ? this.config.maxExplorationSteps : 5;

      while (explorationAttempts < maxExplorationSteps && !planExecuted) {
        explorationAttempts++;
        const plan = await this._requestPlan(lastError, testCode, testFilePath, history, sourceFilePath, explorationContext);
        if (!plan) {
          console.log(chalk.red(`✖ AI failed to generate a valid plan. Retrying...`));
          explorationContext += `\n--- SYSTEM ERROR ---\nYour last response was not valid JSON. Ensure you output raw JSON only, and properly escape quotes and newlines in any strings (especially replacementCode).\n`;
          continue;
        }
        
        const currentStepsHash = JSON.stringify(plan.steps);
        if (currentStepsHash === previousStepsHash) {
          duplicateCount++;
          if (duplicateCount >= 2) {
            console.log(chalk.red(`✖ AI generated the exact same exploration action consecutively. Forcibly breaking loop.`));
            break;
          }
        } else {
          duplicateCount = 0;
          previousStepsHash = currentStepsHash;
        }

        console.log(chalk.cyan(`🤖 AI returned a plan:`));
        if (plan.reasoning) {
          console.log(chalk.gray(`  🤔 Reasoning: ${plan.reasoning}`));
        }
        
        let needsToBreakAndRunTests = false;
        
        for (const step of plan.steps) {
          if (step.action === 'read_file') {
            console.log(chalk.cyan(`  - 📖 Reading file: ${step.path}`));
            try {
              const content = readFileSync(resolve(process.cwd(), step.path), 'utf-8');
              explorationContext += `\n--- READ FILE: ${step.path} ---\n${content}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Read file ${step.path}`);
            } catch (err: any) {
              explorationContext += `\n--- FAILED TO READ FILE: ${step.path} ---\nError: ${err.message}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Failed to read file ${step.path}`);
            }
          } else if (step.action === 'search_file') {
            console.log(chalk.cyan(`  - 🔍 Searching for "${step.query}" in ${step.file}`));
            try {
              const content = readFileSync(resolve(process.cwd(), step.file), 'utf-8');
              const matches = content.split('\n')
                 .map((line, idx) => ({ line, idx: idx + 1 }))
                 .filter(({ line }) => line.includes(step.query))
                 .slice(0, 30);
              const matchStr = matches.length > 0 ? matches.map(m => `Line ${m.idx}: ${m.line}`).join('\n') : 'No matches found.';
              explorationContext += `\n--- SEARCH RESULTS FOR "${step.query}" IN ${step.file} ---\n${matchStr}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Searched for "${step.query}" in ${step.file}`);
            } catch (err: any) {
              explorationContext += `\n--- FAILED TO SEARCH FILE: ${step.file} ---\nError: ${err.message}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Failed to search file ${step.file}`);
            }
          } else if (step.action === 'read_lines') {
            console.log(chalk.cyan(`  - 📖 Reading lines ${step.startLine}-${step.endLine} from ${step.file}`));
            try {
              const content = readFileSync(resolve(process.cwd(), step.file), 'utf-8');
              const lines = content.split('\n');
              const startIdx = Math.max(0, step.startLine - 1);
              const endIdx = Math.min(lines.length, step.endLine);
              const chunk = lines.slice(startIdx, endIdx).map((l, i) => `${startIdx + i + 1}: ${l}`).join('\n');
              explorationContext += `\n--- READ LINES ${step.startLine}-${step.endLine} FROM ${step.file} ---\n${chunk}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Read lines ${step.startLine}-${step.endLine} from ${step.file}`);
            } catch (err: any) {
              explorationContext += `\n--- FAILED TO READ LINES: ${step.file} ---\nError: ${err.message}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Failed to read lines from ${step.file}`);
            }
          } else if (step.action === 'list_dir') {
            console.log(chalk.cyan(`  - 📂 Listing directory: ${step.path}`));
            try {
              const files = readdirSync(resolve(process.cwd(), step.path));
              explorationContext += `\n--- DIRECTORY: ${step.path} ---\n${files.join('\n')}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Listed directory ${step.path}`);
            } catch (err: any) {
              explorationContext += `\n--- FAILED TO LIST DIRECTORY: ${step.path} ---\nError: ${err.message}\n`;
              history.push(`Attempt ${attempts} (Exploration ${explorationAttempts}): Failed to list directory ${step.path}`);
            }
          } else if (step.action === 'replace_lines') {
            needsToBreakAndRunTests = true;
            console.log(chalk.cyan(`  - 📝 Replace lines ${step.startLine}-${step.endLine} in ${step.file.split('/').pop()}`));
            history.push(`Attempt ${attempts}: Replaced lines ${step.startLine}-${step.endLine} in ${step.file.split('/').pop()}`);
            
            // Anti-loop safeguard: If AI applies the exact same code 3 times, hard abort.
            recentPatches.push(step.replacementCode);
            if (recentPatches.length > 3) recentPatches.shift();
            if (recentPatches.length === 3 && recentPatches.every(code => code === step.replacementCode)) {
               console.log(chalk.red(`✖ AI generated the exact same patch 3 times in a row. Forcibly breaking infinite loop.`));
               return 'failed';
            }
          } else if (step.action === 'install_deps') {
            needsToBreakAndRunTests = true;
            console.log(chalk.cyan(`  - 📦 Install dependencies: ${step.deps.join(', ')}`));
            history.push(`Attempt ${attempts}: Installed dependencies ${step.deps.join(', ')}`);
          } else if (step.action === 'delete_file') {
            needsToBreakAndRunTests = true;
            console.log(chalk.red(`  - 🗑️ Deleting file: ${step.file}`));
            history.push(`Attempt ${attempts}: Deleted file ${step.file}`);
          } else if (step.action === 'abort') {
            needsToBreakAndRunTests = true;
            console.log(chalk.cyan(`  - 🛑 Abort: ${step.reason}`));
            history.push(`Attempt ${attempts}: Aborted with reason: ${step.reason}`);
            
            if (sourceFilePath) {
              const bugFile = resolve(process.cwd(), 'aitest-bugs.md');
              const fs = await import('fs');
              fs.appendFileSync(bugFile, `\n## Source Code Issue Detected in ${sourceFilePath}\n**AI Reasoning**: ${plan.reasoning || 'No reasoning provided.'}\n**Abort Reason**: ${step.reason}\n`, 'utf-8');
              console.log(chalk.yellow(`  ⚠ Issue logged to aitest-bugs.md for later fixing.`));
            }
          }
        }

        if (needsToBreakAndRunTests) {
          // 4️⃣ Execute the plan.
          const execResult = await this._executePlan(plan);
          if (execResult === 'abort') {
            console.log(chalk.red(`✖ AI plan execution aborted.`));
            return 'skipped';
          }
          planExecuted = true;
        } else {
          // It just explored! Wait a brief moment before looping to avoid slamming the API too fast
          await new Promise(r => setTimeout(r, 500));
        }
      }
      
      if (!planExecuted) {
          console.log(chalk.red(`✖ AI exhausted exploration limit without applying a patch. Giving up on this file.`));
          return 'failed';
      }

      // Reload test code after a possible patch.
      if (existsSync(testFilePath)) {
        testCode = readFileSync(testFilePath, 'utf-8');
      }
    }
    
    console.log(chalk.red(`\n✖ Exhausted ${maxAttempts} AI attempts without passing.`));
    return 'failed'; // exhausted attempts
  }

  /** Derive the .test.* filename from a source file path. */
  private _deriveTestPath(sourceFilePath: string): string {
    const ext = sourceFilePath.substring(sourceFilePath.lastIndexOf('.'));
    const base = sourceFilePath.substring(
      sourceFilePath.lastIndexOf('/') + 1,
      sourceFilePath.length - ext.length
    );
    const dir = dirname(sourceFilePath);
    return resolve(dir, `${base}.test${ext}`);
  }

  /** Prompt the LLM for a JSON plan based on a failed test run. */
  private async _requestPlan(errorOutput: string, testCode: string, testFilePath: string, history: string[], sourceFilePath?: string, explorationContext: string = ''): Promise<AgenticPlan | null> {
    let historyContext = '';
    if (history.length > 0) {
      historyContext = `\n--- PREVIOUS ACTIONS TAKEN ---\n${history.join('\n')}\nWARNING: The test is still failing. Do NOT suggest the exact same action again.`;
      
      // Multi-Agent Meta-Prompting: Wake up the Analyzer Agent if a patch failed or if we are stuck exploring for too long
      const hasAppliedPatch = history.some(h => h.includes('Replaced lines') || h.includes('Installed dependencies') || h.includes('Aborted'));
      if (history.length >= 2 && hasAppliedPatch) {
        const dynamicInstruction = await this._analyzeFailure(history, errorOutput);
        historyContext += `\n\nCRITICAL SELF-CORRECTION FROM ANALYZER AGENT:\n${dynamicInstruction}\nYOU MUST OBEY THIS INSTRUCTION IN YOUR NEXT PLAN.`;
      }
    }
    let sourceContext = '';
    if (sourceFilePath && existsSync(sourceFilePath)) {
      const sourceContent = readFileSync(sourceFilePath, 'utf-8');
      const sourceLines = sourceContent.split('\n');
      if (sourceLines.length > 1000) {
        sourceContext = `\n--- SOURCE FILE INFO ---\nThe source file (${sourceFilePath}) is massive (${sourceLines.length} lines) and has been omitted from this prompt to save context and improve accuracy. You MUST use the "search_file" and "read_lines" actions to dynamically read the specific functions you need to fix the test.`;
      } else {
        sourceContext = `\n--- SOURCE FILE (${sourceFilePath}) ---\n${sourceContent}`;
      }
    }
    const workspaceContext = this.workspaceMap ? `\n--- WORKSPACE FILE STRUCTURE ---\n${this.workspaceMap}` : '';
    const explorationContextString = explorationContext ? `\n--- EXPLORATION CONTEXT ---\n${explorationContext}` : '';
    const isCloud = this._isCloudProvider();
    const testLines = testCode.split('\n');
    let testContext = '';
    
    if (!isCloud && testLines.length > 500) {
      testContext = `\n--- TEST FILE INFO ---\nThe test file (${testFilePath}) is massive (${testLines.length} lines) and has been omitted to support Local LLMs. Look at the ERROR OUTPUT to find the line number of the failing test (e.g., file.test.js:6540). You MUST use the "read_lines" action to read the test file around that line number before applying a "replace_lines" patch.`;
    } else {
      const testCodeWithLines = testLines.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
      testContext = `\n--- TEST FILE (${testFilePath}) ---\n${testCodeWithLines}`;
    }

    const prompt = `You are an expert QA engineer. The following test has failed.${sourceContext}${workspaceContext}${explorationContextString}${testContext}
--- ERROR OUTPUT ---
${errorOutput}${historyContext}
Based on this information, suggest ONE JSON plan describing the next actionable step. The JSON must follow this schema:
{ "reasoning": "<explain the failure and your fix or exploration strategy>", "steps": [ { "action": "replace_lines", "file": "<path to test file or mock file>", "startLine": <number>, "endLine": <number>, "replacementCode": "SEE_BELOW" } | { "action": "search_file", "file": "<path>", "query": "<string to search for>" } | { "action": "read_lines", "file": "<path>", "startLine": <number>, "endLine": <number> } | { "action": "read_file", "path": "<relative path to file>" } | { "action": "list_dir", "path": "<relative path to dir>" } | { "action": "install_deps", "deps": ["<package>"], "dev": <boolean> } | { "action": "generate_mock", "target": "<package-name>", "type": "external" } | { "action": "delete_file", "file": "<path>" } | { "action": "abort", "reason": "<text>" } ] }
CRITICAL RULES:
1. To explore massive files safely, use "search_file" to find function signatures, then "read_lines" to read the implementation block. For small files, use "read_file". If you need to see what files exist in a directory, use "list_dir".
2. You may ONLY patch the test file (${testFilePath}), files inside the __mocks__ directory, or test configuration/setup files (like jest.config.js or setupTests.js) using the "replace_lines" action. Do NOT modify the actual application source code. The "delete_file" action is ONLY allowed for removing broken files inside the __mocks__ directory or test configs.
3. For "replace_lines", provide the exact startLine and endLine numbers based on the line numbers shown in the TEST FILE block. To insert code without removing any lines, set startLine and endLine to the line number where you want to insert.
4. If the test fails due to complex chained object queries (e.g. ORMs, query builders) or missing dependencies, return the "generate_mock" action. You can output multiple "generate_mock" actions in the same plan (e.g. one for an external library, one for an internal module, etc.) to instantly build global mocks instead of manually rewriting the test file.
5. Do NOT wrap the JSON in markdown code blocks. Output ONLY the raw JSON object.
6. If you cannot fix the issue, return an "abort" action.
7. If using "install_deps" for testing libraries (like supertest or jest), set "dev": true. If installing application source dependencies (like express or mongoose), set "dev": false.
8. CRITICAL: For "replace_lines", set "replacementCode" exactly to the string "SEE_BELOW". Then, AFTER the JSON object, provide the actual replacement code wrapped in a standard markdown javascript code block (\`\`\`javascript ... \`\`\`). This prevents JSON parsing errors for multi-line code.`;
    try {
      const raw = await askAI(this.config, 'Generate a JSON plan to fix the failing test.', prompt);
      const plan = this._parsePlan(raw);
      if (plan && this._validatePlan(plan, testFilePath)) return plan;
      return null;
    } catch (error: any) {
      const msg = (error.message || error).toString().toLowerCase();
      console.log(chalk.red(`\n✖ AI request failed: ${error.message || error}`));
      if (msg.includes('balance') || msg.includes('429') || msg.includes('too many requests')) {
         process.exit(1);
      }
      return null;
    }
  }

  /** The Analyzer Agent: analyzes failures and generates a dynamic strategy pivot. */
  private async _analyzeFailure(history: string[], errorOutput: string): Promise<string> {
    const prompt = `You are the Analyzer Agent. The Actor Agent is stuck in a loop trying to fix a test.\n\n--- PREVIOUS ACTIONS TAKEN ---\n${history.join('\n')}\n\n--- CURRENT ERROR OUTPUT ---\n${errorOutput}\n\nBased on this, what is the Actor Agent doing wrong? Write a 1-2 sentence critical instruction for the Actor Agent telling it exactly how to change its strategy. 
CRITICAL RULES:
1. If the Actor is stuck trying to mock untestable framework plumbing (e.g., server entry points, complex middleware, or deep library internals), instruct it to STOP mocking immediately. Tell it to either write an integration test using the appropriate framework (e.g. supertest), or return the 'abort' action if it cannot be fixed.
2. If the Actor is struggling with complex chained object errors, tell it to use 'generate_mock' to abstract the issue globally.
Output ONLY the instruction string, nothing else.`;
    try {
      console.log(chalk.cyan(`  - 🧠 Analyzer Agent evaluating failure...`));
      const response = await askAI(this.config, 'Analyze failure and generate a self-correction instruction.', prompt);
      return response.trim();
    } catch (error: any) {
      const msg = (error.message || error).toString().toLowerCase();
      if (msg.includes('balance') || msg.includes('429') || msg.includes('too many requests')) {
         process.exit(1);
      }
      return "CRITICAL SELF-CORRECTION: You are failing repeatedly. Pivot your strategy and stop repeating the same actions.";
    }
  }

  /** Extract JSON from LLM response and parse it. */
  private _parsePlan(text: string): AgenticPlan | null {
    try {
      const jsonPart = text.split(/```(?:javascript|typescript|js|ts)/)[0];
      const cleaned = jsonPart.replace(/```json/g, '').replace(/^```\n/gm, '').trim();
      
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const obj = JSON.parse(match[0]);
      
      if (obj && Array.isArray(obj.steps)) {
        // Extract code block if it exists
        const codeMatch = text.match(/```(?:javascript|typescript|js|ts)\n([\s\S]*?)\n```/);
        if (codeMatch) {
          for (const step of obj.steps) {
            if (step.action === 'replace_lines' && step.replacementCode === 'SEE_BELOW') {
              step.replacementCode = codeMatch[1];
            }
          }
        }
        return obj as AgenticPlan;
      }
    } catch (e) {
      // malformed JSON
    }
    return null;
  }

  /** Validate that the plan only contains allowed actions and safe file paths. */
  private _validatePlan(plan: AgenticPlan, testFilePath: string): boolean {
    const allowed = new Set(['replace_lines', 'install_deps', 'abort', 'read_file', 'list_dir', 'search_file', 'read_lines', 'generate_mock', 'delete_file']);
    for (const step of plan.steps) {
      if (!allowed.has(step.action)) return false;
      if (step.action === 'replace_lines' || step.action === 'delete_file') {
        const abs = resolve(step.file);
        const isTestFile = abs === testFilePath;
        const isMockFile = abs.includes('__mocks__');
        const isConfigFile = abs.toLowerCase().includes('jest.config') || abs.toLowerCase().includes('setuptests') || abs.toLowerCase().includes('setup.js') || abs.toLowerCase().includes('setup.ts');
        
        if (step.action === 'delete_file') {
           if (!isMockFile && !isConfigFile) return false;
        } else {
           if (!isTestFile && !isMockFile && !isConfigFile) return false; // Strictly enforce only patching the test file, mock files, or test config files
           if (typeof (step as any).startLine !== 'number') return false;
           if (typeof (step as any).endLine !== 'number') return false;
           if (typeof (step as any).replacementCode !== 'string' && !Array.isArray((step as any).replacementCode)) return false;
        }
      }
      if (step.action === 'install_deps') {
        if (!Array.isArray((step as any).deps)) return false;
      }
      if (step.action === 'read_file' || step.action === 'list_dir') {
        if (typeof (step as any).path !== 'string') return false;
      }
      if (step.action === 'search_file') {
        if (typeof (step as any).file !== 'string') return false;
        if (typeof (step as any).query !== 'string') return false;
      }
      if (step.action === 'read_lines') {
        if (typeof (step as any).file !== 'string') return false;
        if (typeof (step as any).startLine !== 'number') return false;
        if (typeof (step as any).endLine !== 'number') return false;
      }
      if (step.action === 'generate_mock') {
        if (typeof (step as any).target !== 'string') return false;
        if ((step as any).type !== 'external' && (step as any).type !== 'internal') return false;
      }
    }
    return true;
  }

  /** Execute a validated plan step‑by‑step. */
  private async _executePlan(plan: AgenticPlan): Promise<'continue' | 'abort'> {
    for (const step of plan.steps) {
      switch (step.action) {
        case 'replace_lines': {
          const fileContent = existsSync(step.file) ? readFileSync(step.file, 'utf-8') : '';
          const lines = fileContent.split('\n');
          const startIdx = Math.max(0, step.startLine - 1);
          const endIdx = Math.min(lines.length, step.endLine);
          
          let newLines: string[] = [];
          if (Array.isArray((step as any).replacementCode)) {
            newLines = (step as any).replacementCode;
          } else if (typeof (step as any).replacementCode === 'string') {
            newLines = (step as any).replacementCode.split('\n');
          }
          
          lines.splice(startIdx, endIdx - startIdx, ...newLines);
          
          writeFileSync(step.file, lines.join('\n'), 'utf-8');
          break;
        }
        case 'delete_file': {
          if (existsSync(step.file)) {
            const fs = await import('fs');
            fs.unlinkSync(step.file);
          }
          break;
        }
        case 'install_deps': {
          const deps = (step as any).deps.join(' ');
          const isDev = (step as any).dev !== false; // default to dev if not explicitly false
          
          let installCmd = '';
          const { detectProjectInfo } = await import('./detector.js');
          const projectInfo = detectProjectInfo(process.cwd());
          
          if (projectInfo.packageManager === 'yarn') {
             installCmd = `yarn add ${deps} ${isDev ? '--dev' : ''}`;
          } else if (projectInfo.packageManager === 'pnpm') {
             installCmd = `pnpm add ${deps} ${isDev ? '-D' : ''}`;
          } else if (projectInfo.packageManager === 'bun') {
             installCmd = `bun add ${deps} ${isDev ? '-d' : ''}`;
          } else {
             // Fallback to npm and use legacy-peer-deps to avoid ERESOLVE on older codebases
             installCmd = `npm install ${isDev ? '--save-dev' : '--save'} ${deps} --legacy-peer-deps`;
          }
          
          try {
            await execAsync(installCmd, { cwd: process.cwd() });
          } catch (e: any) {
            console.log(chalk.red(`  ✖ dependency install failed: ${e.message.split('\n')[0]}`));
            return 'abort';
          }
          break;
        }
        case 'generate_mock': {
          console.log(chalk.magenta(`  - 🛠 Auto-Mocking missing dependency: ${(step as any).target}`));
          await this.generateMock((step as any).target, (step as any).type);
          break;
        }
        case 'abort': {
          return 'abort';
        }
      }
    }
    return 'continue';
  }

  /**
   * Generates a global __mocks__ file for the given dependency or file.
   */
  public async generateMock(target: string, type: 'internal' | 'external', forceUpdate: boolean = false): Promise<'generated' | 'failed' | 'skipped'> {
    let prompt = '';
    let mockDir = '';
    let mockFileName = '';

    if (type === 'external') {
      prompt = `Generate a Jest/Vitest global mock implementation for the NPM package: "${target}".\n` +
               `Output ONLY the raw javascript/typescript code for the mock. Do not include markdown code blocks.`;
      mockDir = join(process.cwd(), '__mocks__');
      mockFileName = `${target}.js`;
    } else {
      if (!existsSync(target)) {
        console.error(chalk.red(`File not found: ${target}`));
        return 'failed';
      }
      const sourceCode = readFileSync(target, 'utf-8');
      prompt = `Generate a Jest/Vitest global mock for the following local file:\n\n` +
               `\`\`\`\n${sourceCode}\n\`\`\`\n\n` +
               `Output ONLY the raw javascript/typescript code for the mock. Do not include markdown code blocks.`;
      mockDir = join(dirname(target), '__mocks__');
      const baseName = basename(target);
      mockFileName = baseName;
    }

    const mockPath = join(mockDir, mockFileName);
    let existingMockCode = '';

    if (existsSync(mockPath)) {
      if (forceUpdate) {
        // Will overwrite entirely
      } else {
        existingMockCode = readFileSync(mockPath, 'utf-8');
        console.log(chalk.blue(`ℹ Evaluating existing mock for ${target}...`));
      }
    }

    if (existingMockCode) {
      prompt += `\n\nHere is the existing mock file for this target:\n\`\`\`javascript\n${existingMockCode}\n\`\`\`\n\n` +
                `Analyze this existing mock. If it is missing standard functions or properties for ${target}, return the FULLY UPDATED mock file (merging your new additions with the existing code).\n` +
                `Do not delete any custom manual logic the user already wrote.\n` +
                `If the existing mock already looks complete and covers standard cases, return EXACTLY the word: "COMPLETE".\n` +
                `Output ONLY the raw javascript/typescript code.`;
    }

    try {
      const response = await askAI(this.config, "You are an expert QA engineer.", prompt);
      let code = response.trim();
      
      if (code === 'COMPLETE' || code === '"COMPLETE"' || code === "'COMPLETE'") {
         return 'skipped';
      }

      if (code.startsWith('\`\`\`')) {
         const lines = code.split('\n');
         lines.shift();
         if (lines[lines.length - 1].startsWith('\`\`\`')) {
            lines.pop();
         }
         code = lines.join('\n');
      }

      const mockPath = join(mockDir, mockFileName);
      const mockPathDir = dirname(mockPath);
      if (!existsSync(mockPathDir)) {
        mkdirSync(mockPathDir, { recursive: true });
      }

      writeFileSync(mockPath, code, 'utf-8');
      return 'generated';
    } catch (e: any) {
      console.error(chalk.red(`Failed to generate mock: ${e.message}`));
      return 'failed';
    }
  }
}
