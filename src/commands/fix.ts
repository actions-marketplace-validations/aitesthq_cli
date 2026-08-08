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
  .option('--max-loops <number>', 'Maximum number of self-healing loops to run', '5')
  .option('-p, --preview', 'Preview mode: generate .bak files instead of permanently replacing code')
  .action(async (options) => {
    const config = await loadConfig();
    if (!config) {
      logger.error('Configuration not found. Run `aitest init` first.');
      return;
    }
    
    const maxLoops = parseInt(options.maxLoops, 10) || 5;
    let loopCount = 0;
    
    const projectInfo = detectProjectInfo();
    let testCommand = 'npm test';
    if (projectInfo.testRunner === 'vitest') {
        testCommand = 'npx vitest run';
    } else if (projectInfo.testRunner === 'jest') {
        testCommand = 'npx jest --silent';
    } else if (projectInfo.testRunner === 'mocha') {
        testCommand = 'npx mocha';
    }

    logger.info(`Starting Suite-Level Self-Healing Loop (Will fix up to ${maxLoops} failing files)...\n`);

    while (loopCount < maxLoops) {
        loopCount++;
        const spinner = logger.spinner(`[Suite Evaluation ${loopCount}/${maxLoops}] Running tests to find failures (${testCommand})...`).start();
        
        let stdoutStr = '';
        let stderrStr = '';
        let testFailed = false;

        try {
          const { stdout, stderr } = await execAsync(testCommand);
          stdoutStr = stdout;
          stderrStr = stderr;
          spinner.succeed(chalk.green(`[Suite Evaluation ${loopCount}/${maxLoops}] Tests passed! The entire test suite is green.`));
          process.exit(0); // Entire suite passed, exit immediately
        } catch (error: any) {
          testFailed = true;
          stdoutStr = error.stdout || '';
          stderrStr = error.stderr || error.message;
          spinner.warn(`[Suite Evaluation ${loopCount}/${maxLoops}] Tests failed. Starting AI repair flow...`);
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
              if (options.ci) process.exit(1);
              break;
           }

           const fullPath = resolve(process.cwd(), failingFile);
           if (!existsSync(fullPath)) {
              analyzeSpinner.fail(`AI identified ${failingFile} as the failing file, but it does not exist.`);
              if (options.ci) process.exit(1);
              break;
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
           const plannerResult = await planner.fixTestFile(fullPath, sourceAbsPath, { preview: options.preview });
           
           if (plannerResult === 'generated') {
              const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
              logger.success(`✅ Auto-repair flow finished successfully for ${failingFile} in ${elapsedSeconds}s.`);
              console.log(chalk.cyan(`\nRe-evaluating test suite in the next loop...\n`));
           } else {
             logger.error(`✖ Auto-repair flow failed or aborted for ${failingFile}.`);
             if (options.ci) process.exit(1);
             break;
           }
        } catch (error: any) {
           analyzeSpinner.fail(`Repair flow failed: ${error.message}`);
           if (options.ci) process.exit(1);
           break;
        }
    }

    if (loopCount >= maxLoops) {
        logger.error(`\n✖ Reached maximum self-healing loops (${maxLoops}). Exiting to prevent infinite billing cycle.`);
        if (options.ci) process.exit(1);
    }
  });
