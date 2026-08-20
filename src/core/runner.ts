import { exec } from 'child_process';
import { promisify } from 'util';
import { ProjectInfo } from './detector.js';

const execAsync = promisify(exec);

export interface TestResult {
  passed: boolean;
  output: string;
}

export async function runSingleTest(testFilePath: string, projectInfo: ProjectInfo): Promise<TestResult> {
  // Default fallback for unknown runners
  let command = `npm test -- "${testFilePath}"`;
  
  if (projectInfo.testRunner === 'jest') {
    command = `npx jest "${testFilePath}" --forceExit --silent`;
  } else if (projectInfo.testRunner === 'vitest') {
    command = `npx vitest run "${testFilePath}"`;
  } else if (projectInfo.testRunner === 'mocha') {
    command = `npx mocha "${testFilePath}" --exit`;
  } else if (projectInfo.testRunner === 'node') {
    command = `node --test "${testFilePath}"`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
    return {
      passed: true,
      output: `${stdout}\n${stderr}`.trim()
    };
  } catch (error: any) {
    return {
      passed: false,
      output: `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`.trim()
    };
  }
}
