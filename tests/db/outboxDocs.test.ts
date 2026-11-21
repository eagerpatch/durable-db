import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// What the outbox's docs say of its delivery, held to what tests/db/outboxDelivery.test.ts shows. Each check names
// the test there that shows it. The changeset is checked while it is there (`changeset version` consumes it).

const root = path.resolve(__dirname, '../..');

/** A Markdown file's text with its whitespace collapsed. */
function markdown(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf-8').replace(/\s+/g, ' ');
}

/** A source file's comments as text: comment markers dropped, whitespace collapsed. */
function comments(file: string): string {
  return fs
    .readFileSync(path.join(root, file), 'utf-8')
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*|\/\/)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

const CHANGESET = '.changeset/outbox-envelope-database.md';
const userDocs = ['README.md', ...(fs.existsSync(path.join(root, CHANGESET)) ? [CHANGESET] : [])];

describe("the outbox's docs", () => {
  // 'the documented limits' → '2. a message that fails alone before anything was delivered takes the sink for down: …'
  it('say that limit 2 adds another 5 s for each later alarm whose read begins with a refused message the alarm before it had no call left to hand alone', () => {
    for (const file of [...userDocs, 'CLAUDE.md']) {
      expect({ file, says: markdown(file).includes('another 5 s for each later alarm whose read begins with a refused message the alarm before it had no call left to hand alone') }).toEqual({ file, says: true });
    }
  });

  // 'I3 — cost' → 'a try writes at most two __outbox rows plus the sink row, and moves to __outbox_dead what the sink answers in { dead }'
  it('say that a try moves to __outbox_dead what the sink answers in { dead }, besides the two outbox rows and the sink row it writes', () => {
    for (const file of userDocs) {
      const text = markdown(file);
      expect({ file, says: text.includes('writes at most two outbox rows and the') && text.includes('however much waits, and moves to `__outbox_dead` what the sink answers in `{ dead }`') }).toEqual({ file, says: true });
      expect({ file, says: text.includes('one it neither takes nor answers in `{ dead }` goes behind every message recorded or tried before it') }).toEqual({ file, says: true });
      expect({ file, says: /one (the sink|it) does not take goes behind/.test(text) }).toEqual({ file, says: false });
    }
    const claude = markdown('CLAUDE.md');
    expect(claude).toContain('a row the sink neither delivered nor answered in `{ dead }` gets `tried_at = now` and `last_error`, nothing else');
    expect(claude).not.toContain('a row not taken gets');
    const alarm = comments('src/db/SqliteDurableObject.ts');
    expect(alarm).toContain('A message a try handed that the sink neither delivered nor answered in `{ dead }` gets `tried_at` and its `last_error`, nothing else');
    expect(alarm).not.toContain('A message a try handed and the sink did not take gets');
  });

  // 'I3 — cost' → "the sink's down_rounds is 1 when an alarm takes it for down, and one more for each try that finds it down: …"
  it('say that down_rounds is 1 when an alarm takes the sink for down, and one more for each try that finds it down', () => {
    expect(comments('src/db/outbox.ts')).toContain(
      '`down_rounds`: how many rounds in a row the sink has been taken for down (1 when an alarm takes it down, one more for each try that finds it down)',
    );
    const object = comments('src/db/SqliteDurableObject.ts');
    expect(object).toContain('for its `rounds`-th round in a row (1 when an alarm takes it down, one more for each try that finds it down)');
    expect(object).not.toContain('`rounds` tries in a row having found it down');
  });

  // 'I3 — cost' → 'an outage that begins part-way through an alarm costs the rest of it (at most 16 calls in all) …'
  it('say that an outage costs at most 16 calls in all of the alarm it began in', () => {
    for (const file of userDocs) expect({ file, says: markdown(file).includes('An outage costs the rest of the alarm it began in (at most 16 calls in all)') }).toEqual({ file, says: true });
  });
});
