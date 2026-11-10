// What an action is, read from the function an app exports — for a library
// that maps actions to something else (an API's mutations) and needs the
// args schema at runtime. The build compiles an `action()` export to a call
// site and registers it (`registerAction` of ../registry tags that call site);
// untransformed — tests, plain Node — `action()` keeps its config on the
// function it returns. Symbols on globalThis' registry, so whichever copy of
// this package wrote the description, any copy reads it.

import type { Type } from '../type';

/** On a compiled call site: what `registerAction()` was told. */
export const ACTION_INFO = Symbol.for('durable-db.actionInfo');
/** On an untransformed action (see ./defineDatabase). */
const ACTION_TEST_META = Symbol.for('durable-db.actionTestMeta');

export interface ActionInfo {
  database: string;
  name: string;
  args: unknown;
}

export interface ActionDescription {
  /** The database it belongs to, as discovered (`main`); null untransformed. */
  database: string | null;
  /** Its export name; null untransformed. */
  name: string | null;
  /**
   * Its compiled args schema: the `type()` of its `args` — `.toJsonSchema()`,
   * `.expression`, or call it to validate. Undefined only for a call site
   * registered by hand without one.
   */
  args: Type | undefined;
}

/** The description of an action, or undefined for anything that is not one. */
export function describeAction(action: unknown): ActionDescription | undefined {
  if (typeof action !== 'function') return undefined;
  const tagged = action as unknown as Record<symbol, unknown>;
  const info = tagged[ACTION_INFO] as ActionInfo | undefined;
  if (info) return { database: info.database, name: info.name, args: info.args as Type | undefined };
  const meta = tagged[ACTION_TEST_META] as { validator: Type } | undefined;
  if (meta) return { database: null, name: null, args: meta.validator };
  return undefined;
}
