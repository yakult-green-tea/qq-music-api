import fs from 'node:fs';
import path from 'node:path';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  clearLegacyHttpTransport,
  getLegacyHttpTransport,
  type LegacyHttpTransport,
  setLegacyHttpTransport,
} from '../src/services/httpTransport';
import u_common from '../src/services/u_common';
import y_common from '../src/services/y_common';
import { createAxiosLegacyTransport } from '../src/util/request';

interface RecordedCall {
  url: string;
  method: string;
  options?: AxiosRequestConfig;
  target?: string;
}

const createRecordingTransport = (): { transport: LegacyHttpTransport; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    transport: {
      kind: 'recording',
      defaults: {
        baseURL: {
          y: 'https://y.example.test',
          c: 'https://c.example.test',
          u: 'https://u.example.test/cgi-bin/musicu.fcg',
        },
        referer: {
          y: 'https://y.example.test/',
          c: 'https://c.example.test/',
          u: 'https://y.example.test/portal/player.html',
        },
        commonParams: { g_tk: 7, platform: 'yqq.json' },
      },
      request: async <T>(
        url: string,
        method: string,
        options?: AxiosRequestConfig,
        target?: string,
      ): Promise<AxiosResponse<T>> => {
        calls.push({ url, method, options, target });
        return { data: {} as T, status: 200 } as AxiosResponse<T>;
      },
    },
  };
};

describe('legacy HTTP transport seam', () => {
  afterEach(() => {
    // `tests/setup.ts` is the suite's composition root; restore what it registered.
    setLegacyHttpTransport(createAxiosLegacyTransport());
  });

  it('should explain how to register a transport when none is configured', () => {
    clearLegacyHttpTransport();
    expect(() => getLegacyHttpTransport()).toThrow(/not registered/);
    expect(() => getLegacyHttpTransport()).toThrow(/setLegacyHttpTransport/);
  });

  it('should route u_common through the registered transport and its defaults', async () => {
    const { transport, calls } = createRecordingTransport();
    setLegacyHttpTransport(transport);

    await u_common({ method: 'post', options: { params: { song: 'mid' } } });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://u.example.test/cgi-bin/musicu.fcg',
      method: 'post',
      target: 'u',
    });
    expect(calls[0].options).toMatchObject({
      params: { song: 'mid' },
      g_tk: 7,
      platform: 'yqq.json',
      headers: {
        referer: 'https://y.example.test/portal/player.html',
        host: 'u.y.qq.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
  });

  it('should route y_common through the registered transport and honour hasCommonParams', async () => {
    const { transport, calls } = createRecordingTransport();
    setLegacyHttpTransport(transport);

    await y_common({ url: '/v8/fcg-bin/example.fcg', options: { params: { id: 1 } } });
    await y_common({ url: '/v8/fcg-bin/example.fcg', hasCommonParams: false });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: '/v8/fcg-bin/example.fcg', method: 'get' });
    expect(calls[0].target).toBeUndefined();
    expect(calls[0].options).toMatchObject({
      g_tk: 7,
      headers: { referer: 'https://c.example.test/', host: 'c.y.qq.com' },
    });
    expect(calls[1].options).not.toHaveProperty('g_tk');
  });

  it('should expose the live config values through the axios transport defaults', async () => {
    const { requestConfig, apiConfig } = await import('../src/config');
    const { defaults, kind } = createAxiosLegacyTransport();

    expect(kind).toBe('axios');
    expect(defaults.baseURL).toEqual({
      y: requestConfig.baseURL.y,
      c: requestConfig.baseURL.c,
      u: requestConfig.baseURL.u,
    });
    expect(defaults.referer).toEqual(requestConfig.referer);
    expect(defaults.commonParams).toEqual(apiConfig.commonParams);
  });
});

describe('legacy transport axios and prototype isolation', () => {
  it('should leave the host axios defaults untouched when the transport is registered', async () => {
    await jest.isolateModulesAsync(async () => {
      const { default: sharedAxios } = await import('axios');
      sharedAxios.defaults.withCredentials = false;
      sharedAxios.defaults.timeout = 4321;
      sharedAxios.defaults.responseType = 'text';
      sharedAxios.defaults.headers.post['Content-Type'] = 'application/host-test';
      const pristine = JSON.stringify(sharedAxios.defaults);

      const { createAxiosLegacyTransport: create } = await import('../src/util/request');
      const { setLegacyHttpTransport: register } = await import('../src/services/httpTransport');
      register(create());

      expect(JSON.stringify(sharedAxios.defaults)).toEqual(pristine);
    });
  });

  it('should not load the colors side effect through the legacy request module', async () => {
    await jest.isolateModulesAsync(async () => {
      let colorsLoaded = false;
      jest.doMock('colors', () => {
        colorsLoaded = true;
        return { setTheme: () => undefined };
      });

      await import('../src/util/request');

      // `colors` patches `String.prototype`; only the Koa entry point may pull it in.
      expect(colorsLoaded).toBe(false);
    });
  });

  it('should keep the transport registry free of runtime imports', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'httpTransport.ts'),
      'utf8',
    );
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^\s*(import|const .*=\s*require\()/.test(line))
      .filter((line) => !/^\s*import type\b/.test(line));

    expect(runtimeImports).toEqual([]);
  });
});
