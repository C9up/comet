/**
 * The WebSocket transport against a scripted socket: what it sends, how it
 * pairs answers with callers, and what it does when the peer, the network or
 * the caller lets it down.
 */
import { Exception } from "@c9up/flare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcClient } from "../src/client.js";
import * as errors from "../src/errors.js";
import {
	buildNotification,
	isRpcShapedError,
	RpcRemoteError,
} from "../src/protocol.js";
import {
	createWebSocketTransport,
	type RpcSocket,
	type WebSocketTransportOptions,
} from "../src/websocket.js";

type Listener = (event: never) => void;

class FakeSocket implements RpcSocket {
	readyState = 0;
	bufferedAmount = 0;
	readonly sent: string[] = [];
	closedWith: { code?: number; reason?: string } | undefined;
	sendThrows = false;
	readonly #listeners = new Map<string, Listener[]>();

	constructor(readonly url: string) {}

	send(data: string): void {
		if (this.sendThrows) throw new Error("socket refused the frame");
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closedWith = { code, reason };
		this.readyState = 3;
	}

	addEventListener(type: string, listener: Listener): void {
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}

	#emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) {
			Reflect.apply(listener, undefined, [event]);
		}
	}

	open(): void {
		this.readyState = 1;
		this.#emit("open", {});
	}

	receive(data: unknown): void {
		this.#emit("message", { data });
	}

	drop(code = 1006, reason = ""): void {
		this.readyState = 3;
		this.#emit("error", {});
		this.#emit("close", { code, reason });
	}

	/** The messages sent so far, parsed. */
	messages(): unknown[] {
		return this.sent.map((text) => JSON.parse(text));
	}

	/** The last message sent, parsed, as a record. */
	last(): Record<string, unknown> {
		const message: unknown = JSON.parse(this.sent.at(-1) ?? "null");
		if (
			typeof message !== "object" ||
			message === null ||
			Array.isArray(message)
		) {
			throw new Error("the last message is not an object");
		}
		return Object.fromEntries(Object.entries(message));
	}
}

let sockets: FakeSocket[] = [];

function setup(options: WebSocketTransportOptions = {}) {
	const transport = createWebSocketTransport({
		createSocket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		...options,
	});
	const rpc = createRpcClient({ url: "ws://app.test/rpc", transport });
	return { transport, rpc };
}

function socket(index = -1): FakeSocket {
	const found = sockets.at(index);
	if (found === undefined) throw new Error("no socket opened");
	return found;
}

/** Let the transport's microtasks (open → send) run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function reply(to: FakeSocket, id: unknown, result: unknown): void {
	to.receive(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function failure(promise: Promise<unknown>): Promise<Exception> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(error instanceof Exception) || !error.code?.startsWith("E_COMET_")) {
		throw new Error(`expected a comet transport error, got ${String(error)}`);
	}
	return error;
}

beforeEach(() => {
	sockets = [];
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("one socket per endpoint", () => {
	it("opens on the first call, sends once open, and answers the caller", async () => {
		const { rpc } = setup();
		expect(sockets).toHaveLength(0);
		const answer = rpc.call("math.sum", [1, 2]);
		await flush();
		expect(socket().url).toBe("ws://app.test/rpc");
		expect(socket().sent).toHaveLength(0);
		socket().open();
		await flush();
		expect(socket().last()).toMatchObject({
			jsonrpc: "2.0",
			method: "math.sum",
			params: [1, 2],
		});
		reply(socket(), socket().last().id, 3);
		await expect(answer).resolves.toBe(3);
	});

	it("keeps one socket for every call to the same URL", async () => {
		const { rpc } = setup();
		const a = rpc.call("a");
		const b = rpc.call("b");
		socket().open();
		await flush();
		expect(sockets).toHaveLength(1);
		const [first, second] = socket().messages();
		reply(socket(), Reflect.get(Object(second), "id"), "B");
		reply(socket(), Reflect.get(Object(first), "id"), "A");
		await expect(a).resolves.toBe("A");
		await expect(b).resolves.toBe("B");
	});

	it("gives two clients sharing it distinct ids on the wire, and each its own answer", async () => {
		const { transport } = setup();
		const one = createRpcClient({ url: "ws://app.test/rpc", transport });
		const two = createRpcClient({ url: "ws://app.test/rpc", transport });
		const a = one.call("who");
		const b = two.call("who");
		socket().open();
		await flush();
		const ids = socket()
			.messages()
			.map((m) => Reflect.get(Object(m), "id"));
		expect(new Set(ids).size).toBe(2);
		reply(socket(), ids[1], "two");
		reply(socket(), ids[0], "one");
		await expect(a).resolves.toBe("one");
		await expect(b).resolves.toBe("two");
	});

	it("gives the caller's own id back, a string one included", async () => {
		const { transport } = setup();
		const answer = transport(
			"ws://x",
			{ jsonrpc: "2.0", id: "mine", method: "m" },
			{},
		);
		socket().open();
		await flush();
		expect(socket().last().id).not.toBe("mine");
		reply(socket(), socket().last().id, true);
		await expect(answer).resolves.toEqual({
			jsonrpc: "2.0",
			id: "mine",
			result: true,
		});
	});

	it("uses a socket already open when created", async () => {
		const transport = createWebSocketTransport({
			createSocket: (url) => {
				const s = new FakeSocket(url);
				s.readyState = 1;
				sockets.push(s);
				return s;
			},
		});
		const rpc = createRpcClient({ url: "ws://x", transport });
		const answer = rpc.call("m");
		await flush();
		reply(socket(), socket().last().id, 1);
		await expect(answer).resolves.toBe(1);
		socket().drop(1001, "going away");
		const after = rpc.call("m");
		await flush();
		expect(sockets).toHaveLength(2);
		socket().drop();
		expect((await failure(after)).code).toBe("E_COMET_CONNECTION_CLOSED");
	});
});

describe("notifications and batches", () => {
	it("resolves a notification once sent, without waiting for an answer", async () => {
		const { rpc } = setup();
		const sent = rpc.notify("audit.log", { event: "login" });
		socket().open();
		await expect(sent).resolves.toBeUndefined();
		expect(socket().last()).toEqual({
			jsonrpc: "2.0",
			method: "audit.log",
			params: { event: "login" },
		});
	});

	it("matches a batch response in any order, and resolves an all-notification batch", async () => {
		const { rpc } = setup();
		const results = rpc.batch([
			{ method: "a" },
			{ method: "log", notify: true },
			{ method: "b" },
		]);
		socket().open();
		await flush();
		const [message] = socket().messages();
		if (!Array.isArray(message)) throw new Error("not a batch");
		expect(message).toHaveLength(3);
		const [a, log, b] = message.map((m: unknown) => Object(m));
		expect(Object.hasOwn(log, "id")).toBe(false);
		socket().receive(
			JSON.stringify([
				{ jsonrpc: "2.0", id: Reflect.get(b, "id"), result: "B" },
				{ jsonrpc: "2.0", id: Reflect.get(a, "id"), result: "A" },
			]),
		);
		await expect(results).resolves.toEqual([
			{ ok: true, value: "A" },
			{ ok: true, value: undefined },
			{ ok: true, value: "B" },
		]);
		await expect(
			rpc.batch([
				{ method: "x", notify: true },
				{ method: "y", notify: true },
			]),
		).resolves.toEqual([
			{ ok: true, value: undefined },
			{ ok: true, value: undefined },
		]);
	});
});

describe("nothing waits forever", () => {
	it("times a call out, and drops the answer that comes too late", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: 100 });
		const answer = rpc.call("slow");
		socket().open();
		await flush();
		const id = socket().last().id;
		vi.advanceTimersByTime(100);
		const error = await failure(answer);
		expect(error.code).toBe("E_COMET_TIMEOUT");
		expect(error.message).toBe("no answer within 100 ms");
		expect(() => reply(socket(), id, "late")).not.toThrow();
		expect(socket().closedWith).toBeUndefined();
	});

	it("counts the time spent connecting", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: 50 });
		const answer = rpc.call("m");
		vi.advanceTimersByTime(50);
		expect((await failure(answer)).code).toBe("E_COMET_TIMEOUT");
		socket().open();
		await flush();
		expect(socket().sent).toHaveLength(0);
	});

	it("waits without a timer when the timeout is Infinity", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: Number.POSITIVE_INFINITY });
		const answer = rpc.call("m");
		socket().open();
		await flush();
		vi.advanceTimersByTime(10 * 60_000);
		reply(socket(), socket().last().id, "still here");
		await expect(answer).resolves.toBe("still here");
	});

	it("rejects an aborted call with the signal's reason, and sends nothing for one aborted before", async () => {
		const { rpc } = setup();
		const controller = new AbortController();
		const answer = rpc.call("m", undefined, { signal: controller.signal });
		socket().open();
		await flush();
		controller.abort(new Error("unmounted"));
		await expect(answer).rejects.toThrow("unmounted");
		const before = new AbortController();
		before.abort(new Error("too late"));
		await expect(
			rpc.call("n", undefined, { signal: before.signal }),
		).rejects.toThrow("too late");
		expect(socket().sent).toHaveLength(1);
	});

	it("fails every waiting call when the socket drops, and reconnects on the next call", async () => {
		const { rpc } = setup();
		const a = rpc.call("a");
		const b = rpc.batch([{ method: "b" }]);
		socket().open();
		await flush();
		socket().drop(1006, "network");
		const [ea, eb] = await Promise.all([failure(a), failure(b)]);
		expect(ea.code).toBe("E_COMET_CONNECTION_CLOSED");
		expect(ea.message).toContain("1006 network");
		expect(eb.code).toBe("E_COMET_CONNECTION_CLOSED");
		const c = rpc.call("c");
		expect(sockets).toHaveLength(2);
		socket().open();
		await flush();
		reply(socket(), socket().last().id, "C");
		await expect(c).resolves.toBe("C");
	});

	it("stays closed after a drop when reconnect is off", async () => {
		const { rpc } = setup({ reconnect: false });
		const a = rpc.call("a");
		socket().open();
		await flush();
		socket().drop();
		expect((await failure(a)).code).toBe("E_COMET_CONNECTION_CLOSED");
		const error = await failure(rpc.call("b"));
		expect(error.code).toBe("E_COMET_CONNECTION_CLOSED");
		expect(error.message).toContain("reconnect is off");
		expect(sockets).toHaveLength(1);
	});

	it("reports a socket that never opens, and one that cannot be created", async () => {
		const { rpc } = setup();
		const answer = rpc.call("m");
		socket().drop(1006);
		expect((await failure(answer)).code).toBe("E_COMET_CONNECTION_FAILED");
		const broken = createRpcClient({
			url: "nope",
			transport: createWebSocketTransport({
				createSocket: () => {
					throw new SyntaxError("Invalid URL");
				},
			}),
		});
		const error = await failure(broken.call("m"));
		expect(error.code).toBe("E_COMET_CONNECTION_FAILED");
		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it("says so when the platform has no WebSocket", async () => {
		vi.stubGlobal("WebSocket", undefined);
		const rpc = createRpcClient({
			url: "ws://x",
			transport: createWebSocketTransport(),
		});
		const error = await failure(rpc.call("m"));
		expect(error.code).toBe("E_COMET_CONNECTION_FAILED");
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	it("fails a call whose frame the socket refuses", async () => {
		const { rpc } = setup();
		const answer = rpc.call("m");
		socket().sendThrows = true;
		socket().open();
		expect((await failure(answer)).code).toBe("E_COMET_CONNECTION_CLOSED");
	});
});

describe("a peer that breaks the protocol loses the socket", () => {
	const cases: Array<[string, (s: FakeSocket, id: unknown) => void, string]> = [
		[
			"a binary frame",
			(s) => s.receive(new Uint8Array([1, 2])),
			"binary frame",
		],
		["text that is not JSON", (s) => s.receive("{nope"), "not JSON"],
		[
			"JSON that is not a message",
			(s) => s.receive("42"),
			"neither an object nor an array",
		],
		[
			"a single request answered by a batch",
			(s, id) => s.receive(JSON.stringify([{ jsonrpc: "2.0", id, result: 1 }])),
			"single request with a batch",
		],
	];
	for (const [what, send, says] of cases) {
		it(`closes on ${what}, failing what waited`, async () => {
			const { rpc } = setup();
			const answer = rpc.call("m");
			socket().open();
			await flush();
			send(socket(), socket().last().id);
			const error = await failure(answer);
			expect(error.code).toBe("E_COMET_PROTOCOL_ERROR");
			expect(error.message).toContain(says);
			expect(socket().closedWith).toEqual({
				code: 4002,
				reason: "comet: malformed answer",
			});
			// A late frame on the dead socket changes nothing.
			expect(() => socket().receive("{nope")).not.toThrow();
		});
	}

	it("closes when a batch entry is answered on its own", async () => {
		const { rpc } = setup();
		const results = rpc.batch([{ method: "a" }, { method: "b" }]);
		socket().open();
		await flush();
		const [first] = socket().messages();
		const id = Array.isArray(first)
			? Reflect.get(Object(first[0]), "id")
			: undefined;
		reply(socket(), id, "A");
		expect((await failure(results)).code).toBe("E_COMET_PROTOCOL_ERROR");
	});

	it("closes when one response answers two batches", async () => {
		const { rpc } = setup();
		const one = rpc.batch([{ method: "a" }]);
		const two = rpc.batch([{ method: "b" }]);
		socket().open();
		await flush();
		const ids = socket()
			.messages()
			.map((m) =>
				Array.isArray(m) ? Reflect.get(Object(m[0]), "id") : undefined,
			);
		socket().receive(
			JSON.stringify(ids.map((id) => ({ jsonrpc: "2.0", id, result: 0 }))),
		);
		expect((await failure(one)).code).toBe("E_COMET_PROTOCOL_ERROR");
		expect((await failure(two)).code).toBe("E_COMET_PROTOCOL_ERROR");
	});

	it("leaves a stray id in a batch response for the client to report", async () => {
		const { rpc } = setup();
		const results = rpc.batch([{ method: "a" }, { method: "b" }]);
		socket().open();
		await flush();
		const [message] = socket().messages();
		const first = Array.isArray(message)
			? Reflect.get(Object(message[0]), "id")
			: undefined;
		socket().receive(
			JSON.stringify([
				{ jsonrpc: "2.0", id: first, result: "A" },
				{ jsonrpc: "2.0", id: 999, result: "stray" },
				"junk",
			]),
		);
		const [a, b] = await results;
		expect(a).toEqual({ ok: true, value: "A" });
		expect(b?.ok).toBe(false);
		expect(b?.ok === false && b.error.message).toBe('No response for "b"');
	});

	it("drops answers nobody waits for: unknown ids, repeated ones, odd ids", async () => {
		const { rpc } = setup();
		const answer = rpc.call("m");
		socket().open();
		await flush();
		const id = socket().last().id;
		reply(socket(), 999, "stray");
		reply(socket(), "text-id", "stray");
		socket().receive(
			JSON.stringify([{ jsonrpc: "2.0", id: 999, result: 0 }, 7]),
		);
		reply(socket(), id, "mine");
		reply(socket(), id, "again");
		await expect(answer).resolves.toBe("mine");
		expect(socket().closedWith).toBeUndefined();
	});
});

describe("sizes are bounded both ways", () => {
	it("refuses to send a message over maxMessageBytes, counting UTF-8 bytes", async () => {
		const exact = new TextEncoder().encode(
			JSON.stringify(buildNotification("m", ["é".repeat(10)])),
		).length;
		const { rpc } = setup({ maxMessageBytes: exact });
		const fits = rpc.notify("m", ["é".repeat(10)]);
		socket().open();
		await expect(fits).resolves.toBeUndefined();
		const over = await failure(rpc.notify("m", ["é".repeat(11)]));
		expect(over.code).toBe("E_COMET_MESSAGE_TOO_LARGE");
		expect(socket().sent).toHaveLength(1);
	});

	it("closes on a received message over maxMessageBytes", async () => {
		const { rpc } = setup({ maxMessageBytes: 64 });
		const answer = rpc.call("m");
		socket().open();
		await flush();
		const id = socket().last().id;
		const envelope = (text: string) =>
			JSON.stringify({ jsonrpc: "2.0", id, result: text });
		// Astral characters are four bytes; a lone surrogate is three.
		socket().receive(envelope(`${"😀".repeat(9)}\ud800`));
		const error = await failure(answer);
		expect(error.code).toBe("E_COMET_MESSAGE_TOO_LARGE");
		expect(socket().closedWith).toEqual({
			code: 4009,
			reason: "comet: message too large",
		});
	});

	it("counts a lone surrogate as three bytes wherever it stands", async () => {
		const { rpc } = setup({ maxMessageBytes: 64 });
		const answer = rpc.call("m");
		socket().open();
		await flush();
		const id = socket().last().id;
		const value = `${"\ud800a".repeat(4)}€\udc00`;
		const message = `{"jsonrpc":"2.0","id":${String(id)},"result":"${value}"}`;
		// Each "\ud800a" is 3 + 1 bytes (read as a surrogate pair it would be 4,
		// the "a" lost from the count), "€" and a lone low surrogate 3 each.
		expect(message.length).toBeLessThan(64);
		socket().receive(message);
		await expect(answer).resolves.toBe(value);
	});

	it("accepts a received message exactly at the limit", async () => {
		const { rpc } = setup({ maxMessageBytes: 64 });
		const answer = rpc.call("m");
		socket().open();
		await flush();
		const id = socket().last().id;
		const head = JSON.stringify({ jsonrpc: "2.0", id, result: "" });
		const room = 64 - new TextEncoder().encode(head).length;
		const text = `${"ab".repeat(Math.floor(room / 2) - 1)}é`;
		const message = JSON.stringify({ jsonrpc: "2.0", id, result: text });
		expect(new TextEncoder().encode(message).length).toBe(64);
		socket().receive(message);
		await expect(answer).resolves.toBe(text);
	});

	it("refuses a send while too much waits in the socket's buffer", async () => {
		const { rpc } = setup({ maxBufferedBytes: 10 });
		const answer = rpc.call("m");
		socket().bufferedAmount = 11;
		socket().open();
		expect((await failure(answer)).code).toBe("E_COMET_BACKPRESSURE");
		expect(socket().sent).toHaveLength(0);
	});
});

describe("an error with a null id", () => {
	const refusal = JSON.stringify({
		jsonrpc: "2.0",
		id: null,
		error: { code: -32600, message: "Batch too large (max 50)" },
	});

	it("is the answer of the one call waiting", async () => {
		const { rpc } = setup();
		const answer = rpc.batch([{ method: "a" }]);
		socket().open();
		await flush();
		socket().receive(refusal);
		const error = await answer.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(RpcRemoteError);
		expect(error instanceof RpcRemoteError && error.code).toBe(-32600);
	});

	it("is kept on every call waiting when several are, and reported by the timeout", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: 100 });
		const a = rpc.call("a");
		const b = rpc.call("b");
		socket().open();
		await flush();
		const [first] = socket().messages();
		socket().receive(refusal);
		reply(socket(), Reflect.get(Object(first), "id"), "A");
		await expect(a).resolves.toBe("A");
		vi.advanceTimersByTime(100);
		const error = await failure(b);
		expect(error.code).toBe("E_COMET_TIMEOUT");
		expect(error.message).toContain("-32600 Batch too large (max 50)");
		expect(error.cause).toEqual(JSON.parse(refusal));
	});

	it("is not taken for a call's answer while a notification's refusal may still arrive", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: 100 });
		const notified = rpc.notify("log");
		socket().open();
		await flush();
		await notified;
		const answer = rpc.call("m");
		await flush();
		socket().receive(JSON.stringify([JSON.parse(refusal)]));
		vi.advanceTimersByTime(100);
		const error = await failure(answer);
		expect(error.code).toBe("E_COMET_TIMEOUT");
		expect(error.message).toContain("could not attribute (-32600");
	});

	it("is dropped when nothing waits, and pairs a batch of unreadable entries with the one batch", async () => {
		const { rpc } = setup();
		const first = rpc.notify("log");
		socket().open();
		await first;
		expect(() => socket().receive(refusal)).not.toThrow();
		const transport = createWebSocketTransport({
			createSocket: (url) => {
				const s = new FakeSocket(url);
				sockets.push(s);
				return s;
			},
		});
		const batch = createRpcClient({ url: "ws://y", transport }).batch([
			{ method: "a" },
		]);
		socket().open();
		await flush();
		socket().receive(JSON.stringify([JSON.parse(refusal)]));
		const [entry] = await batch;
		expect(entry?.ok).toBe(false);
		socket().receive(JSON.stringify([{ id: null, error: {} }, { id: null }]));
		socket().receive("[]");
	});

	it("reports a kept refusal without a readable message as such", async () => {
		vi.useFakeTimers();
		const { rpc } = setup({ timeout: 10 });
		const a = rpc.call("a");
		const b = rpc.call("b");
		socket().open();
		await flush();
		socket().receive(
			JSON.stringify({ jsonrpc: "2.0", id: null, error: "nope" }),
		);
		vi.advanceTimersByTime(10);
		const [ea] = await Promise.all([failure(a), failure(b)]);
		expect(ea.message).toBe(
			"no answer within 10 ms; meanwhile the server refused a message it could not attribute",
		);
	});
});

describe("close() and what the caller hands over", () => {
	it("closes every socket, fails what waits, and refuses later calls", async () => {
		const { transport, rpc } = setup();
		const a = rpc.call("a");
		const other = createRpcClient({ url: "ws://other", transport }).call("b");
		socket(0).open();
		await flush();
		transport.close();
		transport.close();
		expect((await failure(a)).code).toBe("E_COMET_TRANSPORT_CLOSED");
		expect((await failure(other)).code).toBe("E_COMET_TRANSPORT_CLOSED");
		expect(socket(0).closedWith).toEqual({ code: 1000, reason: "" });
		expect(socket(1).closedWith).toEqual({ code: 1000, reason: "" });
		expect((await failure(rpc.call("c"))).code).toBe(
			"E_COMET_TRANSPORT_CLOSED",
		);
	});

	it("sends nothing on a socket that opens after close()", async () => {
		const { transport, rpc } = setup();
		const a = rpc.call("a");
		transport.close();
		socket().open();
		await flush();
		expect((await failure(a)).code).toBe("E_COMET_TRANSPORT_CLOSED");
		expect(socket().sent).toHaveLength(0);
	});

	it("survives a socket whose close throws", async () => {
		const { transport, rpc } = setup();
		const a = rpc.call("a");
		socket().close = () => {
			throw new Error("already closing");
		};
		transport.close();
		expect((await failure(a)).code).toBe("E_COMET_TRANSPORT_CLOSED");
	});

	it("refuses what is not a JSON-RPC message or not JSON", async () => {
		const { transport, rpc } = setup();
		const invalid = async (body: unknown) =>
			(await failure(transport("ws://x", body, {}))).code;
		expect(await invalid(42)).toBe("E_COMET_INVALID_MESSAGE");
		expect(await invalid([])).toBe("E_COMET_INVALID_MESSAGE");
		expect(await invalid([1])).toBe("E_COMET_INVALID_MESSAGE");
		expect(await invalid({ jsonrpc: "2.0", id: {}, method: "m" })).toBe(
			"E_COMET_INVALID_MESSAGE",
		);
		const error = await failure(rpc.call("m", { n: 1n }));
		expect(error.code).toBe("E_COMET_INVALID_MESSAGE");
		expect(error.cause).toBeInstanceOf(TypeError);
		expect(sockets).toHaveLength(0);
	});

	it("refuses options it cannot honour", () => {
		const invalid = expect.objectContaining({ code: "E_COMET_INVALID_OPTION" });
		for (const timeout of [0, -1, Number.NaN, 2 ** 31]) {
			expect(() => createWebSocketTransport({ timeout })).toThrow(invalid);
		}
		expect(() => createWebSocketTransport({ maxMessageBytes: 0 })).toThrow(
			invalid,
		);
		expect(() => createWebSocketTransport({ maxBufferedBytes: -5 })).toThrow(
			invalid,
		);
		expect(() => createWebSocketTransport({ timeout: 0 })).toThrow(
			expect.objectContaining({ code: "E_COMET_INVALID_OPTION" }),
		);
		expect(() => createWebSocketTransport({ timeout: 2 ** 31 })).toThrow(
			expect.objectContaining({ code: "E_COMET_INVALID_OPTION" }),
		);
		expect(() =>
			createWebSocketTransport({ timeout: Number.POSITIVE_INFINITY }),
		).not.toThrow();
	});

	it("is a transport error, never mistaken for a JSON-RPC one", () => {
		const error = new errors.E_COMET_TIMEOUT([5, ""]);
		expect(error.message).toBe("no answer within 5 ms");
		expect(error).toBeInstanceOf(Exception);
		expect(error).not.toBeInstanceOf(RpcRemoteError);
		expect(isRpcShapedError(error)).toBe(false);
	});
});
