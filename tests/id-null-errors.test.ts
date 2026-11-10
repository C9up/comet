/**
 * The error a server answers when it could not read the id.
 *
 * §5: "If there was an error in detecting the id in the Request object (e.g.
 * Parse error/Invalid Request), it MUST be Null"; §6: a batch that is itself
 * invalid is answered with "a single Response object". The transport hands a
 * call exactly one reply, so an id-null ERROR is the server's answer to it —
 * jayson's isValidResponse accepts `id: null` on an error response too.
 */
import { describe, expect, it } from "vitest";
import type { RpcTransport } from "../src/index.js";
import { createRpcClient, isObject, RpcError } from "../src/index.js";

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RpcError) return error;
		throw error;
	}
	throw new Error("expected a rejection");
}

const batchTooLarge = {
	jsonrpc: "2.0",
	error: { code: -32600, message: "Batch too large (max 50)" },
	id: null,
};

describe("comet/client > an id-null error response", () => {
	it("is the server's answer to a call", async () => {
		const transport: RpcTransport = async () => ({
			jsonrpc: "2.0",
			error: { code: -32600, message: "Invalid Request" },
			id: null,
		});
		const error = await rejection(createRpcClient({ transport }).call("foo"));
		expect([error.code, error.message]).toEqual([-32600, "Invalid Request"]);
	});

	it("is the server's answer to a whole batch it refused", async () => {
		const transport: RpcTransport = async () => batchTooLarge;
		const calls = Array.from({ length: 51 }, (_, index) => ({
			method: `m${index}`,
		}));
		const error = await rejection(createRpcClient({ transport }).batch(calls));
		expect([error.code, error.message]).toEqual([
			-32600,
			"Batch too large (max 50)",
		]);
	});

	it("answers the one batch entry left without a response", async () => {
		const transport: RpcTransport = async (_url, body) => {
			const ids = Array.isArray(body)
				? body.map((entry) => (isObject(entry) ? entry.id : undefined))
				: [];
			return [
				{ jsonrpc: "2.0", result: "a", id: ids[0] },
				{
					jsonrpc: "2.0",
					error: { code: -32600, message: "Invalid Request" },
					id: null,
				},
				{ jsonrpc: "2.0", result: "c", id: ids[2] },
			];
		};
		const results = await createRpcClient({ transport }).batch([
			{ method: "a" },
			{ method: "b" },
			{ method: "c" },
		]);
		expect(results[0]).toEqual({ ok: true, value: "a" });
		expect(results[2]).toEqual({ ok: true, value: "c" });
		const middle = results[1];
		expect(middle?.ok === false && middle.error.code).toBe(-32600);
	});

	it("is not guessed onto an entry when several are left without one", async () => {
		const transport: RpcTransport = async () => [
			{ jsonrpc: "2.0", error: { code: -32600, message: "x" }, id: null },
		];
		const results = await createRpcClient({ transport }).batch([
			{ method: "a" },
			{ method: "b" },
		]);
		for (const result of results) {
			expect(result.ok === false && result.error.message).toMatch(
				/^No response for/,
			);
		}
	});

	it("still refuses a success, or a malformed reply, with a null id", async () => {
		const success: RpcTransport = async () => ({
			jsonrpc: "2.0",
			result: "stolen",
			id: null,
		});
		expect(
			(await rejection(createRpcClient({ transport: success }).call("foo")))
				.message,
		).toMatch(/mismatched/);
		const both: RpcTransport = async () => ({
			jsonrpc: "2.0",
			result: 1,
			error: { code: -32600, message: "x" },
			id: null,
		});
		expect(
			(await rejection(createRpcClient({ transport: both }).call("foo")))
				.message,
		).toMatch(/mismatched/);
		const wrongVersion: RpcTransport = async () => ({
			...batchTooLarge,
			jsonrpc: "1.0",
		});
		expect(
			(
				await rejection(
					createRpcClient({ transport: wrongVersion }).batch([{ method: "a" }]),
				)
			).message,
		).toBe("Malformed JSON-RPC batch response");
	});
});
