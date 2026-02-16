import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketTransport } from '../../src/transport/websocket';

// Mock WebSocket that simulates the CF Durable Object stub behavior
function createMockWebSocket() {
  const listeners = new Map<string, Function[]>();
  const sent: string[] = [];

  const ws: any = {
    readyState: 1, // OPEN
    accept: vi.fn(),
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    close: vi.fn(),
    addEventListener: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
  };

  return {
    ws,
    sent,
    // Simulate receiving a message from the server
    simulateMessage(data: string) {
      for (const handler of listeners.get('message') ?? []) {
        handler({ data });
      }
    },
    simulateClose() {
      ws.readyState = 3; // CLOSED
      for (const handler of listeners.get('close') ?? []) {
        handler();
      }
    },
    simulateError() {
      for (const handler of listeners.get('error') ?? []) {
        handler(new Error('test error'));
      }
    },
  };
}

function createMockStub(mockWs: ReturnType<typeof createMockWebSocket>) {
  return {
    fetch: vi.fn().mockResolvedValue({
      webSocket: mockWs.ws,
    }),
  };
}

// We need to mock crypto.randomUUID for deterministic test IDs
let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

// WebSocket constant
vi.stubGlobal('WebSocket', { OPEN: 1 });

describe('WebSocketTransport', () => {
  beforeEach(() => {
    uuidCounter = 0;
  });

  it('connects and sends a request', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const callPromise = transport.call('createUser', { name: 'Alice' }, 'tenant-1');

    // Wait for connection to establish
    await vi.waitFor(() => {
      expect(mockWs.ws.accept).toHaveBeenCalled();
    });

    // Check sent message
    expect(mockWs.sent).toHaveLength(1);
    const sentMsg = JSON.parse(mockWs.sent[0]);
    expect(sentMsg).toEqual({
      id: 'test-uuid-1',
      action: 'createUser',
      args: { name: 'Alice' },
      instanceKey: 'tenant-1',
    });

    // Simulate success response
    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-1',
      ok: true,
      result: { userId: '42' },
    }));

    const result = await callPromise;
    expect(result).toEqual({ userId: '42' });
  });

  it('handles error responses', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const callPromise = transport.call('failAction', {}, 'tenant-1');

    await vi.waitFor(() => {
      expect(mockWs.ws.accept).toHaveBeenCalled();
    });

    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-1',
      ok: false,
      error: 'Action failed: some reason',
    }));

    await expect(callPromise).rejects.toThrow('Action failed: some reason');
  });

  it('multiplexes concurrent requests', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const call1 = transport.call('action1', { a: 1 }, 'tenant-1');
    const call2 = transport.call('action2', { b: 2 }, 'tenant-1');

    await vi.waitFor(() => {
      expect(mockWs.sent.length).toBe(2);
    });

    // Respond to second request first (out of order)
    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-2',
      ok: true,
      result: 'result-2',
    }));

    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-1',
      ok: true,
      result: 'result-1',
    }));

    expect(await call1).toBe('result-1');
    expect(await call2).toBe('result-2');
  });

  it('rejects all pending on connection close', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const call1 = transport.call('action1', {}, 'tenant-1');
    const call2 = transport.call('action2', {}, 'tenant-1');

    await vi.waitFor(() => {
      expect(mockWs.sent.length).toBe(2);
    });

    mockWs.simulateClose();

    await expect(call1).rejects.toThrow('WebSocket connection closed');
    await expect(call2).rejects.toThrow('WebSocket connection closed');
  });

  it('rejects all pending on connection error', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const callPromise = transport.call('action1', {}, 'tenant-1');

    await vi.waitFor(() => {
      expect(mockWs.sent.length).toBe(1);
    });

    mockWs.simulateError();

    await expect(callPromise).rejects.toThrow('WebSocket connection closed');
  });

  it('throws if WebSocket upgrade fails', async () => {
    const stub = {
      fetch: vi.fn().mockResolvedValue({
        webSocket: null,
      }),
    };

    const transport = new WebSocketTransport(stub);
    await expect(transport.call('action', {}, 'key')).rejects.toThrow(
      'WebSocket upgrade failed'
    );
  });

  it('ignores malformed messages', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    const callPromise = transport.call('action1', {}, 'tenant-1');

    await vi.waitFor(() => {
      expect(mockWs.sent.length).toBe(1);
    });

    // Send malformed message - should not throw or reject
    mockWs.simulateMessage('not valid json {{{');

    // Send a response for an unknown ID - should be ignored
    mockWs.simulateMessage(JSON.stringify({
      id: 'unknown-id',
      ok: true,
      result: 'orphan',
    }));

    // Now send the real response
    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-1',
      ok: true,
      result: 'correct',
    }));

    expect(await callPromise).toBe('correct');
  });

  it('close() shuts down the connection', async () => {
    const mockWs = createMockWebSocket();
    const stub = createMockStub(mockWs);
    const transport = new WebSocketTransport(stub);

    // Establish connection
    const callPromise = transport.call('action', {}, 'key');
    await vi.waitFor(() => expect(mockWs.ws.accept).toHaveBeenCalled());

    // Respond to pending call first
    mockWs.simulateMessage(JSON.stringify({
      id: 'test-uuid-1',
      ok: true,
      result: 'done',
    }));
    await callPromise;

    transport.close();
    expect(mockWs.ws.close).toHaveBeenCalledWith(1000, 'Client closing');
  });
});
