/**
 * Comet errors, one per code.
 *
 * A call that reaches the server and is answered with a JSON-RPC error fails
 * with an `RpcRemoteError`, whose numeric `code` is the wire code. Everything
 * here is a failure of the WebSocket transport itself, or a transport the
 * caller configured wrongly: its `code` is a string, so `isRpcShapedError`
 * never mistakes it for a JSON-RPC error a server handler could forward.
 */
import { createError } from "@c9up/flare";

/**
 * `createWebSocketTransport` was given an option it cannot honour: a timeout
 * or size that is not a positive number, or a timeout past what a timer can
 * wait.
 */
export const E_COMET_INVALID_OPTION = createError<[string, string, unknown]>(
	"%s must be %s, got %s",
	"E_COMET_INVALID_OPTION",
);

/** The socket could not be opened (refused handshake, bad URL, network). */
export const E_COMET_CONNECTION_FAILED = createError<[string]>(
	"%s",
	"E_COMET_CONNECTION_FAILED",
);

/** The socket closed while the call waited, or stays closed (`reconnect: false`). */
export const E_COMET_CONNECTION_CLOSED = createError<[string]>(
	"%s",
	"E_COMET_CONNECTION_CLOSED",
);

/** `close()` was called on the transport. */
export const E_COMET_TRANSPORT_CLOSED = createError(
	"the transport is closed",
	"E_COMET_TRANSPORT_CLOSED",
);

/** No answer within the timeout; the second value describes an unattributed refusal, if any. */
export const E_COMET_TIMEOUT = createError<[number, string]>(
	"no answer within %d ms%s",
	"E_COMET_TIMEOUT",
);

/** A message over `maxMessageBytes`, sent or received. */
export const E_COMET_MESSAGE_TOO_LARGE = createError<[string, number]>(
	"%s over %d bytes",
	"E_COMET_MESSAGE_TOO_LARGE",
);

/** More than `maxBufferedBytes` already wait to be sent. */
export const E_COMET_BACKPRESSURE = createError<[number]>(
	"over %d bytes already wait to be sent",
	"E_COMET_BACKPRESSURE",
);

/** The peer sent what no JSON-RPC server answers: the socket was closed. */
export const E_COMET_PROTOCOL_ERROR = createError<[string]>(
	"%s",
	"E_COMET_PROTOCOL_ERROR",
);

/** The client handed over something that is not a JSON-RPC message, or not JSON. */
export const E_COMET_INVALID_MESSAGE = createError<[string]>(
	"%s",
	"E_COMET_INVALID_MESSAGE",
);
