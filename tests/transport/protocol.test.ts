import { describe, it, expect } from 'vitest';
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  type WsActionRequest,
  type WsActionResponse,
} from '../../src/transport/protocol';

describe('protocol', () => {
  describe('encodeRequest / decodeRequest', () => {
    it('round-trips a valid request', () => {
      const req: WsActionRequest = {
        id: 'abc-123',
        action: 'createUser',
        args: { name: 'Alice', email: 'alice@example.com' },
        instanceKey: 'tenant-1',
      };

      const encoded = encodeRequest(req);
      const decoded = decodeRequest(encoded);

      expect(decoded).toEqual(req);
    });

    it('round-trips request with null args', () => {
      const req: WsActionRequest = {
        id: 'id-1',
        action: 'ping',
        args: null,
        instanceKey: 'global',
      };

      const decoded = decodeRequest(encodeRequest(req));
      expect(decoded).toEqual(req);
    });

    it('round-trips request with complex args', () => {
      const req: WsActionRequest = {
        id: 'id-2',
        action: 'bulkInsert',
        args: { items: [1, 2, 3], nested: { deep: true } },
        instanceKey: 'shop-42',
      };

      const decoded = decodeRequest(encodeRequest(req));
      expect(decoded).toEqual(req);
    });

    it('throws on invalid JSON', () => {
      expect(() => decodeRequest('not json')).toThrow();
    });

    it('throws on missing id', () => {
      expect(() =>
        decodeRequest(JSON.stringify({ action: 'foo', args: {}, instanceKey: 'k' }))
      ).toThrow('Invalid WsActionRequest');
    });

    it('throws on missing action', () => {
      expect(() =>
        decodeRequest(JSON.stringify({ id: '1', args: {}, instanceKey: 'k' }))
      ).toThrow('Invalid WsActionRequest');
    });

    it('throws on missing instanceKey', () => {
      expect(() =>
        decodeRequest(JSON.stringify({ id: '1', action: 'foo', args: {} }))
      ).toThrow('Invalid WsActionRequest');
    });

    it('throws on null payload', () => {
      expect(() => decodeRequest('null')).toThrow('Invalid WsActionRequest');
    });
  });

  describe('encodeResponse / decodeResponse', () => {
    it('round-trips a success response', () => {
      const res: WsActionResponse = {
        id: 'abc-123',
        ok: true,
        result: { userId: '42', name: 'Alice' },
      };

      const encoded = encodeResponse(res);
      const decoded = decodeResponse(encoded);

      expect(decoded).toEqual(res);
    });

    it('round-trips an error response', () => {
      const res: WsActionResponse = {
        id: 'abc-456',
        ok: false,
        error: 'Something went wrong',
      };

      const encoded = encodeResponse(res);
      const decoded = decodeResponse(encoded);

      expect(decoded).toEqual(res);
    });

    it('round-trips success with null result', () => {
      const res: WsActionResponse = { id: 'id-1', ok: true, result: null };
      const decoded = decodeResponse(encodeResponse(res));
      expect(decoded).toEqual(res);
    });

    it('round-trips success with array result', () => {
      const res: WsActionResponse = { id: 'id-2', ok: true, result: [1, 2, 3] };
      const decoded = decodeResponse(encodeResponse(res));
      expect(decoded).toEqual(res);
    });

    it('throws on invalid JSON', () => {
      expect(() => decodeResponse('not json')).toThrow();
    });

    it('throws on missing id', () => {
      expect(() =>
        decodeResponse(JSON.stringify({ ok: true, result: 1 }))
      ).toThrow('Invalid WsActionResponse');
    });

    it('throws on missing ok', () => {
      expect(() =>
        decodeResponse(JSON.stringify({ id: '1', result: 1 }))
      ).toThrow('Invalid WsActionResponse');
    });

    it('throws on error response missing error string', () => {
      expect(() =>
        decodeResponse(JSON.stringify({ id: '1', ok: false }))
      ).toThrow('Invalid WsActionResponse: missing error string');
    });

    it('throws on null payload', () => {
      expect(() => decodeResponse('null')).toThrow('Invalid WsActionResponse');
    });
  });
});
