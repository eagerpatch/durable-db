#!/usr/bin/env node
import { Command } from 'commander';
import { createDbCommand } from './index';

const program = new Command();

program
  .name('db')
  .version('0.0.1')
  .addCommand(createDbCommand());

program.parse();