import { encodeRequest, decodeResponse, type WsActionResponse } from './protocol';

/**
 * Client-side WebSocket transport for calling DO actions over WebSocket.
 *
 * Manages a single WebSocket connection to a Durable Object stub,
 * with request-response correlation via message IDs.
 */
export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private connectPromise: Promise<void> | null = null;

  constructor(private stub: { fetch: (input: RequestInfo) => Promise<Response> }) {}

  async call(action: string, args: unknown, instanceKey: string): Promise<unknown> {
    await this.ensureConnected();

    const id = crypto.randomUUID();
    const message = encodeRequest({ id, action, args, instanceKey });

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(message);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    // Deduplicate concurrent connection attempts
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    const response = await this.stub.fetch(
      new Request('https://do/ws', {
        headers: { Upgrade: 'websocket' },
      })
    );

    const ws = response.webSocket;
    if (!ws) {
      throw new Error('WebSocket upgrade failed: no webSocket on response');
    }

    ws.accept();
    this.ws = ws;

    ws.addEventListener('message', (event: MessageEvent) => {
      this.onMessage(event);
    });

    ws.addEventListener('close', () => {
      this.onClose();
    });

    ws.addEventListener('error', () => {
      this.onClose();
    });
  }

  private onMessage(event: MessageEvent): void {
    let response: WsActionResponse;
    try {
      response = decodeResponse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return; // Ignore malformed messages
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  private onClose(): void {
    this.ws = null;
    // Reject all pending requests
    for (const [id, { reject }] of this.pending) {
      reject(new Error('WebSocket connection closed'));
    }
    this.pending.clear();
  }

  close(): void {
    if (this.ws) {
      this.ws.close(1000, 'Client closing');
      this.ws = null;
    }
  }
}
