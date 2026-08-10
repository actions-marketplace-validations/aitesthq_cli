import { Command } from 'commander';
import prompts from 'prompts';
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { saveConfig } from '../core/config.js';
import { detectProjectInfo } from '../core/detector.js';
import { logger } from '../core/logger.js';
import { installTestRunner } from '../core/setup.js';
import { askAI } from '../core/ai.js';
import { applyConfigFix } from '../core/config-fixer.js';
import fg from 'fast-glob';

export const initCommand = new Command('init')
  .description('Initialize the project')
  .action(async () => {
    logger.info('Initializing AI Test CLI...');
    
    const projectInfo = detectProjectInfo();
    logger.info(`Detected Language: ${projectInfo.language}`);
    logger.info(`Detected Framework: ${projectInfo.framework}`);
    logger.info(`Detected Test Runner: ${projectInfo.testRunner}`);
    logger.info(`Detected Package Manager: ${projectInfo.packageManager}`);

    if (projectInfo.testRunner === 'unknown') {
      const setupRes = await prompts({
        type: 'confirm',
        name: 'installRunner',
        message: 'No test runner detected. Would you like AI Test CLI to automatically install and configure one?',
        initial: true
      });

      if (setupRes.installRunner) {
        await installTestRunner(projectInfo);
      }
    }

    const response = await prompts([
      {
        type: 'select',
        name: 'provider',
        message: 'Select AI Provider',
        choices: [
          { title: 'OpenAI', value: 'openai' },
          { title: 'Anthropic', value: 'anthropic' },
          { title: 'DeepSeek', value: 'deepseek' },
          { title: 'Gemini', value: 'gemini' },
          { title: 'Ollama (Local)', value: 'ollama' },
          { title: 'Custom (OpenAI Compatible)', value: 'custom' },
        ],
        initial: 0
      },
      {
        type: 'text',
        name: 'model',
        message: 'Enter model name',
        initial: (prev: string) => {
          if (prev === 'openai') return 'gpt-4o';
          if (prev === 'anthropic') return 'claude-3-5-sonnet-latest';
          if (prev === 'deepseek') return 'deepseek-coder';
          if (prev === 'gemini') return 'gemini-2.5-flash';
          if (prev === 'ollama') return 'llama3.1';
          if (prev === 'custom') return 'local-model';
          return '';
        }
      },
      {
        type: (prev, values) => values.provider === 'custom' ? 'text' : null,
        name: 'baseURL',
        message: 'Enter API Base URL (e.g., http://localhost:1234/v1)'
      },
      {
        type: (prev, values) => values.provider === 'custom' ? 'text' : null,
        name: 'customHeaders',
        message: 'Enter custom headers as "Key: Value, Key2: Value2" (or leave empty)'
      },
      {
        type: (prev, values) => values.provider === 'ollama' ? null : 'password',
        name: 'apiKey',
        message: 'Enter API Key'
      },
      {
        type: 'text',
        name: 'customInstructions',
        message: 'Enter any custom team guidelines/instructions (comma separated, optional)'
      }
    ]);

    if (!response.provider || !response.model) {
      logger.error('Initialization aborted.');
      return;
    }

    if (response.apiKey) {
      const envKeyMap: Record<string, string> = {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        gemini: 'GEMINI_API_KEY',
        custom: 'CUSTOM_API_KEY'
      };
      const envKey = envKeyMap[response.provider] || 'CUSTOM_API_KEY';
      
      const envPath = resolve(process.cwd(), '.env');
      appendFileSync(envPath, `\n${envKey}=${response.apiKey}\n`, 'utf-8');
      process.env[envKey] = response.apiKey; // Inject into current runtime
      logger.success(`Saved API key to .env securely.`);

      const gitignorePath = resolve(process.cwd(), '.gitignore');
      let gitignoreContent = '';
      if (existsSync(gitignorePath)) {
        gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      }
      if (!gitignoreContent.includes('.env')) {
        appendFileSync(gitignorePath, '\n.env\n', 'utf-8');
        logger.info('Added .env to .gitignore');
      }
    }

    let parsedHeaders: Record<string, string> | undefined = undefined;
    if (response.customHeaders && response.customHeaders.trim() !== '') {
      parsedHeaders = {};
      const parts = response.customHeaders.split(',');
      for (const part of parts) {
        const [key, ...valParts] = part.split(':');
        if (key && valParts.length > 0) {
          const cleanKey = key.trim().replace(/^["']|["']$/g, '');
          const cleanVal = valParts.join(':').trim().replace(/^["']|["']$/g, '');
          parsedHeaders[cleanKey] = cleanVal;
        }
      }
    }

    const config = {
      provider: response.provider,
      model: response.model,
      baseURL: response.baseURL,
      customHeaders: parsedHeaders,
      temperature: 0.1,
      autoFix: true,
      maxRetries: -1, // Infinite by default
      maxSteps: 50,
      maxExplorationSteps: 5,
      customInstructions: response.customInstructions 
        ? response.customInstructions.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
        : []
    };

    await saveConfig(config);
    logger.success('Basic initialization complete.');

    const setupVerify = await prompts({
      type: 'confirm',
      name: 'verify',
      message: 'Would you like the AI to verify and configure your testing environment right now? (Recommended)',
      initial: true
    });

    if (setupVerify.verify) {
      const spinner = logger.spinner('Analyzing project setup...').start();
      try {
        const pkgPath = resolve(process.cwd(), 'package.json');
        let pkgContent = '{}';
        if (existsSync(pkgPath)) {
          pkgContent = readFileSync(pkgPath, 'utf-8');
        }
        
        const existingConfigs = await fg(['jest.config.*', 'vite.config.*', '.babelrc*', 'tsconfig.*', 'vitest.config.*'], { cwd: process.cwd(), deep: 1 });
        const setupContext = `Language: ${projectInfo.language}\nFramework: ${projectInfo.framework}\nTest Runner: ${projectInfo.testRunner}\nExisting Config Files: ${existingConfigs.join(', ') || 'None'}\nPackage.json:\n${pkgContent}`;
        
        const responseCode = await askAI(
          config,
          'You are a testing architecture expert. Analyze this project setup. If the test environment is perfect and ready to run tests, reply exactly with "READY". If it is missing dependencies (e.g., Jest, Vitest, Testing Library, jsdom) or needs config files (e.g., .babelrc, jest.config.js) to support the detected framework, reply ONLY with a JSON block wrapped in ```json starting with {"type": "CONFIG_FIX", "dependencies": ["pkg"], "files": [{"path": ".babelrc", "content": "..."}], "reason": "..."}. CRITICAL: You must escape all newlines within the JSON "content" strings as \\n. DO NOT create duplicate configuration files for the same tool (e.g., if jest.config.js exists, do not create jest.config.ts). If an existing file needs updating, provide the file path of the existing file. Do not output raw unescaped newlines inside the JSON string. Do not output anything else.',
          setupContext
        );

        const configFixMatch = responseCode.match(/```json\s*(\{[\s\S]*?"type":\s*"CONFIG_FIX"[\s\S]*?\})\s*```/);
        if (configFixMatch && configFixMatch[1]) {
          const configFix = JSON.parse(configFixMatch[1]);
          await applyConfigFix(configFix, projectInfo, spinner);
          spinner.succeed('Test environment successfully scaffolded!');
        } else {
          spinner.succeed('Test environment looks perfectly configured!');
        }
      } catch (e: any) {
        spinner.fail(`Setup verification failed: ${e.message}`);
      }
    }

    logger.success('You can now use `aitest run` or `aitest generate`.');
  });
