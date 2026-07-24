import { Command } from 'commander';
import { resolve } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../core/config.js';
import { detectProjectInfo } from '../core/detector.js';
import { logger } from '../core/logger.js';
import { generateWorkspaceMap } from '../core/scanner.js';
import { readFileSync } from 'fs';

export const mockCommand = new Command('mock')
  .description('Generate global __mocks__ for external dependencies or internal files')
  .option('-f, --file <path>', 'Generate a mock for a specific internal file')
  .option('-d, --dependencies', 'Generate mocks for all third-party dependencies in package.json')
  .option('-a, --all', 'Scan the workspace and generate mocks for everything')
  .option('-u, --force-update', 'Overwrite existing mock files if they already exist')
  .action(async (options) => {
    const config = await loadConfig();
    if (!config) {
      logger.error('Configuration not found. Run `aitest init` first.');
      return;
    }

    if (!options.file && !options.dependencies && !options.all) {
      logger.error('Please specify --file <path>, --dependencies, or --all');
      return;
    }

    const projectInfo = detectProjectInfo();
    const workspaceMap = await generateWorkspaceMap();
    
    // We will dynamically import AgenticPlanner so that we don't load the massive AI SDK unless needed
    const { AgenticPlanner } = await import('../core/agentic.js');
    const planner = new AgenticPlanner(config, projectInfo, workspaceMap);

    const startTime = Date.now();
    let successCount = 0;

    if (options.file) {
      logger.info(`Starting mock generation for internal file: ${options.file}...`);
      const fullPath = resolve(process.cwd(), options.file);
      const result = await planner.generateMock(fullPath, 'internal', options.forceUpdate);
      if (result === 'generated') successCount++;
    } 
    else if (options.dependencies) {
      logger.info('Analyzing package.json to generate mocks for dependencies...');
      try {
        const pkgJsonPath = resolve(process.cwd(), 'package.json');
        const pkgData = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const deps = Object.keys(pkgData.dependencies || {});
        
        if (deps.length === 0) {
          logger.info('No dependencies found in package.json.');
          process.exit(0);
        }

        logger.info(`Found ${deps.length} dependencies. Generating global mocks...`);
        for (const dep of deps) {
          logger.info(`Mocking ${dep}...`);
          const result = await planner.generateMock(dep, 'external', options.forceUpdate);
          if (result === 'generated') successCount++;
        }
      } catch (err: any) {
        logger.error(`Failed to read package.json: ${err.message}`);
        process.exit(1);
      }
    } 
    else if (options.all) {
      logger.error('--all is not implemented yet. Please use --dependencies or --file.');
      process.exit(1);
    }

    if (successCount > 0) {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      logger.success(`\nFinished! Successfully generated ${successCount} mock(s).`);
      console.log(chalk.magentaBright(`\n✨ AI successfully generated global mocks in ${elapsedSeconds}s! Saved you hours of manual mocking.`));
      
      const tweetUrl = `https://twitter.com/intent/tweet?text=I%20just%20used%20%40aitestcli%20to%20autonomously%20generate%20${successCount}%20global%20mocks%20in%20${elapsedSeconds}s!%20%F0%9F%A4%AF%0A%0A%23ai%20%23testing%20%23javascript&url=https://www.npmjs.com/package/ai-test-cli`;
      console.log(chalk.cyan(`🚀 Share your win on Twitter! \n   ↳ ${tweetUrl}`));
      console.log(chalk.yellow(`☕ Buy the creator a coffee! \n   ↳ https://buymeacoffee.com/cijaytechnh`) + '\n');
    } else {
      logger.error('\nFailed to generate any mocks.');
    }
    process.exit(0);
  });
