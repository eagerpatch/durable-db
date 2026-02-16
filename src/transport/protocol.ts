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
  const parsed = JSON.parse(data);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.id !== 'string' ||
    typeof parsed.action !== 'string' ||
    typeof parsed.instanceKey !== 'string'
  ) {
    throw new Error('Invalid WsActionRequest');
  }
  return parsed as WsActionRequest;
}

export function encodeResponse(res: WsActionResponse): string {
  return JSON.stringify(res);
}

export function decodeResponse(data: string): WsActionResponse {
  const parsed = JSON.parse(data);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.id !== 'string' ||
    typeof parsed.ok !== 'boolean'
  ) {
    throw new Error('Invalid WsActionResponse');
  }
  if (!parsed.ok && typeof parsed.error !== 'string') {
    throw new Error('Invalid WsActionResponse: missing error string');
  }
  return parsed as WsActionResponse;
}
