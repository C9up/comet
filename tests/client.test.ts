import { describe, expect, it, vi } from "vitest";
import type { RpcTransport } from "../src/index.js";
import {
	createRpcClient,
	isObject,
	isRpcError,
	RpcError,
} from "../src/index.js";

/** Cast-free readers over the envelope the client sent (typed `unknown`). */
function reqId(body: unknown): number {
	return isObject(body) && typeof body.id === "number" ? body.id : -1;
}
function reqMethod(body: unknown): string {
	return isObject(body) && typeof body.method === "string" ? body.method : "";
}

describe("comet/client > createRpcClient", () => {
	it("sends a JSON-RPC 2.0 envelope and returns the result", async () => {
		const transport = vi.fn(async (_url: string, body: unknown) => ({
			jsonrpc: "2.0",
			result: { valid: true },
			id: reqId(body),
		}));
		const rpc = createRpcClient({ transport });

		const out = await rpc.call<{ valid: boolean }>("task.validate", { id: 7 });
		expect(out).toEqual({ valid: true });

		const [url, sent] = transport.mock.calls[0];
		expect(url).toBe("/rpc");
		expect(sent).toMatchObject({
			jsonrpc: "2.0",
			method: "task.validate",
			params: { id: 7 },
		});
		expect(isObject(sent) && typeof sent.id === "number").toBe(true);
	});

	it("rejects a response whose id does not match the request (stale/misrouted)", async () => {
		const transport: RpcTransport = async () => ({
			jsonrpc: "2.0",
			result: { valid: true },
			id: 9999, // never the id this client sent
		});
		const rpc = createRpcClient({ transport });
		await expect(rpc.call("task.validate")).rejects.toThrow(
			/mismatched JSON-RPC response/,
		);
	});

	it("rejects a response missing the jsonrpc version", async () => {
		const transport: RpcTransport = async (_url, body) => ({
			result: { valid: true },
			id: reqId(body),
		});
		const rpc = createRpcClient({ transport });
		await expect(rpc.call("m")).rejects.toThrow(/bad jsonrpc\/id envelope/);
	});

	it("rejects a response carrying neither result nor error", async () => {
		const transport: RpcTransport = async (_url, body) => ({
			jsonrpc: "2.0",
			id: reqId(body),
		});
		const rpc = createRpcClient({ transport });
		await expect(rpc.call("m")).rejects.toThrow(/neither result nor error/);
	});

	it("throws RpcError (code + message + data) on a JSON-RPC error", async () => {
		const transport = vi.fn(async (_url: string, body: unknown) => ({
			jsonrpc: "2.0",
			error: { code: -32601, message: "Method not found", data: { m: "nope" } },
			id: reqId(body),
		}));
		const rpc = createRpcClient({ transport });

		const err = await rpc.call("nope").catch((e) => e);
		expect(err).toBeInstanceOf(RpcError);
		if (!isRpcError(err)) throw new Error("expected an RpcError");
		expect([err.code, err.message, err.data]).toEqual([
			-32601,
			"Method not found",
			{ m: "nope" },
		]);
	});

	it("uses a `parse` validator instead of the unchecked assertion", async () => {
		const transport = vi.fn(async (_url: string, body: unknown) => ({
			jsonrpc: "2.0",
			result: { n: 41 },
			id: reqId(body),
		}));
		const rpc = createRpcClient({ transport });

		const out = await rpc.call("m", undefined, {
			parse: (data) => {
				if (typeof data !== "object" || data === null || !("n" in data)) {
					throw new Error("bad shape");
				}
				return { n: Number(data.n) + 1 };
			},
		});
		expect(out).toEqual({ n: 42 });
	});

	it("forwards an abort signal and a custom url to the transport", async () => {
		const transport = vi.fn(
			async (_url: string, body: unknown, _opts: { signal?: AbortSignal }) => ({
				jsonrpc: "2.0",
				result: "ok",
				id: reqId(body),
			}),
		);
		const rpc = createRpcClient({ transport, url: "/api/rpc" });
		const ac = new AbortController();

		await rpc.call("ping", undefined, { signal: ac.signal });
		const [url, , opts] = transport.mock.calls[0];
		expect(url).toBe("/api/rpc");
		expect(opts.signal).toBe(ac.signal);
	});

	it("batch() returns one settled entry per call, matched by id, in order", async () => {
		const transport: RpcTransport = async (_url, body) => {
			const reqs = Array.isArray(body) ? body : [];
			// Server reorders the responses — the client must re-match by id.
			return reqs
				.map((r) =>
					reqMethod(r) === "boom"
						? {
								jsonrpc: "2.0",
								error: { code: -32000, message: "boom" },
								id: reqId(r),
							}
						: { jsonrpc: "2.0", result: `${reqMethod(r)}-ok`, id: reqId(r) },
				)
				.reverse();
		};
		const rpc = createRpcClient({ transport });

		const results = await rpc.batch([
			{ method: "a" },
			{ method: "boom" },
			{ method: "b" },
		]);
		expect(results[0]).toEqual({ ok: true, value: "a-ok" });
		expect(results[1].ok).toBe(false);
		if (!results[1].ok) expect(results[1].error.message).toBe("boom");
		expect(results[2]).toEqual({ ok: true, value: "b-ok" });
	});

	it("batch() short-circuits to [] with no calls (no transport hit)", async () => {
		const transport = vi.fn(async () => ({}));
		const rpc = createRpcClient({ transport });
		expect(await rpc.batch([])).toEqual([]);
		expect(transport).not.toHaveBeenCalled();
	});
});
