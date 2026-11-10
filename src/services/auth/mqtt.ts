import { ANDROID_CLIENT } from '../../protocol/clientProfiles';
import {
  type Dictionary,
  dictionaryOf,
  numberOf,
  parseDictionary,
  stringOf,
} from '../../util/values';
import { randomDigits } from './androidDevice';
import { Buffer } from './bytes';
import { type QrEvent, type QrEventListener } from './qrTypes';

// src/services/auth/mqtt.ts
// 从认证入口搬出的同一套实现；协议、状态与对外回包沿用原规则。

export const MQTT_HOST = 'mu.y.qq.com';

export const MQTT_INITIAL_PATH = '/ws/handshake';

export interface WebSocketLike {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  once(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  removeListener(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  send(data: Buffer): void;
  close(): void;
}

export interface WebSocketConstructor {
  new (url: string, protocol: string): WebSocketLike;
}

/**
 * One open MQTT-over-WebSocket connection, reduced to the two operations the protocol needs.
 *
 * Deliberately not `WebSocketLike`: that shape is `ws`'s EventEmitter surface, and the only other
 * runtime that can hold this connection — a Cloudflare Durable Object — uses the platform's
 * browser-style `WebSocket` constructor and event surface. Making the *connect* step the injection
 * point rather than the constructor is what lets both runtimes supply what they actually have and
 * resolve only after the socket opens.
 */
export interface MqttSocket {
  send(data: Uint8Array): void;
  close(): void;
}

/** Where a connection reports everything that arrives after it is open. */
export interface MqttSocketHandlers {
  message(data: unknown): void;
  close(): void;
  error(error: Error): void;
}

/**
 * Opens one MQTT-over-WebSocket connection to `url` under the `protocol` subprotocol.
 *
 * 🔴 Resolves only once the socket is open, and rejects if it cannot be opened. The protocol below
 * starts sending the moment this resolves, so an implementation that resolves early has to queue
 * those writes itself.
 */
export type MqttConnect = (
  url: string,
  protocol: string,
  handlers: MqttSocketHandlers,
) => Promise<MqttSocket>;

export interface PacketQueue {
  next(timeoutMs: number): Promise<Buffer>;
}

export const encodeVariableInteger = (input: number): Buffer => {
  let value = input;
  const bytes: number[] = [];
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
};

export const decodeVariableInteger = (
  buffer: Buffer,
  offset = 0,
): { value: number; bytes: number } | null => {
  let multiplier = 1;
  let value = 0;
  for (let bytes = 0; bytes < 4; bytes += 1) {
    if (offset + bytes >= buffer.length) return null;
    const digit = buffer[offset + bytes];
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) return { value, bytes: bytes + 1 };
    multiplier *= 128;
  }
  throw new Error('Malformed MQTT variable integer');
};

export const encodeUtf8 = (value: string): Buffer => {
  const data = Buffer.from(value, 'utf8');
  const size = Buffer.allocUnsafe(2);
  size.writeUInt16BE(data.length);
  return Buffer.concat([size, data]);
};

export const encodeProperties = (
  authMethod: string | null,
  properties: Array<[string, string]>,
): Buffer => {
  const chunks: Buffer[] = [];
  if (authMethod) chunks.push(Buffer.from([0x15]), encodeUtf8(authMethod));
  for (const [key, value] of properties)
    chunks.push(Buffer.from([0x26]), encodeUtf8(key), encodeUtf8(value));
  const data = Buffer.concat(chunks);
  return Buffer.concat([encodeVariableInteger(data.length), data]);
};

export const wrapPacket = (header: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([header]), encodeVariableInteger(body.length), body]);

export const buildConnectPacket = (clientId: string, qrcodeId: string): Buffer => {
  const keepAlive = Buffer.allocUnsafe(2);
  keepAlive.writeUInt16BE(45);
  const properties = encodeProperties('pass', [
    ['tmeAppID', ANDROID_CLIENT.appId],
    ['business', 'management'],
    ['hashTag', qrcodeId],
    ['clientTag', 'management.user'],
    ['userID', qrcodeId],
  ]);
  return wrapPacket(
    0x10,
    Buffer.concat([
      encodeUtf8('MQTT'),
      Buffer.from([0x05, 0x02]),
      keepAlive,
      properties,
      encodeUtf8(clientId),
    ]),
  );
};

export const buildSubscribePacket = (qrcodeId: string): Buffer => {
  const packetId = Buffer.from([0x00, 0x01]);
  const properties = encodeProperties(null, [
    ['authorization', 'tmelogin'],
    ['pubsub', 'unicast'],
  ]);
  return wrapPacket(
    0x82,
    Buffer.concat([
      packetId,
      properties,
      encodeUtf8(`management.qrcode_login/${qrcodeId}`),
      Buffer.from([0x00]),
    ]),
  );
};

export const readUtf8 = (buffer: Buffer, offset: number): { value: string; next: number } => {
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + length).toString('utf8'), next: start + length };
};

export const skipProperty = (buffer: Buffer, offset: number, id: number): number => {
  if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) return readUtf8(buffer, offset).next;
  if ([0x13, 0x21, 0x22, 0x23].includes(id)) return offset + 2;
  if ([0x02, 0x11, 0x18, 0x27].includes(id)) return offset + 4;
  if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) return offset + 1;
  if ([0x09, 0x16].includes(id)) return offset + 2 + buffer.readUInt16BE(offset);
  if (id === 0x0b) {
    const value = decodeVariableInteger(buffer, offset);
    if (!value) throw new Error('Truncated MQTT subscription identifier');
    return offset + value.bytes;
  }
  throw new Error(`Unsupported MQTT property 0x${id.toString(16)}`);
};

export const parseProperties = (
  buffer: Buffer,
  offset: number,
): { values: Dictionary; next: number } => {
  const length = decodeVariableInteger(buffer, offset);
  if (!length) throw new Error('Truncated MQTT properties');
  let cursor = offset + length.bytes;
  const end = cursor + length.value;
  const userProperties: Dictionary = {};
  const values: Dictionary = { userProperties };
  while (cursor < end) {
    const id = buffer[cursor];
    cursor += 1;
    if (id === 0x26) {
      const key = readUtf8(buffer, cursor);
      const value = readUtf8(buffer, key.next);
      userProperties[key.value] = value.value;
      cursor = value.next;
    } else if (id === 0x1c || id === 0x1f) {
      const value = readUtf8(buffer, cursor);
      values[id === 0x1c ? 'serverReference' : 'reasonString'] = value.value;
      cursor = value.next;
    } else cursor = skipProperty(buffer, cursor, id);
  }
  return { values, next: end };
};

export const splitPackets = (buffer: Buffer): { packets: Buffer[]; rest: Buffer } => {
  const packets: Buffer[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const remaining = decodeVariableInteger(buffer, cursor + 1);
    if (!remaining) break;
    const end = cursor + 1 + remaining.bytes + remaining.value;
    if (end > buffer.length) break;
    packets.push(buffer.subarray(cursor, end));
    cursor = end;
  }
  return { packets, rest: buffer.subarray(cursor) };
};

export const parseConnack = (packet: Buffer): Dictionary => {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT CONNACK');
  const offset = 1 + remaining.bytes;
  return { reasonCode: packet[offset + 1], ...parseProperties(packet, offset + 2).values };
};

export const parsePublish = (packet: Buffer): QrEvent => {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT PUBLISH');
  let cursor = 1 + remaining.bytes;
  cursor = readUtf8(packet, cursor).next;
  if (((packet[0] >> 1) & 0x03) > 0) cursor += 2;
  const properties = parseProperties(packet, cursor);
  const users = dictionaryOf(properties.values.userProperties);
  const raw = packet.subarray(properties.next).toString('utf8');
  return { type: stringOf(users.type) || null, payload: raw ? parseDictionary(raw) : null };
};

export const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(Buffer.isBuffer)) return Buffer.concat(value);
  throw new Error('Unsupported MQTT WebSocket payload');
};

/**
 * The packet reassembler, now built *before* the socket exists rather than subscribing to one.
 *
 * A `MqttConnect` implementation is handed `handlers` at connect time, because a socket obtained
 * through `fetch()` can deliver its first frame before the caller ever sees the socket object.
 * Building the queue first and passing its handlers in is what removes that race.
 */
export const createPacketQueue = (): { queue: PacketQueue; handlers: MqttSocketHandlers } => {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const packets: Buffer[] = [];
  const waiters: Array<{ resolve: (packet: Buffer) => void; reject: (error: Error) => void }> = [];
  let terminalError: Error | null = null;
  const settle = (): void => {
    while (waiters.length && packets.length) waiters.shift()?.resolve(packets.shift() as Buffer);
    while (terminalError && waiters.length) waiters.shift()?.reject(terminalError);
  };
  const handlers: MqttSocketHandlers = {
    message: (value) => {
      const split = splitPackets(Buffer.concat([buffered, toBuffer(value)]));
      buffered = split.rest;
      packets.push(...split.packets);
      settle();
    },
    error: () => {
      terminalError = new Error('MQTT WebSocket error');
      settle();
    },
    close: () => {
      terminalError = new Error('MQTT WebSocket closed');
      settle();
    },
  };
  const queue: PacketQueue = {
    next(timeoutMs: number): Promise<Buffer> {
      if (packets.length) return Promise.resolve(packets.shift() as Buffer);
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('MQTT packet timeout'));
        }, timeoutMs);
        waiter.resolve = (packet) => {
          clearTimeout(timer);
          resolve(packet);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
  return { queue, handlers };
};

/**
 * Adapts a `ws`-shaped constructor to `MqttConnect`. This is the exact promise `openWebSocket`
 * was, moved behind the port so Node keeps its byte-for-byte behaviour while the protocol below
 * only ever sees `MqttConnect`.
 */
export const webSocketConnect =
  (webSocket: WebSocketConstructor): MqttConnect =>
  (url, protocol, handlers) =>
    new Promise((resolve, reject) => {
      const socket = new webSocket(url, protocol);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('MQTT handshake timeout'));
      }, 20000);
      const onOpen = (): void => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.on('message', (value) => handlers.message(value));
        socket.on('error', () => handlers.error(new Error('MQTT WebSocket error')));
        socket.on('close', () => handlers.close());
        resolve({
          send: (data) => socket.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
          close: () => socket.close(),
        });
      };
      const onError = (): void => {
        clearTimeout(timer);
        socket.removeListener('open', onOpen);
        reject(new Error('MQTT handshake failed'));
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

export const redirectPath = (path: string, reference: string): string => {
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.at(-1)?.includes(':')) parts[parts.length - 1] = reference;
  else parts.push(reference);
  return parts.join('/');
};

export const connectMqtt = async (connect: MqttConnect, qrcodeId: string) => {
  let path = MQTT_INITIAL_PATH;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const { queue, handlers } = createPacketQueue();
    const socket = await connect(`wss://${MQTT_HOST}${path}`, 'mqtt', handlers);
    socket.send(buildConnectPacket(`${Date.now()}${randomDigits(4)}`, qrcodeId));
    const connack = parseConnack(await queue.next(20000));
    const reasonCode = numberOf(connack.reasonCode) ?? -1;
    if (reasonCode === 0) return { socket, queue };
    socket.close();
    const reference = stringOf(connack.serverReference);
    if (![0x9c, 0x9d].includes(reasonCode) || !reference || redirects === 3) {
      throw new Error(`MQTT CONNACK rejected: 0x${reasonCode.toString(16)}`);
    }
    path = redirectPath(path, reference);
  }
  throw new Error('MQTT redirect limit exceeded');
};

export const subscribeToQrEvents = async (
  socket: MqttSocket,
  queue: PacketQueue,
  qrcodeId: string,
  onEvent: (event: QrEvent) => void,
): Promise<void> => {
  socket.send(buildSubscribePacket(qrcodeId));
  while (true) {
    const packet = await queue.next(20000);
    if (packet[0] >> 4 === 9) {
      const reasonCode = packet.at(-1) ?? 0x80;
      if (reasonCode >= 0x80) throw new Error(`MQTT SUBACK rejected: 0x${reasonCode.toString(16)}`);
      return;
    }
    if (packet[0] >> 4 === 3) onEvent(parsePublish(packet));
  }
};

export const consumeQrEvents = async (
  queue: PacketQueue,
  onEvent: (event: QrEvent) => void,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packet = await queue.next(Math.max(1, deadline - Date.now()));
    if (packet[0] >> 4 !== 3) continue;
    const event = parsePublish(packet);
    onEvent(event);
    if (['cookies', 'canceled', 'timeout', 'loginFailed'].includes(event.type ?? '')) return;
  }
  onEvent({ type: 'timeout', payload: null });
};

/**
 * The MQTT listener for the QQ App channel, over whatever a runtime can open a socket with.
 *
 * The connection is a parameter rather than a module-level `require('ws')` so that importing this
 * module does not put `ws` in the dependency closure. Node supplies it in `qrLogin.node.ts`; a
 * Cloudflare Durable Object supplies one backed by the standard WebSocket constructor. Behaviour
 * is otherwise byte-for-byte what it was.
 *
 * 🔴 `ready` settles on SUBACK, not on connect. Callers must await it before showing the QR code:
 * the CONNECT packet asks for a clean MQTT session and the subscription is unicast, so the upstream
 * neither retains nor replays anything published before the subscription exists. A code shown
 * early is a code whose `scanned`/`cookies` events can be lost outright.
 */
export const createMqttListenOver =
  (connect: MqttConnect) =>
  (qrcodeId: string, onEvent: (event: QrEvent) => void, timeoutMs: number): QrEventListener => {
    let activeSocket: MqttSocket | null = null;
    let readySettled = false;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const done = (async (): Promise<void> => {
      // 🔴 The connect is inside the `try`. It used to sit above it, so a failed handshake rejected
      // `done` while leaving `ready` pending forever — and `ready` is what `createQr` awaits, so an
      // unreachable broker hung the request instead of failing it.
      let socket: MqttSocket | null = null;
      let ping: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      try {
        const connection = await connectMqtt(connect, qrcodeId);
        socket = connection.socket;
        activeSocket = socket;
        ping = setInterval(() => {
          // The port has no `readyState`, so a send after close is caught rather than pre-checked;
          // an already-dead socket must not turn a keepalive tick into an unhandled rejection.
          if (closed || !socket) return;
          try {
            socket.send(Buffer.from([0xc0, 0x00]));
          } catch {
            closed = true;
          }
        }, 30000);
        await subscribeToQrEvents(socket, connection.queue, qrcodeId, onEvent);
        onEvent({ type: 'waiting', payload: null });
        readySettled = true;
        resolveReady();
        await consumeQrEvents(connection.queue, onEvent, timeoutMs);
      } catch (error) {
        if (!readySettled) rejectReady(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        closed = true;
        if (ping) clearInterval(ping);
        socket?.close();
      }
    })();
    void done.catch(() => undefined);
    return { ready, done, close: () => activeSocket?.close() };
  };

/** The Node flavour: the same listener over a `ws`-shaped constructor. */
export const createMqttListen = (webSocket: WebSocketConstructor) =>
  createMqttListenOver(webSocketConnect(webSocket));
