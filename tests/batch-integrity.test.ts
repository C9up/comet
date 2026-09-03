/**
 * What a batch owes each of its calls: an id that is only ever its own, and a
 * settled entry that survives whatever the call next to it did.
 */
import { describe, expect, it } from "vitest";
import type { RpcTransport } from "../src/index.js";
import { createRpcClient, isObject } from "../src/index.js";

/** The ids of everything the client sent, in send order. */
function idsOf(body: unknown): number[] {
	const items = Array.isArray(body) ? body : [body];
	return items.flatMap((item) =>
		isObject(item) && typeof item.id === "number" ? [item.id] : [],
	);
}

/** A transport that answers every request with a null result and records the ids. */
function recording(): { transport: RpcTransport; sent: number[] } {
	const sent: number[] = [];
	const transport: RpcTransport = async (_url, body) => {
		const ids = idsOf(body);
		sent.push(...ids);
		const answers = ids.map((id) => ({ jsonrpc: "2.0", result: null, id }));
		return Array.isArray(body) ? answers : answers[0];
	};
	return { transport, sent };
}

describe("comet > one id space for calls and batches", () => {
	it("never sends the same id twice", async () => {
		const { transport, sent } = recording();
		const rpc = createRpcClient({ transport });

		await rpc.call("a");
		await rpc.batch([{ method: "b" }, { method: "c" }]);
		await rpc.batch([{ method: "d" }]);
		await rpc.call("e");

		// A batch numbering its entries from zero sent `0, 1` and then `0`
		// again, while a call was live on `1`. Over a transport that carries
		// several requests on one connection — the reason the transport is
		// injected at all — the id is the only thing pairing an answer with its
		// caller, so a repeated one is an answer handed to the wrong one.
		expect(sent).toHaveLength(5);
		expect(new Set(sent).size).toBe(5);
	});

	it("refuses a response carrying an id from an earlier request", async () => {
		const stale: number[] = [];
		const transport: RpcTransport = async (_url, body) => {
			const ids = idsOf(body);
			const answers = ids.map((id) => ({
				jsonrpc: "2.0",
				result: "late",
				// Answer with the ids of the PREVIOUS batch, which is what a
				// reused id space makes indistinguishable from an answer of
				// one's own.
				id: stale.length > 0 ? stale.shift() : id,
			}));
			stale.push(...ids);
			return answers;
		};
		const rpc = createRpcClient({ transport });

		await rpc.batch([{ method: "a" }]);
		const second = await rpc.batch([{ method: "b" }]);

		const entry = second[0];
		expect(entry?.ok).toBe(false);
		expect(entry?.ok === false && entry.error.message).toMatch(
			/No response for "b"/,
		);
	});
});

describe("comet > a result that fails its own validation", () => {
	it("settles that entry and leaves the others standing", async () => {
		const { transport } = recording();
		const rpc = createRpcClient({ transport });

		const results = await rpc.batch([
			{ method: "a" },
			{
				method: "b",
				parse: () => {
					throw new Error("not a User");
				},
			},
			{ method: "c" },
		]);

		// Letting the throw out rejected the whole promise, so a single call
		// whose shape had drifted destroyed every other result in the round
		// trip — including the ones that had already come back fine.
		expect(results).toHaveLength(3);
		expect(results[0]).toEqual({ ok: true, value: null });
		expect(results[2]).toEqual({ ok: true, value: null });
		const failed = results[1];
		expect(failed?.ok).toBe(false);
		if (failed?.ok === false) {
			expect(failed.error.message).toMatch(/"b" failed validation: not a User/);
			// What the validator threw is reachable — a caller asking WHY the
			// shape was refused has nowhere else to read it.
			expect(failed.error.data).toBeInstanceOf(Error);
		}
	});

	it("still hands a passing validator's value back", async () => {
		const transport: RpcTransport = async (_url, body) =>
			idsOf(body).map((id) => ({ jsonrpc: "2.0", result: { n: 1 }, id }));
		const rpc = createRpcClient({ transport });

		const [entry] = await rpc.batch([
			{
				method: "a",
				parse: (data: unknown) =>
					isObject(data) && typeof data.n === "number" ? data.n : 0,
			},
		]);
		expect(entry).toEqual({ ok: true, value: 1 });
	});
});
