import { resolve, relative, dirname, basename, extname } from 'path';
import { mkdirSync } from 'fs';
import { detectTestDir, ProjectInfo } from './detector.js';
import { AITestConfig } from './config.js';
import { askAI } from './ai.js';
import { logger } from './logger.js';
import chalk from 'chalk';

export async function resolveTestFilePath(
    sourceFilePath: string,
    projectInfo: ProjectInfo,
    config: AITestConfig,
    workspaceMap: string = ''
): Promise<string> {
    const ext = extname(sourceFilePath);
    const base = basename(sourceFilePath, ext);
    let dir = dirname(sourceFilePath);
    const suffix = (projectInfo.framework === 'angular' || projectInfo.testRunner === 'vitest') ? '.spec' : '.test';
    
    // Tier 1: Agentic Routing via customInstructions
    if (config.customInstructions && config.customInstructions.length > 0) {
        const instructionStr = config.customInstructions.join(' ').toLowerCase();
        if (instructionStr.includes('save') || instructionStr.includes('path') || instructionStr.includes('directory') || instructionStr.includes('folder') || instructionStr.includes('location')) {
            try {
                const prompt = `You are a test routing agent.
Based on the following custom instructions, determine the exact absolute file path where the test file for "${sourceFilePath}" should be saved.
--- CUSTOM INSTRUCTIONS ---
${config.customInstructions.join('\n')}
--- WORKSPACE MAP ---
${workspaceMap || '(Not provided)'}

Output ONLY the absolute file path string. Do not wrap it in quotes, code blocks, or add any explanation.`;
                const aiResponse = await askAI(config, 'Determine test file path based on custom instructions.', prompt);
                const pathStr = aiResponse.trim().replace(/^['"`]+|['"`]+$/g, '').split('\n')[0].trim();
                
                if (pathStr && pathStr.includes('/')) {
                    logger.info(chalk.magenta(`🧠 Agentic Router determined test path: ${pathStr}`));
                    mkdirSync(dirname(pathStr), { recursive: true });
                    return pathStr;
                }
            } catch (error) {
                logger.warn('Agentic Router failed, falling back to heuristic routing.');
            }
        }
    }

    // Tier 2: Intelligent Heuristic Routing
    const testDir = detectTestDir();
    let targetDir = dir;
    if (testDir) {
        const rel = relative(process.cwd(), dir);
        if (rel.startsWith('src/') || rel === 'src') {
            targetDir = resolve(process.cwd(), rel.replace(/^src/, testDir));
        } else if (rel.startsWith('lib/') || rel === 'lib') {
            targetDir = resolve(process.cwd(), rel.replace(/^lib/, testDir));
        } else if (!rel.startsWith(testDir)) {
            targetDir = resolve(process.cwd(), testDir, rel);
        }
        mkdirSync(targetDir, { recursive: true });
    }

    return resolve(targetDir, `${base}${suffix}${ext}`);
}
