import { Command } from 'commander';
import { loadConfig, AITestConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { detectProjectInfo, ProjectInfo } from '../core/detector.js';
import { runSingleTest } from '../core/runner.js';
import { askAI } from '../core/ai.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import fg from 'fast-glob';
import { scanDependencies, generateWorkspaceMap, scanExternalDependencies } from '../core/scanner.js';
import chalk from 'chalk';
import { AgenticPlanner } from '../core/agentic.js';

const execAsync = promisify(exec);
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Generate tests for a single file.
 * Returns "generated", "skipped" or "failed".
 */
export async function generateTestForFile(
  filePath: string,
  config: AITestConfig,
  projectInfo: ProjectInfo,
  forceUpdate = false,
  evaluateExisting = false,
  workspaceMap = ''
): Promise<'generated' | 'skipped' | 'failed'> {
  const relPath = relative(process.cwd(), filePath);
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const name = basename(filePath, ext);
  const testFilePath = resolve(dir, `${name}.test${ext}`);

  const spinner = logger.spinner(`Analyzing ${relPath}...`).start();

  if (existsSync(testFilePath) && !forceUpdate) {
    spinner.info(`Evaluating existing test file for missing coverage: ${relPath}`);
    evaluateExisting = true;
  }

  let fileContent = '';
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    spinner.fail(`Could not read file ${filePath}`);
    return 'failed';
  }

  const depsContext = await scanDependencies(filePath);
  
  // Pre-flight Global Mocking
  const externalDeps = scanExternalDependencies(filePath);
  if (externalDeps.length > 0) {
     const planner = new AgenticPlanner(config, projectInfo);
     for (const dep of externalDeps) {
        const mockPath = resolve(process.cwd(), '__mocks__', `${dep}.js`);
        if (!existsSync(mockPath)) {
           spinner.info(`Pre-flight: Building missing global mock for "${dep}"...`);
           await planner.generateMock(dep, 'external');
        }
     }
  }

  let additionalContext = depsContext
    ? `\n\n--- ARCHITECTURAL CONTEXT (DEPENDENCIES) ---\n${depsContext}`
    : '';

  if (workspaceMap) {
    additionalContext += `\n\n--- WORKSPACE FILE STRUCTURE ---\n${workspaceMap}`;
  }

  let existingTestContext = '';
  if (existsSync(testFilePath)) {
    const existingCode = readFileSync(testFilePath, 'utf-8');
    existingTestContext = `\n\n--- EXISTING TEST SUITE (NEEDS IMPROVEMENT) ---\n${existingCode}\n`;
  }

  try {
    const promptContext = `Original file name: ${relPath}\n\nCode:\n${fileContent}\n\n${additionalContext}${existingTestContext}`;

    let promptInstructions = '';
    if (existingTestContext) {
      if (forceUpdate) {
        promptInstructions =
          'You are an expert QA and software testing engineer. The provided existing test suite does not have 100% code coverage. Analyze the source code and the existing test suite, and REWRITE the test suite to include new test cases that cover the missing branches and logic. Output ONLY valid executable code (with markdown code blocks) and nothing else.';
      } else if (evaluateExisting) {
        promptInstructions =
          'You are an expert QA and software testing engineer. Analyze the source code and the existing test suite to evaluate its code coverage. If the existing test suite is missing test cases for certain branches or logic, REWRITE the test suite to include new test cases that cover the missing parts. Output ONLY valid executable code (with markdown code blocks) and nothing else. If the existing test suite already fully covers the source code, reply ONLY with the exact string "SKIP_FILE".';
      }
    } else {
      const testFramework = projectInfo.testRunner === 'unknown' ? 'Jest' : projectInfo.testRunner;
      promptInstructions = `You are an expert QA and software testing engineer. Generate a comprehensive unit test suite for the provided code. Output ONLY valid executable code (with markdown code blocks) and nothing else. The target test framework is ${testFramework}. If the file is purely type definitions, interfaces, simple exports, or does not contain testable logic, reply ONLY with the exact string "SKIP_FILE" and do not generate any code. You will be provided with the target code and its imported dependencies to ensure you have the full architectural context.\nCRITICAL: Assume global mocks exist in the __mocks__ directory for all third-party libraries. DO NOT write massive inline mock implementations inside the test file. Rely on the global mocks and only write the pure unit test logic.\nCRITICAL: If the file represents a framework entry point or server initialization file, do NOT try to unit test internal plumbing with mocks. You MUST write an integration test (using tools like supertest if applicable).\nCRITICAL: If testing databases or ORMs, use standard mock techniques. If using Vitest, use vi.mocked() to mock imported functions to avoid TypeScript errors like 'Property does not exist on type'.`;
    }

    const generatedCode = await askAI(config, promptInstructions, promptContext);

    if (generatedCode.includes('SKIP_FILE')) {
      spinner.info(`Skipped ${relPath}: No testable logic found.`);
      return 'skipped';
    }

    let testCode = generatedCode;
    const match =
      generatedCode.match(/```(?:javascript|typescript|ts|js)?\n([\s\S]*?)```/) ||
      generatedCode.match(/```[\w]*\n([\s\S]*?)```/);
    if (match && match[1]) {
      testCode = match[1].trim();
    }

    if (!testCode || testCode.trim() === '') {
      spinner.warn(`AI returned empty code for ${relPath}. Skipping to prevent writing an empty file.`);
      return 'skipped';
    }

    writeFileSync(testFilePath, testCode, 'utf-8');
    spinner.stop();
    return 'generated';
  } catch (error: any) {
    spinner.fail(`Error generating test for ${relPath}: ${error.message}`);
    return 'failed';
  }
}

export const generateCommand = new Command('generate')
  .description('Generate missing unit tests for the current project using Agentic AI')
  .option('-a, --all', 'Generate tests for all missing files')
  .option('-f, --file <path>', 'Generate tests for a specific file')
  .option('-u, --force-update', 'Force rewrite existing test files (ignores code coverage logic)')
  .option('-e, --evaluate-existing', 'Evaluate existing tests and ONLY rewrite if missing code coverage')
  .action(async (options) => {
    const config = await loadConfig();
    if (!config) {
      logger.error('Configuration not found. Run `aitest init` first.');
      return;
    }
    if (!options.file && !options.all && !options.coverage) {
      logger.error('Please specify --file <path>, --all, or --coverage');
      return;
    }
    const projectInfo = detectProjectInfo();
    const workspaceMap = await generateWorkspaceMap();

    if (options.coverage) {
      logger.info('Running coverage-driven test generation...');
      let testCommand = 'npm test -- --coverage';
      if (projectInfo.testRunner === 'mocha' || projectInfo.testRunner === 'unknown') {
        testCommand = 'npm test --coverage';
      }
      const spinner = logger.spinner('Running test suite to collect coverage metrics...').start();
      try {
        const { stdout } = await execAsync(testCommand, { cwd: process.cwd() });
        spinner.succeed('Coverage data collected.');
        const analyzeSpinner = logger.spinner('Analyzing coverage gaps with AI...').start();
        const aiResponse = await askAI(
          config,
          'Extract all file paths from this coverage report that have less than 100% coverage (statement, branch, or function). Return ONLY a JSON array of string paths (e.g. ["src/math.js"]). Do not output anything else. If no files are listed, return [].',
          `STDOUT:\n${stdout.slice(-5000)}`
        );
        analyzeSpinner.succeed('Coverage gaps identified.');
        
        const match = aiResponse.match(/\[[\s\S]*\]/);
        if (match) {
          const filesToFix: string[] = JSON.parse(match[0]);
          if (filesToFix.length === 0) {
            logger.success('All files have 100% coverage!');
            return;
          }
          logger.info(`Found ${filesToFix.length} files missing coverage. Starting targeted generation...`);
          for (const file of filesToFix) {
            const fullPath = resolve(process.cwd(), file);
            if (existsSync(fullPath)) {
              await generateTestForFile(fullPath, config, projectInfo, true, false, workspaceMap);
            }
          }
          logger.success(`\nFinished coverage-driven generation for ${filesToFix.length} files.`);
          return;
        } else {
          logger.error('Failed to parse AI response for coverage files.');
          return;
        }
      } catch (e: any) {
        spinner.fail(`Failed to collect coverage data: ${e.message}`);
        return;
      }
    }

    if (options.all) {
      logger.info('Scanning project for source files...');
      const files = await fg(['**/*.{js,ts,jsx,tsx}'], {
        ignore: [
          '**/node_modules/**',
          '**/dist/**',
          '**/build/**',
          '**/coverage/**',
          '**/__mocks__/**',
          '**/*.test.*',
          '**/*.spec.*',
          '**/vite.config.*',
          '**/tsup.config.*',
          '**/.*'
        ],
        cwd: process.cwd()
      });
      if (files.length === 0) {
        logger.info('No source files found.');
        return;
      }
      logger.info(`Found ${files.length} files. Starting test generation using Agentic AI...`);
      let successCount = 0;
      let skippedCount = 0;
      
      const { AgenticPlanner } = await import('../core/agentic.js');
      const planner = new AgenticPlanner(config, projectInfo, workspaceMap);
      
      const startTime = Date.now();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fullPath = resolve(process.cwd(), file);
        const result = await planner.generateFile(fullPath, { forceUpdate: options.forceUpdate, evaluateExisting: options.evaluateExisting, workspaceMap });
        if (result === 'generated') successCount++; else if (result === 'skipped') skippedCount++;
      }
      
      logger.success(`\nFinished! Generated tests for ${successCount} files (Skipped ${skippedCount} files). Total processed: ${files.length}.`);
      if (successCount > 0) {
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
        console.log(chalk.magentaBright(`\n✨ AI successfully generated tests for ${successCount} files in ${elapsedSeconds}s! Saved you ~${successCount * 2} hours of typing.`));
        
        // Dynamically import terminal-link
        const terminalLink = (await import('terminal-link')).default;
        const tweetUrl = `https://twitter.com/intent/tweet?text=I%20just%20used%20%40aitestcli%20to%20autonomously%20generate%20${successCount}%20test%20suites%20in%20${elapsedSeconds}s!%20%F0%9F%A4%AF%0A%0A%23ai%20%23testing%20%23javascript&url=https://www.npmjs.com/package/ai-test-cli`;
        console.log(chalk.cyan('🚀 ' + terminalLink('Share your win on Twitter!', tweetUrl)));
        console.log(chalk.yellow('☕ ' + terminalLink('Buy the creator a coffee!', 'https://buymeacoffee.com/cijaytechnh')) + '\n');
      }
      process.exit(0);
    } else if (options.file) {
      if (options.file.includes('.test.') || options.file.includes('.spec.')) {
        logger.error(`\n✖ Oops! You passed a test file (${options.file}) to the generate command.`);
        logger.info(`💡 The 'generate' command expects the SOURCE file (e.g. app/controllers/AdminController.js).`);
        logger.info(`💡 If you want to evaluate/extend this existing test, point the generate command to the SOURCE file.`);
        logger.info(`💡 If you want to fix this broken test file, run: aitest fix`);
        process.exit(1);
      }

      const filePath = resolve(process.cwd(), options.file);
      const { AgenticPlanner } = await import('../core/agentic.js');
      const planner = new AgenticPlanner(config, projectInfo, workspaceMap);
      
      logger.info(`Starting Agentic test generation for ${options.file}...`);
      const startTime = Date.now();
      const result = await planner.generateFile(filePath, { forceUpdate: options.forceUpdate, evaluateExisting: options.evaluateExisting, workspaceMap });
      if (result === 'generated') {
         const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
         logger.success(`\nFinished! Successfully generated test for ${options.file}.`);
         console.log(chalk.magentaBright(`\n✨ AI successfully generated the test suite in ${elapsedSeconds}s! Saved you ~2 hours of typing.`));
         
         // Dynamically import terminal-link
         const terminalLink = (await import('terminal-link')).default;
         const tweetUrl = `https://twitter.com/intent/tweet?text=I%20just%20used%20%40aitestcli%20to%20autonomously%20generate%20a%20test%20suite%20in%20${elapsedSeconds}s!%20%F0%9F%A4%AF%0A%0A%23ai%20%23testing%20%23javascript&url=https://www.npmjs.com/package/ai-test-cli`;
         console.log(chalk.cyan('🚀 ' + terminalLink('Share your win on Twitter!', tweetUrl)));
         console.log(chalk.yellow('☕ ' + terminalLink('Buy the creator a coffee!', 'https://buymeacoffee.com/cijaytechnh')) + '\n');
      } else if (result === 'skipped') {
         logger.info(`\nSkipped test generation for ${options.file}.`);
      } else {
         logger.error(`\nFailed to generate test for ${options.file}.`);
      }
      process.exit(0);
    }
  });
