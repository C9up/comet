/**
 * What `call` promises at the type level. A result is typed only when `parse`
 * checked it at runtime; without one it is `unknown`, for the caller to
 * narrow. An unchecked `call<T>()` was a cast the client made on the caller's
 * behalf — the same lie as `as T`, only further from where it is read.
 *
 * tsc checks these (the suite is type-checked), and vitest runs them.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { RpcTransport } from "../src/index.js";
import { createRpcClient, isObject } from "../src/index.js";

const transport: RpcTransport = async (_url, body) => ({
	jsonrpc: "2.0",
	result: 5,
	id: isObject(body) ? body.id : null,
});

describe("comet/client > call typing", () => {
	it("types the result as unknown without parse", async () => {
		const rpc = createRpcClient({ transport });
		const out = await rpc.call("demo.add", { a: 2, b: 3 });
		expectTypeOf(out).toBeUnknown();
		expect(out).toBe(5);
		const aborted = await rpc.call("demo.add", undefined, {
			signal: new AbortController().signal,
		});
		expectTypeOf(aborted).toBeUnknown();
	});

	it("types the result as what parse returns", async () => {
		const rpc = createRpcClient({ transport });
		const sum = await rpc.call(
			"demo.add",
			{ a: 2, b: 3 },
			{
				parse: (data) => {
					if (typeof data !== "number") throw new TypeError("not a number");
					return data;
				},
			},
		);
		expectTypeOf(sum).toBeNumber();
		expect(sum + 1).toBe(6);
	});
});
