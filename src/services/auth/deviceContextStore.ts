import { logger } from '../../util/logger';
import { type AndroidDevice, createAndroidDevice, describeDeviceContext } from './androidDevice';

// The runtime-neutral half of the device seam: the repository contract, the in-memory repository
// and the store that caches one device per process.
//
// Split out of `deviceContext.ts` unchanged so a serverless bundle can hold the store without the
// filesystem repository — importing the old module for the store alone pulled `node:fs` into the
// dependency closure. `deviceContext.ts` re-exports everything here, so no existing importer moves.

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
