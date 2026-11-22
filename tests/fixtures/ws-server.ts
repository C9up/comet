/**
 * The smallest RFC 6455 server a test needs, on node:http: the handshake,
 * masked client frames (7-, 16- and 64-bit lengths, fragments), text and
 * close, ping answered with pong. Enough to put the platform `WebSocket`
 * client in front of a JSON-RPC peer without depending on ream.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FixtureSocket {
	send(text: string): void;
	/** Cut the TCP connection without a close frame (a network failure). */
	destroy(): void;
	close(code: number, reason?: string): void;
}

export interface FixtureServer {
	url: string;
	/** Sockets currently open. */
	sockets: Set<FixtureSocket>;
	close(): Promise<void>;
}

function frame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	if (length < 126)
		return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
	if (length < 65_536) {
		const head = Buffer.alloc(4);
		head[0] = 0x80 | opcode;
		head[1] = 126;
		head.writeUInt16BE(length, 2);
		return Buffer.concat([head, payload]);
	}
	const head = Buffer.alloc(10);
	head[0] = 0x80 | opcode;
	head[1] = 127;
	head.writeBigUInt64BE(BigInt(length), 2);
	return Buffer.concat([head, payload]);
}

function accept(
	stream: Duplex,
	onMessage: (socket: FixtureSocket, text: string) => void,
	sockets: Set<FixtureSocket>,
): void {
	let buffered = Buffer.alloc(0);
	let fragments: Buffer[] = [];
	const socket: FixtureSocket = {
		send(text) {
			stream.write(frame(0x1, Buffer.from(text, "utf8")));
		},
		destroy() {
			sockets.delete(socket);
			stream.destroy();
		},
		close(code, reason = "") {
			const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
			payload.writeUInt16BE(code, 0);
			payload.write(reason, 2);
			stream.write(frame(0x8, payload));
		},
	};
	sockets.add(socket);
	stream.on("close", () => sockets.delete(socket));
	stream.on("error", () => sockets.delete(socket));
	stream.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		for (;;) {
			if (buffered.length < 2) return;
			const first = buffered[0] ?? 0;
			const second = buffered[1] ?? 0;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffered.length < 4) return;
				length = buffered.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffered.length < 10) return;
				length = Number(buffered.readBigUInt64BE(2));
				offset = 10;
			}
			const masked = (second & 0x80) !== 0;
			const maskAt = offset;
			if (masked) offset += 4;
			if (buffered.length < offset + length) return;
			const payload = Buffer.from(buffered.subarray(offset, offset + length));
			if (masked) {
				for (let i = 0; i < payload.length; i++) {
					payload[i] = (payload[i] ?? 0) ^ (buffered[maskAt + (i % 4)] ?? 0);
				}
			}
			buffered = buffered.subarray(offset + length);
			const opcode = first & 0x0f;
			const fin = (first & 0x80) !== 0;
			if (opcode === 0x8) {
				stream.end(frame(0x8, payload.subarray(0, 2)));
				sockets.delete(socket);
				return;
			}
			if (opcode === 0x9) {
				stream.write(frame(0xa, payload));
				continue;
			}
			if (opcode === 0x1 || opcode === 0x0) {
				fragments.push(payload);
				if (fin) {
					const text = Buffer.concat(fragments).toString("utf8");
					fragments = [];
					onMessage(socket, text);
				}
			}
		}
	});
}

/**
 * Listen on a free port. `refuse` answers the handshake with an HTTP status
 * instead (an auth guard saying no); `onMessage` gets every text message.
 */
export async function startFixtureServer(handlers: {
	onMessage: (socket: FixtureSocket, text: string) => void;
	refuse?: (request: IncomingMessage) => number | undefined;
}): Promise<FixtureServer> {
	const sockets = new Set<FixtureSocket>();
	const server: Server = createServer((_request, response) => {
		response.writeHead(426).end();
	});
	server.on("upgrade", (request, stream: Duplex) => {
		const status = handlers.refuse?.(request);
		if (status !== undefined) {
			stream.end(
				`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
			);
			return;
		}
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			stream.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const answer = createHash("sha1")
			.update(key + GUID)
			.digest("base64");
		stream.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`,
		);
		accept(stream, handlers.onMessage, sockets);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the fixture server has no TCP address");
	}
	return {
		url: `ws://127.0.0.1:${address.port}/rpc`,
		sockets,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
