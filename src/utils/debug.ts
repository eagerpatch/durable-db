import createDebug from 'debug';

export const debugVite = createDebug('database:vite');
export const debugCli = createDebug('database:cli');
export const debugMigrations = createDebug('database:migrations');
