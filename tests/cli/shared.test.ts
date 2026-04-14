import { describe, it, expect, vi, afterEach } from 'vitest';
import { reportCliError } from '../../src/cli/shared';

describe('reportCliError', () => {
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    process.env.DEBUG = originalDebug;
    vi.restoreAllMocks();
  });

  it('prints only the message by default', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    reportCliError(new Error('boom'));

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('Error:', 'boom');
  });

  it('prints the stack when verbose is true', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    const error = new Error('boom');
    reportCliError(error, true);

    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls[0]).toEqual(['Error:', 'boom']);
    expect(errSpy.mock.calls[1][0]).toContain('boom');
    expect(errSpy.mock.calls[1][0]).toContain('at '); // stack frame marker
  });

  it('prints the stack when DEBUG env var is set', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEBUG = '*';

    reportCliError(new Error('boom'));

    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error values', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;

    reportCliError('a string');
    reportCliError({ some: 'object' });

    expect(errSpy).toHaveBeenNthCalledWith(1, 'Error:', 'a string');
    expect(errSpy).toHaveBeenNthCalledWith(2, 'Error:', { some: 'object' });
  });
});
