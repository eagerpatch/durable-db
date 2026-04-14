/**
 * WebSocket message protocol for action calls.
 *
 * JSON text frames with request-response correlation via `id`.
 */

export interface WsActionRequest {
  id: string;
  action: string;
  args: unknown;
  instanceKey: string;
}

export type WsActionResponse = {
  id: string;
  ok: true;
  result: unknown;
} | {
  id: string;
  ok: false;
  error: string;
}

export function encodeRequest(req: WsActionRequest): string {
  return JSON.stringify(req);
}

export function decodeRequest(data: string): WsActionRequest {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `Invalid WsActionRequest: expected object, got ${parsed === null ? 'null' : typeof parsed}`
    );
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ['id', 'action', 'instanceKey'] as const) {
    if (typeof obj[field] !== 'string') {
      throw new Error(
        `Invalid WsActionRequest: '${field}' must be a string, got ${describeType(obj[field])}`
      );
    }
  }
  return obj as unknown as WsActionRequest;
}

export function encodeResponse(res: WsActionResponse): string {
  return JSON.stringify(res);
}

export function decodeResponse(data: string): WsActionResponse {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `Invalid WsActionResponse: expected object, got ${parsed === null ? 'null' : typeof parsed}`
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string') {
    throw new Error(
      `Invalid WsActionResponse: 'id' must be a string, got ${describeType(obj.id)}`
    );
  }
  if (typeof obj.ok !== 'boolean') {
    throw new Error(
      `Invalid WsActionResponse: 'ok' must be a boolean, got ${describeType(obj.ok)}`
    );
  }
  if (!obj.ok && typeof obj.error !== 'string') {
    throw new Error(
      `Invalid WsActionResponse: 'error' must be a string when ok=false, got ${describeType(obj.error)}`
    );
  }
  return obj as unknown as WsActionResponse;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
