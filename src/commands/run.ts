import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { askAI } from '../core/ai.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

import { detectProjectInfo } from '../core/detector.js';

export const runCommand = new Command('run')
  .description('Run tests and analyze with AI (implicitly tracks coverage)')
  .action(async () => {
    const config = await loadConfig();
    if (!config) {
      logger.error('Configuration not found. Run `aitest init` first.');
      return;
    }

    const projectInfo = detectProjectInfo();
    let testCommand = 'npm test -- --coverage';
    if (projectInfo.testRunner === 'mocha' || projectInfo.testRunner === 'unknown') {
      testCommand = 'npm test --coverage';
    }

    const spinner = logger.spinner(`Running tests with coverage (${testCommand})...`).start();
    
    let stdoutStr = '';
    let stderrStr = '';
    let testFailed = false;

    try {
      const { stdout, stderr } = await execAsync(testCommand);
      stdoutStr = stdout;
      stderrStr = stderr;
      spinner.succeed('Tests passed!');
    } catch (error: any) {
      testFailed = true;
      stdoutStr = error.stdout || '';
      stderrStr = error.stderr || error.message;
      spinner.fail('Tests failed.');
    }

    const outputToAnalyze = `
STDOUT:
${stdoutStr.slice(-2000)}

STDERR:
${stderrStr.slice(-2000)}
    `.trim();

    logger.info('Analyzing test results with AI...');
    const analyzeSpinner = logger.spinner('Thinking...').start();
    
    try {
      const prompt = `You are an expert QA and software testing engineer. Analyze the provided test output and code coverage metrics. Keep it concise.
The test suite exited with status: ${testFailed ? 'FAILED' : 'PASSED'}.
If the test run failed due to a missing dependency (like a coverage provider, test runner plugin, or a missing package), provide the exact shell command to install it.

Output EXACTLY and ONLY a JSON object with this structure. Do NOT wrap it in markdown backticks:
{
  "analysis": "Your concise markdown analysis of the test results and coverage...",
  "missingDependencyCommand": "npm install --save-dev ... (only include this field if a dependency is missing)"
}`;

      const rawAnalysis = await askAI(config, prompt, outputToAnalyze);
      analyzeSpinner.succeed('Analysis complete');
      
      let parsedResponse;
      try {
        const jsonMatch = rawAnalysis.match(/\{[\s\S]*\}/);
        parsedResponse = JSON.parse(jsonMatch ? jsonMatch[0] : rawAnalysis);
      } catch(e) {
        // Fallback if AI didn't output JSON
        parsedResponse = { analysis: rawAnalysis };
      }
      
      console.log('\n' + parsedResponse.analysis + '\n');
      
      if (parsedResponse.missingDependencyCommand) {
        const { default: prompts } = await import('prompts');
        const installPrompt = await prompts({
          type: 'confirm',
          name: 'install',
          message: `The AI detected a missing dependency. Would you like to run \`${parsedResponse.missingDependencyCommand}\` now?`,
          initial: true
        });

        if (installPrompt.install) {
          const installSpinner = logger.spinner(`Running ${parsedResponse.missingDependencyCommand}...`).start();
          try {
            await execAsync(parsedResponse.missingDependencyCommand);
            installSpinner.succeed('Dependency installed successfully!');
            logger.info('Run `aitest run` again to see your tests and coverage.');
          } catch (installErr: any) {
            installSpinner.fail('Failed to install dependency.');
            logger.error(installErr.message);
          }
        }
      }
      
    } catch (error: any) {
      analyzeSpinner.fail('AI analysis failed.');
      logger.error(error.message);
    }
  });
