import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../util/logger';
import {
  type AndroidDevice,
  createAndroidDevice,
  describeDeviceContext,
  isAndroidDevice,
} from './androidDevice';

// Persistence for the Android device context used by the native QR login protocol.
// The QIMEI bootstrap and every musicu.fcg call must run on ONE stable identity, so the
// context has to survive a process restart instead of being regenerated on every boot.
//
// This module is the filesystem half of the device seam and is Node-only. The device material
// itself lives in `androidDevice.ts`, which stays runtime-neutral so a serverless runtime can
// derive an identity without ever reaching `node:fs`.

export {
  type AndroidDevice,
  createAndroidDevice,
  describeDeviceContext,
  isAndroidDevice,
} from './androidDevice';

export const DEVICE_STATE_ENV = 'QQ_AUTH_STATE_PATH';
export const MEMORY_STATE_PATH = 'memory';
const DEFAULT_STATE_PATH = path.join('.auth-state', 'qq-device.json');
const STATE_FILE_MODE = 0o600;
const STATE_VERSION = 1;

export interface DeviceContextRepository {
  readonly kind: 'file' | 'memory';
  load(): AndroidDevice | null;
  save(device: AndroidDevice): void;
  clear(): void;
}

export interface DeviceContextStore {
  get(): AndroidDevice;
  persist(): void;
  reset(): AndroidDevice;
}

export const createMemoryDeviceContextRepository = (
  seed: AndroidDevice | null = null,
): DeviceContextRepository => {
  let stored = seed ? ({ ...seed } as AndroidDevice) : null;
  return {
    kind: 'memory',
    load: () => (stored ? ({ ...stored } as AndroidDevice) : null),
    save: (device) => {
      stored = { ...device };
    },
    clear: () => {
      stored = null;
    },
  };
};

/**
 * Persists the device context as owner-only JSON. Every filesystem failure degrades to an
 * in-process context instead of blocking login: a read-only container still works, it just
 * re-registers a device on the next restart.
 */
export const createFileDeviceContextRepository = (filePath: string): DeviceContextRepository => ({
  kind: 'file',
  load: () => {
    try {
      if (!fs.existsSync(filePath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const device = (record as Record<string, unknown>).device;
      if (!isAndroidDevice(device)) {
        logger.warn('qq-auth.device-context.invalid-state', { kind: 'file' });
        return null;
      }
      return device;
    } catch (error) {
      logger.warn('qq-auth.device-context.load-failed', {
        name: error instanceof Error ? error.name : 'Error',
      });
      return null;
    }
  },
  save: (device) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({ version: STATE_VERSION, device }, null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: STATE_FILE_MODE,
        },
      );
    } catch (error) {
      logger.warn('qq-auth.device-context.save-failed', {
        name: error instanceof Error ? error.name : 'Error',
      });
    }
  },
  clear: () => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      logger.warn('qq-auth.device-context.clear-failed', {
        name: error instanceof Error ? error.name : 'Error',
      });
    }
  },
});

export const resolveDeviceStatePath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configured = env[DEVICE_STATE_ENV]?.trim();
  if (configured === MEMORY_STATE_PATH) return null;
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), DEFAULT_STATE_PATH);
};

export const createDefaultDeviceContextRepository = (
  env: NodeJS.ProcessEnv = process.env,
): DeviceContextRepository => {
  const statePath = resolveDeviceStatePath(env);
  return statePath
    ? createFileDeviceContextRepository(statePath)
    : createMemoryDeviceContextRepository();
};

/**
 * Loads the persisted context lazily on first use, so importing the auth service never
 * touches the filesystem, and writes back after each protocol step that mutates it.
 */
export const createDeviceContextStore = (
  repository: DeviceContextRepository,
): DeviceContextStore => {
  let device: AndroidDevice | null = null;

  const load = (): AndroidDevice => {
    if (device) return device;
    const restored = repository.load();
    device = restored ?? createAndroidDevice();
    logger.info('qq-auth.device-context.ready', {
      kind: repository.kind,
      source: restored ? 'restored' : 'created',
      ...describeDeviceContext(device),
    });
    if (!restored) repository.save(device);
    return device;
  };

  return {
    get: load,
    persist: () => {
      if (device) repository.save(device);
    },
    reset: () => {
      device = createAndroidDevice();
      repository.save(device);
      logger.info('qq-auth.device-context.ready', {
        kind: repository.kind,
        source: 'reset',
        ...describeDeviceContext(device),
      });
      return device;
    },
  };
};

export default createDeviceContextStore;
