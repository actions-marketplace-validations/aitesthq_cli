import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { detectProjectInfo } from '../core/detector.js';
import { runSingleTest } from '../core/runner.js';
import { askAI } from '../core/ai.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import chalk from 'chalk';

const execAsync = promisify(exec);

export const fixCommand = new Command('fix')
  .description('Attempts automatic repair of failing tests using Agentic AI')
  .option('--ci', 'Run in CI mode (disables interactive prompts and fails loudly on errors)')
  .action(async (options) => {
    const config = await loadConfig();
    if (!config) {
      logger.error('Configuration not found. Run `aitest init` first.');
      return;
    }
    logger.info('Starting test suite to identify failures using Agentic AI...\n');
    
    const projectInfo = detectProjectInfo();
    let testCommand = 'npm test';
    if (projectInfo.testRunner === 'vitest') {
        testCommand = 'npx vitest run';
    } else if (projectInfo.testRunner === 'jest') {
        testCommand = 'npx jest --silent';
    } else if (projectInfo.testRunner === 'mocha') {
        testCommand = 'npx mocha';
    }

    const spinner = logger.spinner(`Running tests (${testCommand})...`).start();
    
    let stdoutStr = '';
    let stderrStr = '';
    let testFailed = false;

    try {
      const { stdout, stderr } = await execAsync(testCommand);
      stdoutStr = stdout;
      stderrStr = stderr;
      spinner.succeed('Tests passed! No fixing needed.');
      return;
    } catch (error: any) {
      testFailed = true;
      stdoutStr = error.stdout || '';
      stderrStr = error.stderr || error.message;
      spinner.warn('Tests failed. Starting AI repair flow...');
    }

    const analyzeSpinner = logger.spinner('Analyzing test failure to identify the failing file...').start();
    
    const outputToAnalyze = `
STDOUT:
${stdoutStr.slice(-3000)}

STDERR:
${stderrStr.slice(-3000)}
    `.trim();

    try {
       const aiResponse = await askAI(
          config,
          'You are an expert QA engineer. Analyze the following test failure output. Identify the primary test file that is failing. Return ONLY the exact file path (relative to project root) of the failing test file. Do not add any extra text. If you cannot find a failing file, return "UNKNOWN".',
          outputToAnalyze
       );

       const failingFile = aiResponse.trim();
       if (failingFile === 'UNKNOWN' || failingFile === '') {
          analyzeSpinner.fail('Could not identify a failing test file from the output.');
          return;
       }

       const fullPath = resolve(process.cwd(), failingFile);
       if (!existsSync(fullPath)) {
          analyzeSpinner.fail(`AI identified ${failingFile} as the failing file, but it does not exist.`);
          return;
       }
       analyzeSpinner.succeed(`Identified failing test file: ${failingFile}`);
       
       const dir = dirname(fullPath);
       const ext = extname(fullPath);
       const name = basename(fullPath, ext).replace(/\.test|\.spec/, '');
       
       const possibleSourceFiles = [
           resolve(dir, `${name}.ts`),
           resolve(dir, `${name}.js`),
           resolve(dir, `${name}.tsx`),
           resolve(dir, `${name}.jsx`),
           resolve(dir, `../${name}.ts`), // one level up might work
           resolve(dir, `../${name}.js`)
       ];
       
       let sourceAbsPath: string | undefined = undefined;
       for (const sf of possibleSourceFiles) {
           if (existsSync(sf)) {
               sourceAbsPath = sf;
               break;
           }
       }

       const { AgenticPlanner } = await import('../core/agentic.js');
       const { generateWorkspaceMap } = await import('../core/scanner.js');
       const startTime = Date.now();
       const workspaceMap = await generateWorkspaceMap();
       const planner = new AgenticPlanner(config, projectInfo, workspaceMap);
       
       logger.info(`Delegating repair of ${failingFile} to AgenticPlanner...`);
       const plannerResult = await planner.fixTestFile(fullPath, sourceAbsPath);
       
       if (plannerResult === 'generated') {
          const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
          logger.success(`✅ Auto-repair flow finished successfully for ${failingFile}.`);
          console.log(chalk.magentaBright(`\n✨ AI successfully fixed the broken tests in ${elapsedSeconds}s! Saved you ~1 hour of debugging.`));
          
          // Dynamically import terminal-link
          const terminalLink = (await import('terminal-link')).default;
          const tweetUrl = `https://twitter.com/intent/tweet?text=I%20just%20used%20%40aitestcli%20to%20autonomously%20fix%20my%20broken%20test%20suite%20in%20${elapsedSeconds}s!%20%F0%9F%A4%AF%0A%0A%23ai%20%23testing%20%23javascript&url=https://www.npmjs.com/package/ai-test-cli`;
          console.log(chalk.cyan('🚀 ' + terminalLink('Share your win on Twitter!', tweetUrl)));
          console.log(chalk.yellow('☕ ' + terminalLink('Buy the creator a coffee!', 'https://buymeacoffee.com/cijaytechnh')) + '\n');
       } else {
         logger.error(`✖ Auto-repair flow failed or aborted for ${failingFile}.`);
         if (options.ci) {
           process.exit(1);
         }
       }
       process.exit(0);

    } catch (error: any) {
       analyzeSpinner.fail(`Repair flow failed: ${error.message}`);
       process.exit(1);
    }
  });
