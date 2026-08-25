/**
 * The QQ App channel's MQTT listener, for a host that can hold the connection but has to open it
 * itself.
 *
 * Why a separate entry point rather than the package root: the root export starts a Koa server as
 * an import side effect, so a Worker or Durable Object cannot touch it. `./serverless` is the
 * request handler and does not need to expose the transport; this is the transport and does not
 * need to expose the handler. Both stay inside the same zero-npm, zero-`node:*` dependency closure.
 *
 * 🔴 The codec itself stays in this package and is not reimplemented by hosts. What a host supplies
 * is only `MqttConnect` — how *its* runtime opens a WebSocket — because that is the one piece the
 * protocol genuinely cannot express portably: Node and Cloudflare both construct a socket, but
 * their event surfaces and runtime types differ. On Cloudflare, use the standard
 * `new WebSocket(wssUrl, protocol)` constructor and resolve only after its `open` event.
 *
 * Two things an implementation must get right, both of which have already bitten this codebase:
 *
 * - Resolve only once the socket is **open**. The protocol sends CONNECT immediately.
 * - `send` receives a `Uint8Array` that may be a view into a larger, shared buffer — Node's
 *   `Buffer` is pooled. Forward `data.byteOffset` and `data.byteLength`; handing the whole
 *   underlying `ArrayBuffer` to a platform `send()` transmits unrelated memory.
 */
export {
  createMqttListenOver,
  type MqttConnect,
  type MqttSocket,
  type MqttSocketHandlers,
  type QrEvent,
  type QrEventListener,
} from '../services/auth/qrLogin';
