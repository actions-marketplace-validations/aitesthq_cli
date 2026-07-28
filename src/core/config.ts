import { cosmiconfig } from 'cosmiconfig';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { logger } from './logger.js';

export interface AITestConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  customHeaders?: Record<string, string>;
  temperature?: number;
  autoFix?: boolean;
  maxRetries?: number;
  maxSteps?: number;
  maxExplorationSteps?: number;
}

const moduleName = 'aitest';
const explorer = cosmiconfig(moduleName);

export async function loadConfig(): Promise<AITestConfig | null> {
  try {
    const result = await explorer.search();
    if (result) {
      return result.config as AITestConfig;
    }
    return null;
  } catch (error) {
    logger.error(`Failed to load config: ${error}`);
    return null;
  }
}

export async function saveConfig(config: AITestConfig, targetDir: string = process.cwd()): Promise<void> {
  const configPath = resolve(targetDir, '.aitestrc.json');
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.success(`Saved config to ${configPath}`);
  } catch (error) {
    logger.error(`Failed to save config: ${error}`);
    throw error;
  }
}
