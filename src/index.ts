/**
 * Comet — agnostic JSON-RPC 2.0 protocol + isomorphic, transport-injectable
 * client. Zero framework, zero transport, zero dependency. The browser binding
 * (aurora) and the server binding (Ream's `RpcRouter`) both build on this.
 */
export {
	createRpcClient,
	type RpcCall,
	type RpcCallOptions,
	type RpcClient,
	type RpcClientOptions,
	type RpcResult,
	type RpcTransport,
} from "./client.js";
export {
	buildError,
	buildRequest,
	buildSuccess,
	isNotification,
	isObject,
	isRpcError,
	isRpcShapedError,
	type JsonRpcErrorObject,
	type JsonRpcErrorResponse,
	type JsonRpcId,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonRpcSuccessResponse,
	type ParsedRpcRequest,
	parseRequest,
	RpcError,
	RpcErrorCode,
	toRpcError,
} from "./protocol.js";
