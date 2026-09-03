# @c9up/comet

Agnostic **JSON-RPC 2.0** protocol + an **isomorphic, transport-injectable client**
for the [Ream](https://github.com/C9up) framework. Zero framework, zero transport,
zero dependency — the browser binding (`@c9up/aurora`) and the server binding
(`@c9up/ream`'s `RpcRouter`) both build on this core instead of hand-rolling the
envelope and error codes.

## Client

The client owns the JSON-RPC logic (single + batch, id matching, error mapping)
and delegates the actual bytes to an injected `transport` — so the same client
runs in the browser or in Node:

```ts
import { createRpcClient } from "@c9up/comet";

const rpc = createRpcClient({
  url: "/rpc",
  transport: (url, body, { signal }) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }).then((r) => r.json()),
});

const out = await rpc.call("task.validate", { id: 7 });          // typed via call<T>()
await rpc.call("user.find", { id }, { parse: isUser });          // runtime-validated
await rpc.call("slow.op", p, { signal: ac.signal });             // abortable
const results = await rpc.batch([{ method: "a" }, { method: "b" }]); // settled per call
```

> In the browser, prefer `@c9up/aurora`'s `createRpcClient` — it wires aurora's
> `HttpClient` (base URL, auth headers, timeouts) as the transport and pairs with
> `command()`.

## Protocol

The `@c9up/comet/protocol` surface exposes the spec primitives a server binding
needs: `parseRequest`, `isNotification`, `buildRequest`/`buildSuccess`/`buildError`,
`RpcError`/`toRpcError`/`isRpcShapedError`, and the reserved `RpcErrorCode`.

`parseRequest` enforces the envelope MUSTs — the version, the method, an `id`
that is a String/Number/Null, and a `params` that is a Structured value (§4.2:
an Array or an Object, never a scalar). A handler raises a domain error by
throwing `RpcError`; `isRpcShapedError` also accepts a plain object whose `code`
is a **negative integer**, the space the spec gives errors, so the numeric
`code` an aborted `fetch` or a gRPC status happens to carry is not mistaken for
one.
