/**
 * An error the client raised is not a statement by the code that awaited it.
 *
 * A server handler that calls another JSON-RPC service through comet and lets
 * the error through must not relay that service's code, message and data to
 * ITS caller: the binding redacts what it does not recognise as deliberate,
 * and a downstream failure is exactly what it must not recognise.
 */
import { describe, expect, it } from "vitest";
import type { RpcTransport } from "../src/index.js";
import {
	createRpcClient,
	isObject,
	isRpcError,
	isRpcShapedError,
	RpcError,
	RpcRemoteError,
} from "../src/index.js";

function idOf(body: unknown): unknown {
	return isObject(body) ? body.id : undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("comet/client > errors it raises are remote", () => {
	it("marks a server's error as remote, still an RpcError with its code", async () => {
		const transport: RpcTransport = async (_url, body) => ({
			jsonrpc: "2.0",
			error: {
				code: -32603,
				message: 'duplicate key value violates "invoices_pkey"',
				data: { stack: "at Billing.charge" },
			},
			id: idOf(body),
		});
		const error = await rejection(
			createRpcClient({ transport }).call("billing.chargeCard"),
		);
		expect(error).toBeInstanceOf(RpcRemoteError);
		expect(isRpcError(error)).toBe(true);
		expect(error instanceof RpcError && error.code).toBe(-32603);
		expect(isRpcShapedError(error)).toBe(false);
	});

	it("marks its own refusal of a mismatched response as remote", async () => {
		const transport: RpcTransport = async () => ({
			jsonrpc: "2.0",
			result: 1,
			id: 999,
		});
		const error = await rejection(
			createRpcClient({ transport }).call("ledger.adminDumpAll"),
		);
		expect(error).toBeInstanceOf(RpcRemoteError);
		expect(isRpcShapedError(error)).toBe(false);
	});

	it("marks a malformed error envelope and a non-array batch reply as remote", async () => {
		const malformed: RpcTransport = async (_url, body) => ({
			jsonrpc: "2.0",
			error: "nope",
			id: idOf(body),
		});
		expect(
			isRpcShapedError(
				await rejection(createRpcClient({ transport: malformed }).call("a")),
			),
		).toBe(false);
		const notArray: RpcTransport = async () => ({ jsonrpc: "2.0" });
		expect(
			isRpcShapedError(
				await rejection(
					createRpcClient({ transport: notArray }).batch([{ method: "a" }]),
				),
			),
		).toBe(false);
	});

	it("marks every failed batch entry as remote", async () => {
		const transport: RpcTransport = async (_url, body) => {
			const ids = Array.isArray(body) ? body.map(idOf) : [];
			return [
				{
					jsonrpc: "2.0",
					error: { code: -32004, message: "gone" },
					id: ids[0],
				},
				{ jsonrpc: "2.0", result: "x", id: ids[1] },
			];
		};
		const results = await createRpcClient({ transport }).batch([
			{ method: "a" },
			{
				method: "b",
				parse: () => {
					throw new Error("not a User");
				},
			},
			{ method: "c" },
		]);
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBeInstanceOf(RpcRemoteError);
				expect(isRpcShapedError(result.error)).toBe(false);
			}
		}
	});

	it("keeps the validator's error as the cause, never as data", async () => {
		const reason = new Error("not a User");
		const transport: RpcTransport = async (_url, body) =>
			Array.isArray(body)
				? body.map((entry) => ({ jsonrpc: "2.0", result: 1, id: idOf(entry) }))
				: [];
		const [entry] = await createRpcClient({ transport }).batch([
			{
				method: "a",
				parse: () => {
					throw reason;
				},
			},
		]);
		expect(entry?.ok).toBe(false);
		if (entry?.ok === false) {
			// `data` is what a binding writes on the wire; a stack has no place there.
			expect(entry.error.data).toBeUndefined();
			expect(entry.error.cause).toBe(reason);
			expect(entry.error.message).toMatch(/"a" failed validation: not a User/);
		}
	});

	it("still lets a handler forward a downstream error on purpose", () => {
		const downstream = new RpcRemoteError(-32004, "gone");
		const forwarded = new RpcError(downstream.code, downstream.message);
		expect(isRpcShapedError(forwarded)).toBe(true);
	});
});
