#!/usr/bin/env node
import { Command } from 'commander';
import { registerDbCommands } from './index';

const program = new Command();

program
  .name('db')
  .description('Database migration management')
  .version('0.0.1');

// Flat registration: the standalone binary exposes `db push`, not `db db push`
registerDbCommands(program);

program.parse();
