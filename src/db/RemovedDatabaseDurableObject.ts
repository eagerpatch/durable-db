import { DurableObject } from 'cloudflare:workers';

/** The wrangler migration entry that deletes a class — and all its data. */
export interface DeleteClassMigration {
  tag: string;
  deleted_classes: string[];
}

/** What a call to a removed database's Durable Object answers. */
export function removedDatabaseMessage(className: string, deleteMigration: DeleteClassMigration): string {
  return (
    `${className} is the Durable Object of a removed database: no database defines it any more, but ` +
    `the wrangler migrations still declare it, so durable-db exports it as a tombstone that keeps its ` +
    `data untouched and answers no calls. Re-adding the database brings the data back. To delete the ` +
    `class — and ALL its data — for good, add this migration to wrangler.jsonc: ` +
    JSON.stringify(deleteMigration)
  );
}

/** The error every RPC call to a removed database's Durable Object rejects with. */
export class RemovedDatabaseError extends Error {
  constructor(
    readonly className: string,
    readonly deleteMigration: DeleteClassMigration
  ) {
    super(removedDatabaseMessage(className, deleteMigration));
    this.name = 'RemovedDatabaseError';
  }
}

/**
 * A tombstone for the class of a removed database. The worker must keep
 * exporting every class its wrangler migrations declare (@cloudflare/vite-plugin
 * wraps each one, and a deploy that drops a class with data fails), but only
 * a `deleted_classes` migration drops one — and with it all its data, which
 * durable-db never decides for the user. So the generated module exports this
 * subclass under the old name until the database comes back or the user
 * deletes the class: it never touches the storage, `fetch` answers 410 Gone
 * and the RPC entry points of durable-db's stubs (`rpc`, `sys`) reject with a
 * {@link RemovedDatabaseError} naming the migration that deletes it.
 */
export abstract class RemovedDatabaseDurableObject<Env = unknown> extends DurableObject<Env> {
  /** The removed database's class name. */
  abstract readonly removedClassName: string;
  /** The `deleted_classes` migration that deletes the class for good. */
  abstract readonly deleteMigration: DeleteClassMigration;

  fetch(_request?: Request): Response {
    return new Response(removedDatabaseMessage(this.removedClassName, this.deleteMigration), {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  async rpc(..._args: unknown[]): Promise<never> {
    throw new RemovedDatabaseError(this.removedClassName, this.deleteMigration);
  }

  async sys(..._args: unknown[]): Promise<never> {
    throw new RemovedDatabaseError(this.removedClassName, this.deleteMigration);
  }
}
