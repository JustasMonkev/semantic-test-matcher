import { Command } from 'commander';
import { registerBenchmarkCommand } from './benchmark.ts';
import { registerEmbedCommand } from './embed.ts';
import { registerMatchCommand } from './match.ts';
import { registerStatusCommand } from './status.ts';
import { registerCompletionCommand } from './completion.ts';

export function registerCommands(program: Command): void {
  registerBenchmarkCommand(program);
  registerEmbedCommand(program);
  registerMatchCommand(program);
  registerStatusCommand(program);
  registerCompletionCommand(program);
}
