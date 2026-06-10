import { encodeRequest, decodeResponse, type WsActionResponse } from './protocol';

/** Default timeout (ms) after which a pending WebSocket request rejects. */
export const DEFAULT_WS_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface WebSocketTransportOptions {
  /** Per-request timeout in ms. Set to 0 or Infinity to disable. */
  requestTimeoutMs?: number;
}

/**
 * Client-side WebSocket transport for calling DO actions over WebSocket.
 *
 * Manages a single WebSocket connection to a Durable Object stub,
 * with request-response correlation via message IDs.
 */
export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private readonly requestTimeoutMs: number;

  constructor(
    private stub: { fetch: (input: RequestInfo) => Promise<Response> },
    options: WebSocketTransportOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WS_REQUEST_TIMEOUT_MS;
  }

  async call(action: string, args: unknown, instanceKey: string): Promise<unknown> {
    await this.ensureConnected();

    const id = crypto.randomUUID();
    const message = encodeRequest({ id, action, args, instanceKey });

    return new Promise<unknown>((resolve, reject) => {
      const timer = this.requestTimeoutMs > 0 && Number.isFinite(this.requestTimeoutMs)
        ? setTimeout(() => {
            const entry = this.pending.get(id);
            if (!entry) return;
            this.pending.delete(id);
            entry.reject(
              new Error(
                `[db] WebSocket request '${action}' timed out after ${this.requestTimeoutMs}ms`
              )
            );
          }, this.requestTimeoutMs)
        : null;

      this.pending.set(id, { resolve, reject, timer });
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
    const raw = typeof event.data === 'string' ? event.data : String(event.data);
    let response: WsActionResponse;
    try {
      response = decodeResponse(raw);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        `[db] WebSocket received malformed message (ignored): ${message}. ` +
        `First 120 chars: ${raw.slice(0, 120)}`
      );
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  private onClose(): void {
    this.ws = null;
    // Reject all pending requests
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error('WebSocket connection closed'));
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
