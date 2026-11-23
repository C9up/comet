import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../src/index.js";

describe("the errors namespace", () => {
	it("is exported from the entry, one flare Exception per code", () => {
		const error = new errors.E_COMET_INVALID_OPTION([
			"timeout",
			"a positive number",
			0,
		]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_COMET_INVALID_OPTION);
		expect(error.code).toBe("E_COMET_INVALID_OPTION");
		expect(error.status).toBe(500);
		expect(error.message).toBe("timeout must be a positive number, got 0");
		expect(new errors.E_COMET_TRANSPORT_CLOSED().message).toBe(
			"the transport is closed",
		);
	});
});
