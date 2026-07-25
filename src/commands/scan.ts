import { Command } from 'commander';
import { logger } from '../core/logger.js';
import { detectProjectInfo } from '../core/detector.js';
import fg from 'fast-glob';

export const scanCommand = new Command('scan')
  .description('Analyze the repository for testing health')
  .action(async () => {
    logger.info('Scanning repository...\n');

    const spinner = logger.spinner('Analyzing files and configuration...').start();

    // 1. Detect Framework & Architecture
    const projectInfo = detectProjectInfo();
    
    // 2. Scan files
    try {
      const sourceFiles = await fg(['**/*.{js,ts,jsx,tsx}'], {
        ignore: [
          '**/node_modules/**', 
          '**/dist/**', 
          '**/build/**', 
          '**/coverage/**', 
          '**/__mocks__/**',
          '**/*.test.*', 
          '**/*.spec.*', 
          '**/*.config.*',
          '**/setupTests.*',
          '**/jest.setup.*',
          '**/.*'
        ],
        cwd: process.cwd()
      });

      const testFiles = await fg(['**/*.test.{js,ts,jsx,tsx}', '**/*.spec.{js,ts,jsx,tsx}'], {
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**'],
        cwd: process.cwd()
      });

      // 3. Estimate Coverage and Missing Tests
      // A simple heuristic: how many source files have a matching test file?
      const sourceBases = sourceFiles.map(f => {
        const parts = f.split('/');
        const name = parts[parts.length - 1];
        return name.replace(/\.(js|ts|jsx|tsx)$/, '');
      });

      const testBases = testFiles.map(f => {
        const parts = f.split('/');
        const name = parts[parts.length - 1];
        return name.replace(/\.(test|spec)\.(js|ts|jsx|tsx)$/, '');
      });

      let coveredFiles = 0;
      const missingTestsFiles: string[] = [];

      for (let i = 0; i < sourceFiles.length; i++) {
        const base = sourceBases[i];
        if (testBases.includes(base)) {
          coveredFiles++;
        } else {
          missingTestsFiles.push(sourceFiles[i]);
        }
      }

      const coverageEstimate = sourceFiles.length > 0 
        ? Math.round((coveredFiles / sourceFiles.length) * 100) 
        : 100;

      // 4. Calculate Risk Score
      let riskScore = 'Low';
      let riskColor = '\x1b[32m'; // Green
      if (coverageEstimate < 40) {
        riskScore = 'High';
        riskColor = '\x1b[31m'; // Red
      } else if (coverageEstimate < 70) {
        riskScore = 'Medium';
        riskColor = '\x1b[33m'; // Yellow
      }
      const resetColor = '\x1b[0m';

      spinner.succeed('Analysis complete\n');

      console.log('📊 Repository Scan Report\n');
      
      console.log('--- Architecture ---');
      console.log(`Language:        ${projectInfo.language}`);
      console.log(`Framework:       ${projectInfo.framework}`);
      console.log(`Test Runner:     ${projectInfo.testRunner}`);
      console.log(`Package Manager: ${projectInfo.packageManager}\n`);

      console.log('--- Metrics ---');
      console.log(`Total Source Files: ${sourceFiles.length}`);
      console.log(`Total Test Files:   ${testFiles.length}`);
      console.log(`Coverage Estimate:  ${coverageEstimate}% (based on file pairing)`);
      console.log(`Risk Score:         ${riskColor}${riskScore}${resetColor}\n`);

      console.log('--- Missing Tests (Top 10) ---');
      if (missingTestsFiles.length === 0) {
        console.log('All source files appear to have matching test files! 🎉');
      } else {
        const displayLimit = Math.min(10, missingTestsFiles.length);
        for (let i = 0; i < displayLimit; i++) {
          console.log(`- ${missingTestsFiles[i]}`);
        }
        if (missingTestsFiles.length > 10) {
          console.log(`... and ${missingTestsFiles.length - 10} more.`);
        }
        console.log('\nRun `aitest generate --all` to automatically generate missing tests.');
      }

    } catch (error: any) {
      spinner.fail(`Scan failed: ${error.message}`);
    }
  });
