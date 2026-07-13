import { describe, expect, it } from "vitest";
import {
	buildError,
	buildRequest,
	buildSuccess,
	isNotification,
	isObject,
	isRpcError,
	isRpcShapedError,
	parseRequest,
	RpcError,
	RpcErrorCode,
	toRpcError,
} from "../src/protocol.js";

describe("comet/protocol > builders", () => {
	it("buildRequest wraps method/params/id in a 2.0 envelope", () => {
		expect(buildRequest("task.run", { id: 1 }, 7)).toEqual({
			jsonrpc: "2.0",
			method: "task.run",
			params: { id: 1 },
			id: 7,
		});
	});

	it("buildSuccess + buildError shape the response; buildError omits absent data", () => {
		expect(buildSuccess({ ok: true }, 1)).toEqual({
			jsonrpc: "2.0",
			result: { ok: true },
			id: 1,
		});
		expect(buildError(-32601, "Method not found", 2)).toEqual({
			jsonrpc: "2.0",
			error: { code: -32601, message: "Method not found" },
			id: 2,
		});
		expect(buildError(-32602, "Invalid params", 3, { field: "x" })).toEqual({
			jsonrpc: "2.0",
			error: { code: -32602, message: "Invalid params", data: { field: "x" } },
			id: 3,
		});
	});
});

describe("comet/protocol > parseRequest", () => {
	it("extracts method/params/id from a valid envelope", () => {
		const parsed = parseRequest({
			jsonrpc: "2.0",
			method: "user.find",
			params: { id: 9 },
			id: 4,
		});
		expect(parsed).toEqual({
			ok: true,
			method: "user.find",
			params: { id: 9 },
			id: 4,
		});
	});

	it("rejects a non-object with InvalidRequest + id null", () => {
		const parsed = parseRequest("nope");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.response.error.code).toBe(RpcErrorCode.InvalidRequest);
			expect(parsed.response.id).toBeNull();
		}
	});

	it("rejects a wrong version / missing method but echoes a usable id", () => {
		const parsed = parseRequest({ jsonrpc: "1.0", method: "x", id: 5 });
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.response.error.code).toBe(RpcErrorCode.InvalidRequest);
			expect(parsed.response.id).toBe(5);
		}
	});

	it("rejects a present-but-wrongly-typed id (not coerced to null)", () => {
		for (const badId of [true, {}, [1]]) {
			const parsed = parseRequest({ jsonrpc: "2.0", method: "m", id: badId });
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) {
				expect(parsed.response.error.code).toBe(RpcErrorCode.InvalidRequest);
				expect(parsed.response.id).toBeNull();
			}
		}
	});

	it("accepts an absent id and an explicit null id", () => {
		expect(parseRequest({ jsonrpc: "2.0", method: "m" }).ok).toBe(true);
		expect(parseRequest({ jsonrpc: "2.0", method: "m", id: null }).ok).toBe(
			true,
		);
	});
});

describe("comet/protocol > isNotification", () => {
	it("is true for a well-formed request with no id", () => {
		expect(isNotification({ jsonrpc: "2.0", method: "ping" })).toBe(true);
	});
	it("is false when an id is present", () => {
		expect(isNotification({ jsonrpc: "2.0", method: "ping", id: 1 })).toBe(
			false,
		);
	});
	it("is false for a malformed object", () => {
		expect(isNotification({ method: "ping" })).toBe(false);
		expect(isNotification(null)).toBe(false);
	});
});

describe("comet/protocol > errors + guards", () => {
	it("toRpcError maps a valid error member, else InternalError", () => {
		const e = toRpcError({ code: -32000, message: "boom", data: { x: 1 } });
		expect(e).toBeInstanceOf(RpcError);
		expect([e.code, e.message, e.data]).toEqual([-32000, "boom", { x: 1 }]);
		expect(toRpcError("garbage").code).toBe(RpcErrorCode.InternalError);
	});

	it("isRpcError / isRpcShapedError / isObject narrow correctly", () => {
		expect(isRpcError(new RpcError(-1, "x"))).toBe(true);
		expect(isRpcError(new Error("x"))).toBe(false);
		expect(isRpcShapedError({ code: -32004, message: "not found" })).toBe(true);
		expect(isRpcShapedError({ message: "no code" })).toBe(false);
		expect(isObject({})).toBe(true);
		expect(isObject(null)).toBe(false);
	});

	it("exposes the reserved spec codes", () => {
		expect(RpcErrorCode.MethodNotFound).toBe(-32601);
		expect(RpcErrorCode.InvalidParams).toBe(-32602);
		expect(RpcErrorCode.InternalError).toBe(-32603);
	});
});
