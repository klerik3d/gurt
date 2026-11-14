// The JSON-RPC 2.0 envelope inside the channel (requirements-remote-protocol.md
// §7): one reassembled channel message is one JSON-RPC object, UTF-8. Both
// sides send requests and notifications; ids are per sender.

/** Error codes (§7.7). */
export const RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** More than `MAX_IN_FLIGHT` requests outstanding on one stream. */
  tooManyInFlight: -32001,
  /** The result would exceed the 16 MiB message cap. */
  resultTooLarge: -32002,
  /** The prompt, turn or item the call names is gone or no longer current. */
  stale: -32010,
  /** The call needs `confirm: true`. */
  confirmationRequired: -32011,
  /** The session or item does not exist. */
  notFound: -32012
} as const
export type RpcErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR]

/** Requests in flight per stream before `-32001` (§7.7). */
export const MAX_IN_FLIGHT = 32

export type RpcId = number | string

export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface RpcRequest {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: unknown
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface RpcSuccess {
  jsonrpc: '2.0'
  id: RpcId
  result: unknown
}

export interface RpcFailure {
  jsonrpc: '2.0'
  /** `null` when the request's id could not be read. */
  id: RpcId | null
  error: RpcErrorObject
}

export type RpcMessage =
  | ({ kind: 'request' } & RpcRequest)
  | ({ kind: 'notification' } & RpcNotification)
  | ({ kind: 'success' } & RpcSuccess)
  | ({ kind: 'failure' } & RpcFailure)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is RpcId => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

/**
 * Classify one message. `undefined` means it is not a JSON-RPC 2.0 object —
 * answer `-32600` with id `null` (when it could have been a request) and go
 * on. Unknown members are ignored (§2). Batches are not part of the protocol.
 * Remote API params are always an object (§7.2); that is checked per method,
 * not here, since a `-32602` needs the id.
 */
export function parseRpc(text: string): RpcMessage | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(v) || v['jsonrpc'] !== '2.0') return undefined
  const { id, method, params } = v
  if (typeof method === 'string') {
    if (id === undefined) return { kind: 'notification', jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
    if (!isId(id)) return undefined
    return { kind: 'request', jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
  }
  if (method !== undefined) return undefined
  if ('result' in v && !('error' in v)) {
    if (!isId(id)) return undefined
    return { kind: 'success', jsonrpc: '2.0', id, result: v['result'] }
  }
  const error = v['error']
  if ('error' in v && !('result' in v) && isObject(error)) {
    if (id !== null && !isId(id)) return undefined
    if (typeof error['code'] !== 'number' || typeof error['message'] !== 'string') return undefined
    return {
      kind: 'failure',
      jsonrpc: '2.0',
      id,
      error: {
        code: error['code'],
        message: error['message'],
        ...(error['data'] !== undefined ? { data: error['data'] } : {})
      }
    }
  }
  return undefined
}

export const rpcRequest = (id: RpcId, method: string, params?: unknown): RpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {})
})

export const rpcNotification = (method: string, params?: unknown): RpcNotification => ({
  jsonrpc: '2.0',
  method,
  ...(params !== undefined ? { params } : {})
})

export const rpcSuccess = (id: RpcId, result: unknown): RpcSuccess => ({ jsonrpc: '2.0', id, result })

export const rpcFailure = (id: RpcId | null, code: number, message: string, data?: unknown): RpcFailure => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) }
})
