import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface ProjectInfo {
  language: 'javascript' | 'typescript';
  testRunner: 'jest' | 'vitest' | 'mocha' | 'node' | 'unknown';
  framework: 'react' | 'vue' | 'angular' | 'node' | 'unknown';
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';
}

export function detectProjectInfo(targetDir: string = process.cwd()): ProjectInfo {
  let currentDir = targetDir;
  let packageJsonPath = resolve(currentDir, 'package.json');
  let packageJson: any = {};
  
  while (currentDir !== resolve(currentDir, '..')) {
    if (existsSync(packageJsonPath)) {
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        break;
      } catch (e) {
        // ignore
      }
    }
    currentDir = resolve(currentDir, '..');
    packageJsonPath = resolve(currentDir, 'package.json');
  }

  const tsconfigPath = resolve(targetDir, 'tsconfig.json');

  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {})
  };

  const language = existsSync(tsconfigPath) || allDeps['typescript'] ? 'typescript' : 'javascript';
  
  let testRunner: ProjectInfo['testRunner'] = 'unknown';
  if (allDeps['jest']) testRunner = 'jest';
  else if (allDeps['vitest']) testRunner = 'vitest';
  else if (allDeps['mocha']) testRunner = 'mocha';
  else {
    const scripts = packageJson.scripts || {};
    const hasNodeTest = Object.values(scripts).some((script: any) => typeof script === 'string' && script.includes('node --test'));
    if (hasNodeTest) testRunner = 'node';
  }

  let framework: ProjectInfo['framework'] = 'unknown';
  if (allDeps['react']) framework = 'react';
  else if (allDeps['vue']) framework = 'vue';
  else if (allDeps['@angular/core']) framework = 'angular';
  else if (allDeps['express'] || allDeps['@nestjs/core'] || allDeps['fastify']) framework = 'node';

  let packageManager: ProjectInfo['packageManager'] = 'npm';
  if (existsSync(resolve(targetDir, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (existsSync(resolve(targetDir, 'yarn.lock'))) packageManager = 'yarn';
  else if (existsSync(resolve(targetDir, 'bun.lockb'))) packageManager = 'bun';

  return { language, testRunner, framework, packageManager };
}

export function detectTestDir(targetDir: string = process.cwd()): string | null {
  if (existsSync(resolve(targetDir, 'test'))) return 'test';
  if (existsSync(resolve(targetDir, 'tests'))) return 'tests';
  if (existsSync(resolve(targetDir, '__tests__'))) return '__tests__';
  return null;
}
