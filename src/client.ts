/**
 * Isomorphic JSON-RPC 2.0 client — the protocol logic (single + batch) over an
 * INJECTED transport. It owns the envelope/id/error handling (from
 * {@link "./protocol"}) and knows nothing about how bytes travel: pass a browser
 * transport (aurora's HttpClient) or a Node one (fetch/undici). This is the
 * adapter seam that lets the client live outside any UI or server framework.
 *
 *   const rpc = createRpcClient({ transport: (url, body, { signal }) =>
 *     fetch(url, { method: 'POST', body: JSON.stringify(body), signal })
 *       .then((r) => r.json()) })
 *   const out = await rpc.call('task.validate', { id })
 */
import {
	buildRequest,
	isObject,
	RpcError,
	RpcErrorCode,
	toRpcError,
} from "./protocol.js";

/**
 * Sends a JSON body to `url` and resolves the parsed JSON response. Injected via
 * {@link RpcClientOptions.transport}; the client never touches `fetch` directly.
 */
export type RpcTransport = (
	url: string,
	body: unknown,
	options: { signal?: AbortSignal },
) => Promise<unknown>;

export interface RpcClientOptions {
	/** How requests are sent — the only required wiring. */
	transport: RpcTransport;
	/** Endpoint path. Default `/rpc`. */
	url?: string;
}

/** Per-call options for {@link RpcClient.call}. */
export interface RpcCallOptions<T = unknown> {
	/**
	 * Validate the result at runtime, returning the typed value — skips the
	 * unchecked `T` assertion (the cast-free escape hatch).
	 */
	parse?: (data: unknown) => T;
	/** Abort signal — abort it to cancel the request (e.g. on unmount / new keystroke). */
	signal?: AbortSignal;
}

/** One call in a batch. `parse` optionally validates that call's result (cast-free). */
export interface RpcCall<T = unknown> {
	method: string;
	params?: unknown;
	parse?: (data: unknown) => T;
}

/** A settled batch entry — the result, or the JSON-RPC error for that call. */
export type RpcResult<T = unknown> =
	| { ok: true; value: T }
	| { ok: false; error: RpcError };

export interface RpcClient {
	/**
	 * Call one method. Returns the result, or throws {@link RpcError} on a
	 * JSON-RPC error. The `jsonrpc`/`id` envelope is handled internally. Pass
	 * `options.parse` to validate the result at runtime (skips the unchecked `T`
	 * assertion) and `options.signal` to make the call abortable.
	 */
	call<T = unknown>(
		method: string,
		params?: unknown,
		options?: RpcCallOptions<T>,
	): Promise<T>;
	/**
	 * Send a JSON-RPC batch. Returns one settled entry per call, in request
	 * order. `options.signal` aborts the whole batch (it is one HTTP request).
	 */
	batch(
		calls: RpcCall[],
		options?: { signal?: AbortSignal },
	): Promise<RpcResult[]>;
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
	const { transport } = options;
	const url = options.url ?? "/rpc";
	let nextId = 0;

	return {
		async call<T>(
			method: string,
			params?: unknown,
			callOptions?: RpcCallOptions<T>,
		): Promise<T> {
			const id = ++nextId;
			const res = await transport(url, buildRequest(method, params, id), {
				signal: callOptions?.signal,
			});
			// Envelope conformance (JSON-RPC 2.0 §5): the version must match and the
			// id MUST echo the one we sent — otherwise a stale, mis-routed, or
			// forged response could satisfy the wrong call. Reject before trusting
			// `result`.
			if (!isObject(res) || res.jsonrpc !== "2.0" || res.id !== id) {
				throw new RpcError(
					RpcErrorCode.InternalError,
					`Malformed or mismatched JSON-RPC response for "${method}" (bad jsonrpc/id envelope)`,
				);
			}
			if (res.error !== undefined) throw toRpcError(res.error);
			// A conformant success response carries `result` (any JSON value,
			// including null) and no error — neither key present is malformed.
			if (!("result" in res)) {
				throw new RpcError(
					RpcErrorCode.InternalError,
					`JSON-RPC response for "${method}" has neither result nor error`,
				);
			}
			// Result boundary — the same unchecked `T` assertion HTTP clients use,
			// with `parse` as the cast-free, runtime-validated escape hatch.
			return callOptions?.parse
				? callOptions.parse(res.result)
				: (res.result as T);
		},

		async batch(
			calls: RpcCall[],
			batchOptions?: { signal?: AbortSignal },
		): Promise<RpcResult[]> {
			if (calls.length === 0) return [];
			const requests = calls.map((c, index) =>
				// index = request position; responses are matched back by id
				buildRequest(c.method, c.params, index),
			);
			const res = await transport(url, requests, {
				signal: batchOptions?.signal,
			});
			if (!Array.isArray(res)) {
				throw new RpcError(
					RpcErrorCode.InternalError,
					"Malformed JSON-RPC batch response",
				);
			}
			const byId = new Map<unknown, Record<string, unknown>>();
			for (const item of res) if (isObject(item)) byId.set(item.id, item);
			return calls.map((c, index) => {
				const envelope = byId.get(index);
				if (!envelope) {
					return {
						ok: false,
						error: new RpcError(
							RpcErrorCode.InternalError,
							`No response for "${c.method}"`,
						),
					};
				}
				if (envelope.error !== undefined) {
					return { ok: false, error: toRpcError(envelope.error) };
				}
				const value = c.parse ? c.parse(envelope.result) : envelope.result;
				return { ok: true, value };
			});
		},
	};
}
