/**
 * Notifications (§4.1): a request without an `id`, which the server runs and
 * MUST NOT answer. json-rpc-2.0's JSONRPCClient.notify sends one and ignores
 * the reply; jayson sends one when the id is null.
 */
import { describe, expect, it, vi } from "vitest";
import type { RpcTransport } from "../src/index.js";
import {
	buildNotification,
	createRpcClient,
	isObject,
	RpcError,
} from "../src/index.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("comet/protocol > buildNotification", () => {
	it("builds a request with no id member, and leaves absent params out", () => {
		expect(buildNotification("log", { level: 1 })).toEqual({
			jsonrpc: "2.0",
			method: "log",
			params: { level: 1 },
		});
		const bare = buildNotification("ping", undefined);
		expect(bare).toEqual({ jsonrpc: "2.0", method: "ping" });
		expect("id" in bare).toBe(false);
		expect("params" in bare).toBe(false);
	});
});

describe("comet/client > notify", () => {
	it("sends a notification and resolves on the server's empty reply", async () => {
		const transport = vi.fn<RpcTransport>(async () => null);
		const signal = new AbortController().signal;
		const rpc = createRpcClient({ transport });

		await expect(
			rpc.notify("audit.log", { event: "login" }, { signal }),
		).resolves.toBeUndefined();
		expect(transport).toHaveBeenCalledTimes(1);
		const [url, body, options] = transport.mock.calls[0] ?? [];
		expect(url).toBe("/rpc");
		expect(body).toEqual({
			jsonrpc: "2.0",
			method: "audit.log",
			params: { event: "login" },
		});
		expect(isObject(body) && "id" in body).toBe(false);
		expect(options?.signal).toBe(signal);
	});

	it("rejects when the transport fails", async () => {
		const failure = new TypeError("network down");
		const transport: RpcTransport = async () => {
			throw failure;
		};
		expect(await rejection(createRpcClient({ transport }).notify("x"))).toBe(
			failure,
		);
	});

	it("rejects with the server's error when it refused the notification", async () => {
		// An invalid notification is no Request object: the server answers it
		// with -32600 and a null id (§5).
		const transport: RpcTransport = async () => ({
			jsonrpc: "2.0",
			error: { code: -32600, message: "Invalid Request" },
			id: null,
		});
		const error = await rejection(createRpcClient({ transport }).notify(""));
		expect(error instanceof RpcError && error.code).toBe(-32600);
	});
});

describe("comet/client > notifications in a batch", () => {
	it("sends them without an id and does not wait for an answer", async () => {
		const transport = vi.fn<RpcTransport>(async (_url, body) =>
			(Array.isArray(body) ? body : [])
				.filter((entry) => isObject(entry) && "id" in entry)
				.map((entry) => ({
					jsonrpc: "2.0",
					result: isObject(entry) ? entry.method : null,
					id: isObject(entry) ? entry.id : null,
				})),
		);
		const results = await createRpcClient({ transport }).batch([
			{ method: "a" },
			{ method: "log", params: { n: 1 }, notify: true },
			{ method: "c" },
		]);
		const sent = transport.mock.calls[0]?.[1];
		expect(Array.isArray(sent) && sent[1]).toEqual({
			jsonrpc: "2.0",
			method: "log",
			params: { n: 1 },
		});
		// One entry per call, in order; a notification's has nothing to carry.
		expect(results).toEqual([
			{ ok: true, value: "a" },
			{ ok: true, value: undefined },
			{ ok: true, value: "c" },
		]);
	});

	it("resolves an all-notification batch on the server's empty reply", async () => {
		for (const reply of [null, undefined, ""]) {
			const transport: RpcTransport = async () => reply;
			const results = await createRpcClient({ transport }).batch([
				{ method: "a", notify: true },
				{ method: "b", notify: true },
			]);
			expect(results).toEqual([
				{ ok: true, value: undefined },
				{ ok: true, value: undefined },
			]);
		}
	});
});
