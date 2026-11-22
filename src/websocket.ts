/**
 * A WebSocket transport for the JSON-RPC client: one socket per endpoint URL,
 * carrying every request, notification and batch the client sends there, with
 * each response matched to its caller by id.
 *
 *   const socket = createWebSocketTransport();
 *   const rpc = createRpcClient({ url: "wss://app.test/rpc", transport: socket });
 *   await rpc.call("task.validate", { id });
 *   socket.close();
 *
 * It runs on the platform `WebSocket` — the browser's, or Node's global one
 * (Node 24 and later). `createSocket` replaces it, to pass what the standard
 * constructor cannot (Node's `headers`, a proxy dispatcher) or to test.
 *
 * What a socket changes, and what this does about it:
 *
 * - **Ids are the only correlation.** Over HTTP each response comes back on
 *   its own request; here every response arrives on the same socket. Two
 *   clients sharing this transport each count their ids from 1, so the
 *   transport puts its own id on every request it sends and gives the
 *   caller's back on the response: no two live requests on a socket ever
 *   carry the same id, whoever sent them.
 * - **Nothing waits forever.** Every call has a timeout (30 s unless set), and
 *   a socket that closes or fails rejects every call still waiting on it with
 *   a {@link RpcTransportError}. The next call opens a new socket, unless
 *   `reconnect: false`.
 * - **A peer that breaks the protocol loses the socket.** A frame that is not
 *   text, not JSON, larger than `maxMessageBytes`, or that answers in a shape
 *   no request on the socket can have asked for (a batch answered by single
 *   objects, two batches merged) closes the socket and fails what was
 *   waiting on it: a connection that has sent one wrong answer cannot be
 *   trusted to pair the next one. An answer to an id nobody waits for any
 *   more — one that arrived after its call timed out — is dropped.
 * - **An error with a null id** (a server that could not read a request's id,
 *   or refused a batch as a whole) names no request. It is a request's answer
 *   only when that request is the one message on the socket that could have
 *   drawn it: the only one waiting, with no notification sent within the
 *   timeout before (a server may refuse a notification the same way, and
 *   that refusal can arrive at any time until then). Otherwise it is kept on
 *   every call waiting at that moment, and the one it belonged to reports it
 *   when it times out.
 * - **Sizes are bounded both ways.** A message larger than `maxMessageBytes`
 *   is refused before it is sent, and a send is refused while more than
 *   `maxBufferedBytes` wait in the socket's buffer. An incoming message is
 *   measured once the platform has received it: the WebSocket API gives no
 *   way to refuse a frame earlier.
 */

import type { RpcTransport } from "./client.js";
import { isObject, type JsonRpcId } from "./protocol.js";

/** Why a call over the socket failed without a JSON-RPC answer. */
export type RpcTransportErrorCode =
	/** The socket could not be opened (refused handshake, bad URL, network). */
	| "E_COMET_CONNECTION_FAILED"
	/** The socket closed while the call waited, or stays closed (`reconnect: false`). */
	| "E_COMET_CONNECTION_CLOSED"
	/** `close()` was called on the transport. */
	| "E_COMET_TRANSPORT_CLOSED"
	/** No answer within the timeout. */
	| "E_COMET_TIMEOUT"
	/** A message over `maxMessageBytes`, sent or received. */
	| "E_COMET_MESSAGE_TOO_LARGE"
	/** More than `maxBufferedBytes` already wait to be sent. */
	| "E_COMET_BACKPRESSURE"
	/** The peer sent what no JSON-RPC server answers: the socket was closed. */
	| "E_COMET_PROTOCOL_ERROR"
	/** The client handed over something that is not a JSON-RPC message, or not JSON. */
	| "E_COMET_INVALID_MESSAGE";

/**
 * A failure of the transport itself, not an answer from the server. Its `code`
 * is a string, so `isRpcShapedError` never mistakes it for a JSON-RPC error
 * that a server handler could forward.
 */
export class RpcTransportError extends Error {
	readonly code: RpcTransportErrorCode;

	constructor(
		code: RpcTransportErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "RpcTransportError";
		this.code = code;
	}
}

/**
 * What the transport needs of a socket — the standard `WebSocket` has it.
 * Methods, not function-valued properties, so the platform class (whose event
 * types are richer) fits. No `error` listener: the standard fires `close`
 * after every `error`, and `close` is where a socket's end is handled.
 */
export interface RpcSocket {
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "close",
		listener: (event: { code: number; reason: string }) => void,
	): void;
}

export interface WebSocketTransportOptions {
	/**
	 * Opens a socket to `url`. Default: the platform `WebSocket`, with
	 * `protocols`. Replace it to pass what the standard constructor cannot —
	 * `(url) => new WebSocket(url, { headers })` in Node.
	 */
	createSocket?: (url: string) => RpcSocket;
	/** Subprotocols offered by the default `createSocket`. */
	protocols?: string | string[];
	/**
	 * How long a call waits for its answer, connecting included, in ms.
	 * Default 30 000. `Infinity` waits as long as the socket stays open.
	 */
	timeout?: number;
	/** Largest message sent or accepted, in UTF-8 bytes. Default 1 MiB. */
	maxMessageBytes?: number;
	/** Bytes the socket may hold unsent before a send is refused. Default 4 MiB. */
	maxBufferedBytes?: number;
	/** Open a new socket on the next call after one closed. Default true. */
	reconnect?: boolean;
}

/** A transport for {@link createRpcClient}, with the sockets it opened to close. */
export type RpcWebSocketTransport = RpcTransport & {
	/**
	 * Close every socket (code 1000) and fail what still waits with
	 * `E_COMET_TRANSPORT_CLOSED`. Calls made afterwards fail the same way.
	 */
	close(): void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** setTimeout's largest delay; anything above fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const OPEN = 1;
/**
 * Close codes a client may send are 1000 and 3000-4999 (the WebSocket API
 * throws on any other). These two say why this side gave up on the peer.
 */
const CLOSE_PROTOCOL = 4002;
const CLOSE_TOO_LARGE = 4009;

function positive(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
		throw new RangeError(
			`${name} must be a positive number, got ${String(value)}`,
		);
	}
	return value;
}

/** UTF-8 length of `text`, without encoding it. */
function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** A message ready to go: its text, and the ids it carries (wire id → caller's id). */
interface Outgoing {
	text: string;
	ids: Map<number, JsonRpcId>;
	batch: boolean;
}

/** One message waiting on a socket: settled once, by an answer or a failure. */
interface Waiting {
	readonly ids: Map<number, JsonRpcId>;
	readonly batch: boolean;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	/** An id-null error that arrived while this waited with others. */
	suspect: Unattributed | undefined;
}

/** An answer naming no request, and the error member it carried. */
interface Unattributed {
	readonly message: unknown;
	readonly error: unknown;
}

function defaultSocket(protocols: string | string[] | undefined) {
	return (url: string): RpcSocket => {
		const Platform: unknown = Reflect.get(globalThis, "WebSocket");
		if (typeof Platform !== "function") {
			throw new TypeError(
				"no WebSocket on this platform: pass createSocket (Node 24 and browsers have one)",
			);
		}
		return new WebSocket(url, protocols);
	};
}

/** One socket and the messages waiting on it. */
class Connection {
	readonly #socket: RpcSocket;
	readonly #waiting = new Set<Waiting>();
	/** Every wire id waiting, with its message and the caller's own id. */
	readonly #byId = new Map<number, { waiting: Waiting; original: JsonRpcId }>();
	readonly #maxMessageBytes: number;
	/** How long after a notification its refusal may still arrive, in ms. */
	readonly #notificationWindow: number;
	readonly #onDead: () => void;
	readonly opened: Promise<void>;
	#state: "connecting" | "open" | "closed" = "connecting";
	/** When the last notification-only message went out, on `performance.now()`. */
	#lastNotification = Number.NEGATIVE_INFINITY;

	constructor(
		socket: RpcSocket,
		maxMessageBytes: number,
		notificationWindow: number,
		onDead: () => void,
	) {
		this.#socket = socket;
		this.#maxMessageBytes = maxMessageBytes;
		this.#notificationWindow = notificationWindow;
		this.#onDead = onDead;
		// Listeners go on inside the executor, which runs at once: the promise's
		// own resolve and reject, nothing to hold in a variable meanwhile.
		this.opened = new Promise<void>((resolve, reject) => {
			if (socket.readyState === OPEN) {
				this.#state = "open";
				resolve();
			}
			socket.addEventListener("open", () => {
				if (this.#state !== "connecting") return;
				this.#state = "open";
				resolve();
			});
			socket.addEventListener("close", (event) => {
				const what = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
				const error =
					this.#state === "open"
						? new RpcTransportError(
								"E_COMET_CONNECTION_CLOSED",
								`the socket closed (${what}) before the answer came`,
							)
						: new RpcTransportError(
								"E_COMET_CONNECTION_FAILED",
								`the socket could not be opened (${what})`,
							);
				reject(error);
				this.#die(error);
			});
		});
		// A failed open is reported to each call through its own waiting entry;
		// nobody else awaits this promise, so its rejection must not go unheard.
		this.opened.catch(() => {});
		socket.addEventListener("message", (event) => {
			this.#receive(event.data);
		});
	}

	get closed(): boolean {
		return this.#state === "closed";
	}

	get bufferedAmount(): number {
		return this.#socket.bufferedAmount;
	}

	/** Wait for the answer to `outgoing`'s requests. */
	wait(waiting: Waiting): void {
		this.#waiting.add(waiting);
		for (const [id, original] of waiting.ids) {
			this.#byId.set(id, { waiting, original });
		}
	}

	/** Stop waiting (settled, timed out, aborted). */
	release(waiting: Waiting): void {
		this.#waiting.delete(waiting);
		for (const id of waiting.ids.keys()) this.#byId.delete(id);
	}

	send(text: string, notificationOnly: boolean): void {
		this.#socket.send(text);
		if (notificationOnly) this.#lastNotification = performance.now();
	}

	/** Close the socket and fail every message waiting on it. */
	shut(code: number, reason: string, error: RpcTransportError): void {
		this.#die(error);
		try {
			this.#socket.close(code, reason);
		} catch {
			// Already closing: the socket is gone either way.
		}
	}

	#die(error: RpcTransportError): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		this.#onDead();
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		this.#byId.clear();
		for (const entry of waiting) entry.reject(error);
	}

	#violation(message: string): void {
		this.shut(
			CLOSE_PROTOCOL,
			"comet: malformed answer",
			new RpcTransportError("E_COMET_PROTOCOL_ERROR", message),
		);
	}

	#receive(data: unknown): void {
		if (this.#state === "closed") return;
		if (typeof data !== "string") {
			this.#violation("the peer sent a binary frame; JSON-RPC travels as text");
			return;
		}
		// A string of n UTF-16 units is at most 3n UTF-8 bytes: only a long one
		// is worth measuring.
		if (
			data.length * 3 > this.#maxMessageBytes &&
			utf8Length(data) > this.#maxMessageBytes
		) {
			this.shut(
				CLOSE_TOO_LARGE,
				"comet: message too large",
				new RpcTransportError(
					"E_COMET_MESSAGE_TOO_LARGE",
					`the peer sent a message over ${this.#maxMessageBytes} bytes`,
				),
			);
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(data);
		} catch {
			this.#violation("the peer sent a message that is not JSON");
			return;
		}
		if (Array.isArray(message)) this.#receiveBatch(message);
		else if (isObject(message)) this.#receiveOne(message);
		else
			this.#violation(
				"the peer sent JSON that is neither an object nor an array",
			);
	}

	#receiveOne(message: Record<string, unknown>): void {
		const id = message.id;
		if (id === null) {
			this.#unattributed({ message, error: message.error });
			return;
		}
		if (typeof id !== "number") return;
		const entry = this.#byId.get(id);
		if (entry === undefined) return;
		const { waiting, original } = entry;
		if (waiting.batch) {
			this.#violation(
				"the peer answered a batch entry outside a batch response",
			);
			return;
		}
		waiting.resolve({ ...message, id: original });
	}

	#receiveBatch(items: unknown[]): void {
		let owner: Waiting | undefined;
		for (const item of items) {
			if (!isObject(item) || typeof item.id !== "number") continue;
			const waiting = this.#byId.get(item.id)?.waiting;
			if (waiting === undefined) continue;
			if (owner !== undefined && owner !== waiting) {
				this.#violation("the peer answered two messages in one batch response");
				return;
			}
			owner = waiting;
		}
		if (owner === undefined) {
			// Every entry unreadable (null ids), or answers long abandoned.
			const [head] = items;
			if (
				isObject(head) &&
				items.every((item) => isObject(item) && item.id === null)
			) {
				this.#unattributed({ message: items, error: head.error });
			}
			return;
		}
		if (!owner.batch) {
			this.#violation(
				"the peer answered a single request with a batch response",
			);
			return;
		}
		const ids = owner.ids;
		owner.resolve(
			items.map((item) => {
				if (!isObject(item) || typeof item.id !== "number") return item;
				// Not one of this batch's ids: left as it came, for the client to
				// report as an answer to nothing it asked.
				const original = ids.get(item.id);
				return original === undefined ? item : { ...item, id: original };
			}),
		);
	}

	/** An answer that names no request: see the module comment. */
	#unattributed(answer: Unattributed): void {
		const [only, ...others] = this.#waiting;
		if (only === undefined) return;
		const notifiedLately =
			performance.now() - this.#lastNotification < this.#notificationWindow;
		if (others.length === 0 && !notifiedLately) {
			only.resolve(answer.message);
			return;
		}
		for (const waiting of this.#waiting) waiting.suspect = answer;
	}
}

/** Turn the client's message into wire form: our ids on it, the caller's kept aside. */
function prepare(
	body: unknown,
	nextId: () => number,
	maxBytes: number,
): Outgoing {
	const ids = new Map<number, JsonRpcId>();
	const relabel = (item: unknown): unknown => {
		if (!isObject(item)) {
			throw new RpcTransportError(
				"E_COMET_INVALID_MESSAGE",
				"a JSON-RPC message is an object, or an array of objects",
			);
		}
		if (!Object.hasOwn(item, "id")) return item;
		const id = item.id;
		if (id !== null && typeof id !== "string" && typeof id !== "number") {
			throw new RpcTransportError(
				"E_COMET_INVALID_MESSAGE",
				"a request id is a string, a number or null",
			);
		}
		const wire = nextId();
		ids.set(wire, id);
		return { ...item, id: wire };
	};
	const batch = Array.isArray(body);
	if (batch && body.length === 0) {
		throw new RpcTransportError(
			"E_COMET_INVALID_MESSAGE",
			"a batch holds at least one call",
		);
	}
	const wire = batch ? body.map(relabel) : relabel(body);
	let text: string;
	try {
		text = JSON.stringify(wire);
	} catch (cause) {
		throw new RpcTransportError(
			"E_COMET_INVALID_MESSAGE",
			"the message cannot be written as JSON",
			{ cause },
		);
	}
	if (utf8Length(text) > maxBytes) {
		throw new RpcTransportError(
			"E_COMET_MESSAGE_TOO_LARGE",
			`the message is over ${maxBytes} bytes`,
		);
	}
	return { text, ids, batch };
}

/** Describe an id-null error kept on a call, for the timeout that reports it. */
function describeSuspect(error: unknown): string {
	if (isObject(error) && typeof error.message === "string") {
		return `; meanwhile the server refused a message it could not attribute (${String(error.code)} ${error.message})`;
	}
	return "; meanwhile the server refused a message it could not attribute";
}

export function createWebSocketTransport(
	options: WebSocketTransportOptions = {},
): RpcWebSocketTransport {
	const createSocket = options.createSocket ?? defaultSocket(options.protocols);
	const timeout = positive("timeout", options.timeout, DEFAULT_TIMEOUT_MS);
	const maxMessageBytes = positive(
		"maxMessageBytes",
		options.maxMessageBytes,
		DEFAULT_MAX_MESSAGE_BYTES,
	);
	const maxBufferedBytes = positive(
		"maxBufferedBytes",
		options.maxBufferedBytes,
		DEFAULT_MAX_BUFFERED_BYTES,
	);
	if (timeout !== Number.POSITIVE_INFINITY && timeout > MAX_TIMER_MS) {
		throw new RangeError(
			`timeout must be at most ${MAX_TIMER_MS} ms, or Infinity`,
		);
	}
	const reconnect = options.reconnect !== false;
	const connections = new Map<string, Connection>();
	/** URLs whose socket closed while `reconnect` is off: they stay closed. */
	const dead = new Set<string>();
	let wireId = 0;
	let closed = false;

	function connectionFor(url: string): Connection {
		const existing = connections.get(url);
		if (existing !== undefined && !existing.closed) return existing;
		if (dead.has(url)) {
			throw new RpcTransportError(
				"E_COMET_CONNECTION_CLOSED",
				"the socket closed and reconnect is off",
			);
		}
		let socket: RpcSocket;
		try {
			socket = createSocket(url);
		} catch (cause) {
			throw new RpcTransportError(
				"E_COMET_CONNECTION_FAILED",
				`the socket to ${url} could not be created`,
				{ cause },
			);
		}
		const window =
			timeout === Number.POSITIVE_INFINITY ? DEFAULT_TIMEOUT_MS : timeout;
		const connection: Connection = new Connection(
			socket,
			maxMessageBytes,
			window,
			() => {
				// Called once, from the one place a connection dies; a new socket
				// for this URL is only made once this one is closed, so the entry
				// is this connection.
				connections.delete(url);
				if (!reconnect && !closed) dead.add(url);
			},
		);
		connections.set(url, connection);
		return connection;
	}

	const transport: RpcTransport = (url, body, { signal }) =>
		new Promise<unknown>((resolve, reject) => {
			if (closed) {
				reject(
					new RpcTransportError(
						"E_COMET_TRANSPORT_CLOSED",
						"the transport is closed",
					),
				);
				return;
			}
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			let outgoing: Outgoing;
			let connection: Connection;
			try {
				outgoing = prepare(body, () => ++wireId, maxMessageBytes);
				connection = connectionFor(url);
			} catch (error) {
				reject(error);
				return;
			}
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				connection.release(waiting);
			};
			const waiting: Waiting = {
				ids: outgoing.ids,
				batch: outgoing.batch,
				suspect: undefined,
				// Each path that settles a call releases it first (finish), so no
				// event can reach it a second time.
				resolve(value) {
					finish();
					resolve(value);
				},
				reject(error) {
					finish();
					reject(error);
				},
			};
			function onAbort(): void {
				waiting.reject(signal?.reason);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeout !== Number.POSITIVE_INFINITY) {
				timer = setTimeout(() => {
					waiting.reject(
						new RpcTransportError(
							"E_COMET_TIMEOUT",
							`no answer within ${timeout} ms${waiting.suspect === undefined ? "" : describeSuspect(waiting.suspect.error)}`,
							waiting.suspect === undefined
								? undefined
								: { cause: waiting.suspect.message },
						),
					);
				}, timeout);
			}
			// Waiting from now, so a socket that fails while connecting fails this
			// call too, through the same entry.
			connection.wait(waiting);
			connection.opened.then(
				() => {
					if (settled) return;
					if (connection.bufferedAmount > maxBufferedBytes) {
						waiting.reject(
							new RpcTransportError(
								"E_COMET_BACKPRESSURE",
								`over ${maxBufferedBytes} bytes already wait to be sent`,
							),
						);
						return;
					}
					try {
						connection.send(outgoing.text, outgoing.ids.size === 0);
					} catch (cause) {
						waiting.reject(
							new RpcTransportError(
								"E_COMET_CONNECTION_CLOSED",
								"the socket refused the message",
								{ cause },
							),
						);
						return;
					}
					// Notifications only: nothing will come back.
					if (outgoing.ids.size === 0) waiting.resolve(undefined);
				},
				() => {
					// The close handler already failed every waiting entry.
				},
			);
		});

	return Object.assign(transport, {
		close(): void {
			if (closed) return;
			closed = true;
			const error = new RpcTransportError(
				"E_COMET_TRANSPORT_CLOSED",
				"the transport was closed",
			);
			for (const connection of [...connections.values()]) {
				connection.shut(1000, "", error);
			}
			connections.clear();
		},
	});
}
