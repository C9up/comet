/**
 * JSON-RPC 2.0 protocol primitives — the agnostic core shared by every Comet
 * consumer: the isomorphic {@link "./client".createRpcClient} AND any server
 * binding (Ream's `RpcRouter` builds on these instead of hand-rolling its own).
 *
 * Zero transport, zero framework, zero dependency — just the envelope shapes,
 * the reserved error codes, builders, and the request parser/notification rule
 * from the spec (https://www.jsonrpc.org/specification).
 */

/** A JSON-RPC id — a string, a number, or `null` (spec §4). */
export type JsonRpcId = string | number | null;

/** An outgoing JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
	id: JsonRpcId;
}

/** The `error` member of a JSON-RPC 2.0 error response. */
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

/** A successful JSON-RPC 2.0 response envelope. */
export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	result: unknown;
	id: JsonRpcId;
}

/** An error JSON-RPC 2.0 response envelope. */
export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	error: JsonRpcErrorObject;
	id: JsonRpcId;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * The reserved JSON-RPC 2.0 error codes (spec §5.1). Domain handlers are free to
 * use codes outside the reserved `-32768..-32000` range for their own errors.
 */
export const RpcErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

/** A JSON-RPC 2.0 error surfaced as a throwable (carries `code` + optional `data`). */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/** Type guard for {@link RpcError}. */
export function isRpcError(value: unknown): value is RpcError {
	return value instanceof RpcError;
}

/** Narrow an unknown to a plain object (non-null). */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Turn a JSON-RPC `error` member (untrusted wire value) into an {@link RpcError}.
 * Falls back to an internal-error when the shape is malformed.
 */
export function toRpcError(error: unknown): RpcError {
	if (
		isObject(error) &&
		typeof error.code === "number" &&
		typeof error.message === "string"
	) {
		return new RpcError(error.code, error.message, error.data);
	}
	return new RpcError(
		RpcErrorCode.InternalError,
		"Malformed JSON-RPC error envelope",
		error,
	);
}

/**
 * A domain error shaped like a JSON-RPC error — it carries a numeric `code`. A
 * server binding can map such a throw to a JSON-RPC error response instead of
 * collapsing every throw to InternalError.
 */
export function isRpcShapedError(
	err: unknown,
): err is { code: number; message?: unknown; data?: unknown } {
	return isObject(err) && typeof err.code === "number";
}

/** Build an outgoing request envelope. */
export function buildRequest(
	method: string,
	params: unknown,
	id: JsonRpcId,
): JsonRpcRequest {
	return { jsonrpc: "2.0", method, params, id };
}

/** Build a success response envelope. */
export function buildSuccess(
	result: unknown,
	id: JsonRpcId,
): JsonRpcSuccessResponse {
	return { jsonrpc: "2.0", result, id };
}

/** Build an error response envelope (omits `data` when not supplied). */
export function buildError(
	code: number,
	message: string,
	id: JsonRpcId,
	data?: unknown,
): JsonRpcErrorResponse {
	return {
		jsonrpc: "2.0",
		error: data === undefined ? { code, message } : { code, message, data },
		id,
	};
}

/** Result of {@link parseRequest}. */
export type ParsedRpcRequest =
	| { ok: true; method: string; params: unknown; id: JsonRpcId }
	| { ok: false; response: JsonRpcErrorResponse };

/**
 * Validate an incoming JSON-RPC envelope and extract `method`/`params`/`id`.
 * Returns an `InvalidRequest` error response when the version/method are wrong.
 */
export function parseRequest(request: unknown): ParsedRpcRequest {
	if (!isObject(request)) {
		return {
			ok: false,
			response: buildError(
				RpcErrorCode.InvalidRequest,
				"Invalid Request",
				null,
			),
		};
	}
	const jsonrpc =
		"jsonrpc" in request && typeof request.jsonrpc === "string"
			? request.jsonrpc
			: undefined;
	const method =
		"method" in request && typeof request.method === "string"
			? request.method
			: undefined;
	const params = "params" in request ? request.params : undefined;
	const idPresent = "id" in request;
	const rawId = idPresent ? request.id : undefined;
	// When present, `id` MUST be a String, Number, or Null (JSON-RPC 2.0 §4). A
	// present-but-wrongly-typed id (boolean/object/array) is an Invalid Request —
	// NOT silently coerced to null, which would let a malformed envelope execute.
	const idValid =
		!idPresent ||
		rawId === null ||
		typeof rawId === "string" ||
		typeof rawId === "number";
	const id: JsonRpcId =
		rawId === null || typeof rawId === "string" || typeof rawId === "number"
			? rawId
			: null;
	if (jsonrpc !== "2.0" || !method || !idValid) {
		return {
			ok: false,
			response: buildError(RpcErrorCode.InvalidRequest, "Invalid Request", id),
		};
	}
	return { ok: true, method, params, id };
}

/**
 * A JSON-RPC notification is a well-formed request with NO `id` member. The spec
 * (§4.1) says the server MUST NOT reply to one — it still runs for side-effects.
 * A malformed object (no method / wrong version) is NOT a notification.
 */
export function isNotification(request: unknown): boolean {
	return (
		isObject(request) &&
		"jsonrpc" in request &&
		request.jsonrpc === "2.0" &&
		"method" in request &&
		typeof request.method === "string" &&
		!("id" in request)
	);
}
