/**
 * Which thrown value a server binding may answer the caller with.
 *
 * The distinction is the whole of it: a recognised error goes out with its own
 * code and message, and everything else is an internal failure the binding
 * hides behind -32603 in production. Reading "has a numeric `code`" as "is a
 * domain error" put ordinary runtime failures on the first side of that line.
 */
import { describe, expect, it } from "vitest";
import { isRpcShapedError, RpcError } from "../src/index.js";

/** The error an aborted `fetch` really throws, not a stand-in for one. */
async function abortedFetch(): Promise<unknown> {
	const controller = new AbortController();
	controller.abort();
	try {
		await fetch("http://127.0.0.1:1/", { signal: controller.signal });
	} catch (error) {
		return error;
	}
	throw new Error("expected the aborted fetch to throw");
}

describe("comet > errors that only look shaped", () => {
	it("does not read an aborted fetch as a domain error", async () => {
		const error = await abortedFetch();

		// `DOMException` carries a legacy numeric `code` — 20 here. Answered as
		// a domain error, a handler whose outbound call was cancelled told the
		// caller `{ code: 20, message: "This operation was aborted" }`, in
		// production, past the guard that keeps internal messages off the wire.
		expect(error).toBeInstanceOf(DOMException);
		expect(error instanceof DOMException && error.code).toBe(20);
		expect(isRpcShapedError(error)).toBe(false);
	});

	it("does not read a timed-out operation as one either", () => {
		const error = new DOMException("It timed out", "TimeoutError");
		expect(error.code).toBe(23);
		expect(isRpcShapedError(error)).toBe(false);
	});

	it("does not read a gRPC status as one", () => {
		// NOT_FOUND is 5 — a number a handler calling a gRPC service throws
		// without ever meaning it as a JSON-RPC code.
		expect(isRpcShapedError({ code: 5, message: "not found" })).toBe(false);
	});

	it("does not read a code that is not an integer", () => {
		expect(isRpcShapedError({ code: -1.5, message: "x" })).toBe(false);
		expect(isRpcShapedError({ code: Number.NaN, message: "x" })).toBe(false);
	});

	it("does not read an ordinary Error as one", () => {
		expect(isRpcShapedError(new Error("kaboom"))).toBe(false);
		expect(isRpcShapedError({ message: "no code" })).toBe(false);
		expect(isRpcShapedError(null)).toBe(false);
	});
});

describe("comet > errors that say so", () => {
	it("reads a domain code from the space the spec gives errors", () => {
		expect(isRpcShapedError({ code: -32004, message: "not found" })).toBe(true);
		expect(isRpcShapedError({ code: -32603 })).toBe(true);
	});

	it("reads an RpcError whatever its code, because throwing one is deliberate", () => {
		// The escape hatch stays fully open: an application that numbers its
		// errors upwards says so by throwing the type instead of hoping a
		// structural check guesses right.
		expect(isRpcShapedError(new RpcError(1001, "seat taken"))).toBe(true);
		expect(isRpcShapedError(new RpcError(-32004, "gone"))).toBe(true);
	});
});
