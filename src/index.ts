import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { generateCommand } from './commands/generate.js';
import { explainCommand } from './commands/explain.js';
import { doctorCommand } from './commands/doctor.js';
import { scanCommand } from './commands/scan.js';
import { configCommand } from './commands/config.js';
import { fixCommand } from './commands/fix.js';
import { mockCommand } from './commands/mock.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('aitest')
  .description(packageJson.description)
  .version(packageJson.version);

program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(generateCommand);
program.addCommand(explainCommand);
program.addCommand(doctorCommand);
program.addCommand(scanCommand);
program.addCommand(configCommand);
program.addCommand(fixCommand);
program.addCommand(mockCommand);

program.parse(process.argv);
