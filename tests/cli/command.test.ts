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

describe('options', () => {
  const option = (cmd: Command, name: string, flag: string) =>
    cmd.commands.find((c) => c.name() === name)!.options.some((o) => o.long === flag);

  it('every command that filters by database takes --database', () => {
    const db = createDbCommand();
    for (const name of ALL_SUBCOMMANDS) {
      expect(option(db, name, '--database')).toBe(true);
    }
  });

  it('push and generate take rename answers', () => {
    const db = createDbCommand();
    for (const name of ['push', 'generate']) {
      expect(option(db, name, '--rename')).toBe(true);
      expect(option(db, name, '--no-renames')).toBe(true);
    }
    expect(option(db, 'generate', '--force')).toBe(true);
    expect(option(db, 'reset', '--force')).toBe(true);
  });

  it('collects repeated --rename answers', async () => {
    const db = createDbCommand();
    const generate = db.commands.find((c) => c.name() === 'generate')!;
    let seen: Record<string, unknown> = {};
    generate.action((_name, options) => { seen = options; });
    await db.parseAsync(
      ['generate', 'x', '--rename', 'a.b=c', '--rename', 'd=e', '--no-renames'],
      { from: 'user' }
    );
    expect(seen.rename).toEqual(['a.b=c', 'd=e']);
    expect(seen.renames).toBe(false);
  });
});
