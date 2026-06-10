import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createDbCommand, registerDbCommands } from '../../src/cli/command';

const ALL_SUBCOMMANDS = ['generate', 'push', 'reset', 'status', 'validate'];

function subcommandNames(cmd: Command): string[] {
  return cmd.commands.map((c) => c.name()).sort();
}

describe('registerDbCommands', () => {
  it('registers all subcommands flat on the given program', () => {
    const program = new Command('mycli');
    registerDbCommands(program);

    // `mycli push`, not `mycli db push`
    expect(subcommandNames(program)).toEqual(ALL_SUBCOMMANDS);
  });

  it('returns the same command it was given (chainable)', () => {
    const program = new Command('mycli');
    expect(registerDbCommands(program)).toBe(program);
  });
});

describe('createDbCommand', () => {
  it('creates a reusable `db` group with all subcommands', () => {
    const db = createDbCommand();

    expect(db.name()).toBe('db');
    expect(subcommandNames(db)).toEqual(ALL_SUBCOMMANDS);
  });

  it('mounts under a host CLI as a nested group', () => {
    const host = new Command('shoplayer');
    host.addCommand(createDbCommand());

    // `shoplayer db push`
    const dbGroup = host.commands.find((c) => c.name() === 'db');
    expect(dbGroup).toBeDefined();
    expect(subcommandNames(dbGroup!)).toEqual(ALL_SUBCOMMANDS);
  });
});
