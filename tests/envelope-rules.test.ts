/**
 * The parts of JSON-RPC 2.0 that are written as a MUST, checked against what
 * the spec actually says rather than against what the parser happened to do.
 */
import { describe, expect, it } from "vitest";
import {
	buildRequest,
	isObject,
	parseRequest,
	RpcError,
	RpcErrorCode,
	toRpcError,
} from "../src/index.js";

/** The error response a rejected envelope carries. */
function rejection(value: unknown): { code: number; id: unknown } {
	const parsed = parseRequest(value);
	if (parsed.ok) throw new Error("expected the envelope to be refused");
	return { code: parsed.response.error.code, id: parsed.response.id };
}

describe("comet > params is a Structured value or it is not params", () => {
	// §4.2: "If present, parameters for the rpc call MUST be provided as a
	// Structured value. Either by-position through an Array or by-name through
	// an Object."
	it("refuses a scalar, echoing the id it was sent under", () => {
		for (const params of ["drop", 7, true]) {
			expect(rejection({ jsonrpc: "2.0", method: "m", params, id: 4 })).toEqual(
				{ code: RpcErrorCode.InvalidRequest, id: 4 },
			);
		}
	});

	it("refuses null, which is a value but not a structured one", () => {
		expect(
			rejection({ jsonrpc: "2.0", method: "m", params: null, id: 1 }).code,
		).toBe(RpcErrorCode.InvalidRequest);
	});

	it("takes both structured forms and no params at all", () => {
		expect(
			parseRequest({ jsonrpc: "2.0", method: "m", params: [1, 2], id: 1 }),
		).toEqual({ ok: true, method: "m", params: [1, 2], id: 1 });
		expect(
			parseRequest({ jsonrpc: "2.0", method: "m", params: { a: 1 }, id: 1 }),
		).toEqual({ ok: true, method: "m", params: { a: 1 }, id: 1 });
		expect(parseRequest({ jsonrpc: "2.0", method: "m", id: 1 })).toEqual({
			ok: true,
			method: "m",
			params: undefined,
			id: 1,
		});
	});

	it("accepts what buildRequest produces for a call with no params", () => {
		// The two halves have to agree without JSON in between: a worker or an
		// in-process bus hands the object over as it was built, and a `params`
		// member holding `undefined` is not a Structured value.
		const request = buildRequest("m", undefined, 1);
		expect("params" in request).toBe(false);
		expect(parseRequest(request).ok).toBe(true);
	});
});

describe("comet > an error code is an integer", () => {
	// §5.1 on `code`: "A Number that indicates the error type that occurred.
	// This MUST be an integer."
	it("refuses a fractional or NaN code and keeps the envelope as data", () => {
		for (const code of [1.5, Number.NaN]) {
			const error = toRpcError({ code, message: "x" });
			expect(error.code).toBe(RpcErrorCode.InternalError);
			expect(error.message).toBe("Malformed JSON-RPC error envelope");
			expect(error.data).toEqual({ code, message: "x" });
		}
	});

	it("still maps a well-formed error member", () => {
		const error = toRpcError({
			code: -32004,
			message: "gone",
			data: { id: 1 },
		});
		expect(error).toBeInstanceOf(RpcError);
		expect([error.code, error.message, error.data]).toEqual([
			-32004,
			"gone",
			{ id: 1 },
		]);
	});
});

describe("comet > an Array is not an Object", () => {
	it("is not narrowed by the guard named for the spec's Object", () => {
		expect(isObject([])).toBe(false);
		expect(isObject([{ jsonrpc: "2.0" }])).toBe(false);
		expect(isObject({})).toBe(true);
		expect(isObject(null)).toBe(false);
	});

	it("is refused as a request rather than walked into one", () => {
		expect(rejection([{ jsonrpc: "2.0", method: "m", id: 1 }])).toEqual({
			code: RpcErrorCode.InvalidRequest,
			id: null,
		});
	});
});
