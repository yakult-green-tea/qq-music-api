import {
  createMqttListen,
  createMqttListenOver,
  type MqttConnect,
  type MqttSocketHandlers,
  type QrEvent,
  type QrEventListener,
  type WebSocketConstructor,
} from '../src/services/auth/qrLogin';

// The QQ App channel's MQTT framing, driven through the `MqttConnect` port.
//
// Until S7-a this codec had exactly one caller — Node's `ws` — and no direct coverage; a Cloudflare
// Durable Object is now a second one, over a socket obtained a completely different way. What is
// asserted here is the part both runtimes share and neither can see: how bytes off the wire become
// QR events. The frames below are assembled by hand rather than with the module's own encoders, so
// a change to the encoder cannot quietly agree with itself.

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let digit = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) digit |= 0x80;
    bytes.push(digit);
  } while (rest > 0);
  return Buffer.from(bytes);
};

const utf8 = (value: string): Buffer => {
  const data = Buffer.from(value, 'utf8');
  const size = Buffer.alloc(2);
  size.writeUInt16BE(data.length);
  return Buffer.concat([size, data]);
};

const properties = (entries: Array<[string, string]>, extra = Buffer.alloc(0)): Buffer => {
  const body = Buffer.concat([
    ...entries.map(([key, value]) => Buffer.concat([Buffer.from([0x26]), utf8(key), utf8(value)])),
    extra,
  ]);
  return Buffer.concat([varint(body.length), body]);
};

const frame = (header: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([header]), varint(body.length), body]);

const connack = (reasonCode: number, serverReference?: string): Buffer =>
  frame(
    0x20,
    Buffer.concat([
      Buffer.from([0x00, reasonCode]),
      serverReference
        ? properties([], Buffer.concat([Buffer.from([0x1c]), utf8(serverReference)]))
        : properties([]),
    ]),
  );

const suback = (reasonCode = 0x00): Buffer =>
  frame(
    0x90,
    Buffer.concat([Buffer.from([0x00, 0x01]), properties([]), Buffer.from([reasonCode])]),
  );

const publish = (type: string, payload: Record<string, unknown>): Buffer =>
  frame(
    0x30,
    Buffer.concat([
      utf8('management.qrcode_login/qr-fixture'),
      properties([['type', type]]),
      Buffer.from(JSON.stringify(payload), 'utf8'),
    ]),
  );

/** A PINGRESP: a well-formed frame the QR flow has to skip rather than choke on. */
const pingresp = (): Buffer => Buffer.from([0xd0, 0x00]);

/** Total frame size read back off the wire: header byte, its remaining-length varint, and body. */
const frameLength = (packet: Uint8Array): number => {
  let multiplier = 1;
  let value = 0;
  let index = 1;
  for (;;) {
    const digit = packet[index];
    value += (digit & 0x7f) * multiplier;
    index += 1;
    if ((digit & 0x80) === 0) break;
    multiplier *= 128;
  }
  return index + value;
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Every listener a test starts owns a socket, a 20 s packet deadline and a keepalive interval, so
 * one left running keeps the worker alive after the assertions pass.
 */
const started: Array<{ close(): void }> = [];
const track = <T extends QrEventListener>(listener: T): T => {
  // Both promises get a no-op catch: tearing a listener down rejects whichever of them is still
  // pending, and a test that was not asserting on that one must not fail on an unhandled rejection.
  // Attaching here does not stop a test's own `await` from seeing the same rejection.
  void listener.ready.catch(() => undefined);
  void listener.done.catch(() => undefined);
  started.push(listener);
  return listener;
};

/** Sockets are tracked apart from listeners: `QrEventListener.close()` only reaches a socket the
 * handshake already finished with, so a test that stops mid-handshake — a redirect, a refused
 * CONNACK, a connect that never resolves — would leave one behind otherwise. */
const sockets: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const listener of started.splice(0)) listener.close();
  for (const socket of sockets.splice(0)) socket.close();
  await tick();
});

interface FakeConnection {
  url: string;
  sent: Uint8Array[];
  closed: boolean;
  handlers: MqttSocketHandlers;
}

const createFakeConnect = (): { connect: MqttConnect; connections: FakeConnection[] } => {
  const connections: FakeConnection[] = [];
  const connect: MqttConnect = async (url, _protocol, handlers) => {
    const connection: FakeConnection = { url, sent: [], closed: false, handlers };
    connections.push(connection);
    const close = (): void => {
      // A real socket reports its own close; the reassembler learns the connection is gone that
      // way and nothing else, so a fake that stays silent leaves every reader hanging forever.
      if (connection.closed) return;
      connection.closed = true;
      handlers.close();
    };
    sockets.push({ close });
    return {
      send: (data) => connection.sent.push(data),
      close,
    };
  };
  return { connect, connections };
};

/** Connects, gets past CONNACK and SUBACK, and hands back the live connection plus the events. */
const openListener = async (timeoutMs = 5_000) => {
  const { connect, connections } = createFakeConnect();
  const events: QrEvent[] = [];
  const listener = track(
    createMqttListenOver(connect)('qr-fixture', (event) => events.push(event), timeoutMs),
  );
  await tick();
  connections[0].handlers.message(connack(0x00));
  await tick();
  connections[0].handlers.message(suback());
  await listener.ready;
  return { connections, events, listener };
};

describe('createMqttListenOver', () => {
  it('should open the QR topic on the handshake path under the mqtt subprotocol', async () => {
    const { connect, connections } = createFakeConnect();

    track(createMqttListenOver(connect)('qr-fixture', () => undefined, 5_000));
    await tick();

    expect(connections[0].url).toBe('wss://mu.y.qq.com/ws/handshake');
    // CONNECT is sent immediately, which is why `MqttConnect` may only resolve on an open socket.
    expect(connections[0].sent[0][0]).toBe(0x10);
  });

  it('should settle ready on SUBACK, not on connect', async () => {
    // 🔴 The load-bearing ordering for the whole channel: CONNECT asks for a clean session and the
    // subscription is unicast, so anything published before SUBACK is gone. A caller that showed
    // the QR code on connect would be showing a code whose scan can never be observed.
    const { connect, connections } = createFakeConnect();
    const listener = track(createMqttListenOver(connect)('qr-fixture', () => undefined, 5_000));
    await tick();

    connections[0].handlers.message(connack(0x00));
    await tick();
    let settled = false;
    void listener.ready.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(connections[0].sent[1][0]).toBe(0x82);

    connections[0].handlers.message(suback());
    await expect(listener.ready).resolves.toBeUndefined();
  });

  it('should announce waiting once subscribed', async () => {
    const { events } = await openListener();

    expect(events).toEqual([{ type: 'waiting', payload: null }]);
  });

  it('should reject ready when the broker refuses the subscription', async () => {
    const { connect, connections } = createFakeConnect();
    const listener = track(createMqttListenOver(connect)('qr-fixture', () => undefined, 5_000));
    await tick();
    connections[0].handlers.message(connack(0x00));
    await tick();

    connections[0].handlers.message(suback(0x87));

    await expect(listener.ready).rejects.toThrow('SUBACK rejected');
  });

  it('should follow a broker redirect to the referenced server', async () => {
    const { connect, connections } = createFakeConnect();
    track(createMqttListenOver(connect)('qr-fixture', () => undefined, 5_000));
    await tick();

    connections[0].handlers.message(connack(0x9d, 'node-7'));
    await tick();

    expect(connections[0].closed).toBe(true);
    expect(connections[1].url).toBe('wss://mu.y.qq.com/ws/handshake/node-7');
  });

  describe('frame reassembly', () => {
    it('should parse a publish split across two deliveries', async () => {
      // TCP does not respect message boundaries and neither does a WebSocket relay under load; the
      // reassembler is the only thing standing between a split frame and a lost login event.
      const { connections, events } = await openListener();
      const packet = publish('scanned', { at: 1 });

      connections[0].handlers.message(packet.subarray(0, 4));
      await tick();
      expect(events).toHaveLength(1);

      connections[0].handlers.message(packet.subarray(4));
      await tick();

      expect(events[1]).toMatchObject({ type: 'scanned', payload: { at: 1 } });
    });

    it('should parse two publishes arriving in one delivery', async () => {
      const { connections, events } = await openListener();

      connections[0].handlers.message(
        Buffer.concat([publish('scanned', {}), publish('cookies', { cookies: {} })]),
      );
      await tick();

      expect(events.map((event) => event.type)).toEqual(['waiting', 'scanned', 'cookies']);
    });

    it('should skip a non-publish frame instead of choking on it', async () => {
      const { connections, events } = await openListener();

      connections[0].handlers.message(Buffer.concat([pingresp(), publish('scanned', {})]));
      await tick();

      expect(events.map((event) => event.type)).toEqual(['waiting', 'scanned']);
    });

    it('should hold a truncated trailing frame until the rest arrives', async () => {
      const { connections, events } = await openListener();
      const packet = publish('scanned', {});

      // One complete frame plus the first byte of the next: the complete one must be delivered now
      // and the fragment kept, not discarded with it.
      connections[0].handlers.message(
        Buffer.concat([publish('waiting', {}), packet.subarray(0, 1)]),
      );
      await tick();
      expect(events.map((event) => event.type)).toEqual(['waiting', 'waiting']);

      connections[0].handlers.message(packet.subarray(1));
      await tick();

      expect(events.map((event) => event.type)).toEqual(['waiting', 'waiting', 'scanned']);
    });
  });

  it('should close the socket after a terminal event', async () => {
    const { connections, listener } = await openListener();

    connections[0].handlers.message(publish('cookies', { cookies: {} }));
    await listener.done;

    expect(connections[0].closed).toBe(true);
  });

  it('should reject ready when the connection itself cannot be made', async () => {
    // 🔴 `ready` is what `QrLoginService.createQr` awaits before returning the image. When the
    // connect step lived outside the listener's own try block, an unreachable broker rejected
    // `done` and left `ready` pending forever, so the request hung instead of answering 502.
    const connect: MqttConnect = async () => {
      throw new Error('upgrade refused');
    };

    const listener = track(createMqttListenOver(connect)('qr-fixture', () => undefined, 5_000));

    await expect(listener.ready).rejects.toThrow('upgrade refused');
    await expect(listener.done).rejects.toThrow('upgrade refused');
  });

  it('should fail the listener when the socket drops mid-flow', async () => {
    const { connections, listener } = await openListener();

    connections[0].handlers.close();

    await expect(listener.done).rejects.toThrow('closed');
  });
});

describe('createMqttListen over a ws-shaped constructor', () => {
  /** The `ws` surface the Node runtime supplies, reduced to what `webSocketConnect` touches. */
  const createFakeWebSocket = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const sent: Buffer[] = [];
    const socket = {
      readyState: 1,
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return socket;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        return socket.on(event, listener);
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        );
        return socket;
      },
      send(data: Buffer) {
        sent.push(data);
      },
      close() {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        emit('close');
      },
    };
    const emit = (event: string, ...args: unknown[]): void => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    };
    sockets.push({ close: () => socket.close() });
    return { socket, sent, emit };
  };

  it('should send exactly the packet bytes, not the buffer they are a view into', async () => {
    // 🔴 Node's `Buffer` is allocated out of a shared pool, so a small packet is a *view* into a
    // much larger `ArrayBuffer`. Forwarding the underlying buffer instead of the view transmits
    // whatever else happens to be in the pool — wrong bytes on the wire and unrelated memory
    // leaving the process. The same trap is waiting for any host implementing `MqttConnect`.
    const fake = createFakeWebSocket();
    const constructor = function FakeWebSocket() {
      return fake.socket;
    } as unknown as WebSocketConstructor;

    track(createMqttListen(constructor)('qr-fixture', () => undefined, 5_000));
    fake.emit('open');
    await tick();

    const connect = fake.sent[0];
    expect(connect[0]).toBe(0x10);
    // What the socket receives is exactly one frame. Forwarding `data.buffer` instead of the view
    // would hand it the whole 8 KB pool, and this length check is what catches that.
    expect(connect.length).toBe(frameLength(connect));
    expect(connect.length).toBeLessThan(1024);
  });

  it('should reject the handshake when the socket errors before opening', async () => {
    const fake = createFakeWebSocket();
    const constructor = function FakeWebSocket() {
      return fake.socket;
    } as unknown as WebSocketConstructor;

    const listener = track(createMqttListen(constructor)('qr-fixture', () => undefined, 5_000));
    fake.emit('error', new Error('refused'));

    await expect(listener.done).rejects.toThrow('handshake failed');
  });
});
