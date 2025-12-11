import { describe, it, expect } from 'vitest';
import { getContext, runWithContext, hasContext } from '../../src/context';

describe('context', () => {
  describe('runWithContext', () => {
    it('makes context available within callback', () => {
      const mockEnv = { MY_BINDING: 'test' };
      const mockRequest = new Request('https://example.com');
      const mockSession = { shop: 'test.myshopify.com' };

      runWithContext(
        { env: mockEnv, request: mockRequest, session: mockSession },
        () => {
          const ctx = getContext();
          expect(ctx.env).toBe(mockEnv);
          expect(ctx.request).toBe(mockRequest);
          expect(ctx.session).toBe(mockSession);
        }
      );
    });

    it('returns the result of the callback', () => {
      const result = runWithContext(
        { env: {}, request: new Request('https://example.com'), session: {} },
        () => 42
      );

      expect(result).toBe(42);
    });

    it('returns promise result from async callback', async () => {
      const result = await runWithContext(
        { env: {}, request: new Request('https://example.com'), session: {} },
        async () => {
          await Promise.resolve();
          return 'async result';
        }
      );

      expect(result).toBe('async result');
    });

    it('propagates errors from callback', () => {
      expect(() =>
        runWithContext(
          { env: {}, request: new Request('https://example.com'), session: {} },
          () => {
            throw new Error('test error');
          }
        )
      ).toThrow('test error');
    });

    it('propagates rejected promises from async callback', async () => {
      await expect(
        runWithContext(
          { env: {}, request: new Request('https://example.com'), session: {} },
          async () => {
            throw new Error('async error');
          }
        )
      ).rejects.toThrow('async error');
    });

    it('allows nested contexts', () => {
      const outerEnv = { outer: true };
      const innerEnv = { inner: true };

      runWithContext(
        { env: outerEnv, request: new Request('https://example.com'), session: {} },
        () => {
          expect(getContext().env).toBe(outerEnv);

          runWithContext(
            { env: innerEnv, request: new Request('https://inner.com'), session: {} },
            () => {
              expect(getContext().env).toBe(innerEnv);
            }
          );

          // After inner context, outer context is restored
          expect(getContext().env).toBe(outerEnv);
        }
      );
    });
  });

  describe('getContext', () => {
    it('throws when called outside of runWithContext', () => {
      expect(() => getContext()).toThrow('getContext() called outside of request context');
    });

    it('returns typed context', () => {
      interface MyEnv {
        DATABASE: string;
      }
      interface MySession {
        userId: string;
      }

      runWithContext<void, MyEnv, MySession>(
        {
          env: { DATABASE: 'db' },
          request: new Request('https://example.com'),
          session: { userId: '123' },
        },
        () => {
          const ctx = getContext<MyEnv, MySession>();
          // TypeScript should know these types
          expect(ctx.env.DATABASE).toBe('db');
          expect(ctx.session.userId).toBe('123');
        }
      );
    });
  });

  describe('hasContext', () => {
    it('returns false outside of runWithContext', () => {
      expect(hasContext()).toBe(false);
    });

    it('returns true inside runWithContext', () => {
      runWithContext(
        { env: {}, request: new Request('https://example.com'), session: {} },
        () => {
          expect(hasContext()).toBe(true);
        }
      );
    });

    it('returns false after runWithContext completes', () => {
      runWithContext(
        { env: {}, request: new Request('https://example.com'), session: {} },
        () => {}
      );

      expect(hasContext()).toBe(false);
    });
  });
});
