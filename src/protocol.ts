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

/**
 * Narrow an unknown to a JSON-RPC Object — non-null, and not an Array.
 *
 * Every envelope the spec defines is an Object; the one Array it has is the
 * batch, which a binding frames before anything here sees it. Answering "yes"
 * to an Array let a batch walk into the single-request path, where it was
 * turned away for a missing `jsonrpc` rather than for being the wrong kind of
 * thing.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON-RPC error code. Spec §5.1 on `code`: "A Number that indicates the
 * error type that occurred. This MUST be an integer." A fractional code — or a
 * `NaN`, which is what an arithmetic slip in a handler produces — is not one,
 * and `NaN` does not survive `JSON.stringify`: it goes out as `null` and
 * reaches the caller as an error whose code is missing.
 */
function isErrorCode(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/**
 * Turn a JSON-RPC `error` member (untrusted wire value) into an {@link RpcError}.
 * Falls back to an internal-error when the shape is malformed.
 */
export function toRpcError(error: unknown): RpcError {
	if (
		isObject(error) &&
		isErrorCode(error.code) &&
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
 * Whether a thrown value is a JSON-RPC error a binding may answer the caller
 * with, rather than an internal failure it has to keep to itself.
 *
 * {@link RpcError} always is: throwing one is a statement. A foreign object is
 * only read as one when its `code` is a NEGATIVE integer — the space the spec
 * gives errors (§5.1 reserves -32768..-32000 and the framework issues -32003,
 * -32004 and the like), and the space a handler writing a domain code picks
 * from.
 *
 * Accepting any number was accepting the numbers other things happen to carry.
 * A `DOMException` has a legacy numeric `code` — 20 for `AbortError`, 23 for
 * `TimeoutError` — so a handler whose outbound `fetch` timed out answered the
 * caller with `{ code: 20, message: "This operation was aborted" }`, walking
 * straight past the guard a binding puts there to keep internal messages off
 * the wire in production. gRPC status codes (0..16) arrive the same way.
 */
export function isRpcShapedError(
	err: unknown,
): err is { code: number; message?: unknown; data?: unknown } {
	if (err instanceof RpcError) return true;
	return isObject(err) && isErrorCode(err.code) && err.code < 0;
}

/**
 * Build an outgoing request envelope. An absent `params` is left out, the way
 * {@link buildError} leaves out an absent `data`: a transport that does not go
 * through `JSON.stringify` — a worker, an in-process bus — otherwise carries a
 * `params` member holding `undefined`, which is not a Structured value and is
 * refused by the parser at the other end.
 */
export function buildRequest(
	method: string,
	params: unknown,
	id: JsonRpcId,
): JsonRpcRequest {
	return params === undefined
		? { jsonrpc: "2.0", method, id }
		: { jsonrpc: "2.0", method, params, id };
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
 * Returns an `InvalidRequest` error response when the version, the method, the
 * id or the shape of `params` is wrong.
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
	// §4.2: "If present, parameters for the rpc call MUST be provided as a
	// Structured value. Either by-position through an Array or by-name through
	// an Object." A string, a number or a `null` is none of those, and passing
	// one on hands the method a `params` no handler was written to read — the
	// envelope check saying yes to something the method can only say no to.
	const paramsValid =
		params === undefined || isObject(params) || Array.isArray(params);
	if (jsonrpc !== "2.0" || !method || !idValid || !paramsValid) {
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
