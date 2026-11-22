/**
 * The transport on the platform `WebSocket` (Node's global one), against a
 * real RFC 6455 server answering JSON-RPC: what the scripted socket cannot
 * show — the handshake, real frames, a refused upgrade, a cut connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRpcClient } from "../src/client.js";
import { isNotification, isObject } from "../src/protocol.js";
import {
	createWebSocketTransport,
	RpcTransportError,
} from "../src/websocket.js";
import {
	type FixtureServer,
	type FixtureSocket,
	startFixtureServer,
} from "./fixtures/ws-server.js";

let server: FixtureServer;
const notified: unknown[] = [];

function answer(socket: FixtureSocket, request: unknown): unknown {
	if (!isObject(request)) return undefined;
	if (isNotification(request)) {
		notified.push(request.params);
		return undefined;
	}
	switch (request.method) {
		case "echo":
			return { jsonrpc: "2.0", id: request.id, result: request.params };
		case "hold":
			return undefined;
		case "drop":
			socket.destroy();
			return undefined;
		default:
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32601, message: "Method not found" },
			};
	}
}

beforeAll(async () => {
	server = await startFixtureServer({
		refuse: (request) => (request.url?.endsWith("?deny") ? 401 : undefined),
		onMessage: (socket, text) => {
			const message: unknown = JSON.parse(text);
			if (Array.isArray(message)) {
				const replies = message
					.map((m) => answer(socket, m))
					.filter((r) => r !== undefined);
				if (replies.length > 0) socket.send(JSON.stringify(replies));
				return;
			}
			const reply = answer(socket, message);
			if (reply !== undefined) socket.send(JSON.stringify(reply));
		},
	});
});

afterAll(async () => {
	await server.close();
});

async function failure(promise: Promise<unknown>): Promise<RpcTransportError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(error instanceof RpcTransportError)) {
		throw new Error(`expected an RpcTransportError, got ${String(error)}`);
	}
	return error;
}

describe("over the platform WebSocket", () => {
	it("calls, notifies and batches over one socket", async () => {
		const transport = createWebSocketTransport();
		const rpc = createRpcClient({ url: server.url, transport });
		try {
			await expect(rpc.call("echo", { text: "héllo 😀" })).resolves.toEqual({
				text: "héllo 😀",
			});
			await rpc.notify("log", ["seen"]);
			const big = "x".repeat(70_000);
			await expect(rpc.call("echo", [big])).resolves.toEqual([big]);
			await expect(
				rpc.batch([
					{ method: "echo", params: [1] },
					{ method: "log", params: ["b"], notify: true },
					{ method: "nope" },
				]),
			).resolves.toMatchObject([
				{ ok: true, value: [1] },
				{ ok: true },
				{ ok: false, error: { code: -32601 } },
			]);
			expect(server.sockets.size).toBe(1);
			expect(notified).toEqual([["seen"], ["b"]]);
		} finally {
			transport.close();
		}
	});

	it("fails the waiting calls when the connection is cut, and opens a new one for the next", async () => {
		const transport = createWebSocketTransport();
		const rpc = createRpcClient({ url: server.url, transport });
		try {
			const held = rpc.call("hold");
			const cut = rpc.call("drop");
			const [heldError, cutError] = await Promise.all([
				failure(held),
				failure(cut),
			]);
			expect(heldError.code).toBe("E_COMET_CONNECTION_CLOSED");
			expect(cutError.code).toBe("E_COMET_CONNECTION_CLOSED");
			await expect(rpc.call("echo", ["again"])).resolves.toEqual(["again"]);
		} finally {
			transport.close();
		}
	});

	it("reports a refused handshake as a failed connection", async () => {
		const transport = createWebSocketTransport();
		const rpc = createRpcClient({ url: `${server.url}?deny`, transport });
		const error = await failure(rpc.call("echo"));
		expect(error.code).toBe("E_COMET_CONNECTION_FAILED");
		transport.close();
	});

	it("reports a URL the platform cannot open", async () => {
		const transport = createWebSocketTransport();
		const rpc = createRpcClient({ url: "/rpc", transport });
		const error = await failure(rpc.call("echo"));
		expect(error.code).toBe("E_COMET_CONNECTION_FAILED");
		transport.close();
	});

	it("times a call out over a live socket", async () => {
		const transport = createWebSocketTransport({ timeout: 50 });
		const rpc = createRpcClient({ url: server.url, transport });
		const error = await failure(rpc.call("hold"));
		expect(error.code).toBe("E_COMET_TIMEOUT");
		await expect(rpc.call("echo", [1])).resolves.toEqual([1]);
		transport.close();
	});
});
