import crypto from 'node:crypto';
import { createDefaultDeviceContextRepository } from './deviceContext';
import createAuthHttpClient from './httpClient';
import {
  type AuthSessionRepository,
  createMqttListen,
  createQrLoginService,
  type QrLoginService,
  type WebSocketConstructor,
} from './qrLogin';

/**
 * The Node runtime wrapper: `qrLogin.ts` is runtime-neutral, and this file is the only place that
 * supplies the four Node-flavoured dependencies it used to default to internally.
 *
 * Why the split exists at all: dependency *injection* happens when the service is constructed, but
 * `require('ws')`, the axios client and the filesystem device repository were resolved when the
 * module was *imported*. A serverless bundle therefore carried `ws` and `axios` no matter what it
 * injected — measured, not assumed, with an esbuild metafile. Moving the four defaults here is
 * what takes them out of the neutral module's dependency closure.
 *
 * 🔴 The defaults below are exactly the expressions `qrLogin.ts` used to apply inline, so Node,
 * Electron and Docker behave identically and no caller has to register anything first. `randomBytes`
 * joined the other three when the neutral core's own default moved off `node:crypto` onto
 * `globalThis.crypto.getRandomValues` — a Vercel Edge Function refuses to deploy a bundle
 * importing `node:crypto` at all, and `qrLogin.ts` is shared by that bundle.
 */

// `ws` has no types of its own here and is only ever used through the structural
// `WebSocketConstructor` the protocol declares.
const WebSocketRuntime = require('ws') as WebSocketConstructor;

export const createNodeQrLoginService = (): QrLoginService =>
  createQrLoginService({
    http: createAuthHttpClient(),
    createSessionHttp: createAuthHttpClient,
    deviceRepository: createDefaultDeviceContextRepository(),
    listen: createMqttListen(WebSocketRuntime),
    randomBytes: crypto.randomBytes,
  });

export const qrLoginService = createNodeQrLoginService();

/**
 * Runtime hook for embedding hosts. Folia calls this immediately after loading the npm package,
 * before the event loop can accept a request, so the singleton used by every controller sees the
 * restored encrypted sessions without exposing credentials through the HTTP surface.
 */
export const configureAuthSessionRepository = (repository: AuthSessionRepository): void => {
  qrLoginService.configureAuthSessionRepository(repository);
};

export default qrLoginService;
