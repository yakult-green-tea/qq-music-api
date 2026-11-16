import type { QrLoginService } from '../src/services/auth/qrLogin';

let mockNodeService: QrLoginService;

jest.mock('../src/services/auth/qrLogin.node', () => ({
  __esModule: true,
  get default() {
    return mockNodeService;
  },
  get qrLoginService() {
    return mockNodeService;
  },
  configureAuthSessionRepository: (
    repository: Parameters<QrLoginService['configureAuthSessionRepository']>[0],
  ) => mockNodeService.configureAuthSessionRepository(repository),
}));

import request from 'supertest';
import app from '../src/app';
import { handleRequest, type ServerlessEnv } from '../src/serverless';
import { deriveAndroidDevice } from '../src/serverless/derivedDevice';
import { createSealedSessionResolver } from '../src/serverless/sealedResolver';
import { createMemoryDeviceContextRepository } from '../src/services/auth/deviceContext';
import createAuthHttpClient from '../src/services/auth/httpClient';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../src/services/auth/qrLogin';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW, CONTRACT_SECRET } from './helpers/contractUpstream';

// 云端最近播放（`PlayRecentlyRead.GetPlayRecentlyInfo`）：要登录，只读。Node 与 serverless 跑同一份案例。
// 形状按 2026-11 带会话实测：每个 type 回同一个外壳 `{ type, data: { allItems, songList, albumList, geDanList,
// radioList, mvList, ... }, updateTime, code }`，只有对应那一类有内容。官方页面分页：2 歌曲、3 专辑、4 歌单、
// 5 音乐雷达、6 视频（12 有声节目、1 全部不开放）。名称与 id 都是假数据。

interface Rpc {
  module: string;
  method: string;
  param: Record<string, unknown>;
}
interface Recorded {
  comm: Record<string, unknown>;
  cookie: string | null;
  rpcs: Rpc[];
}
interface Reply {
  httpStatus?: number;
  globalCode?: number;
  code?: number;
  data?: unknown;
}
interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Record<string, any>;
}

const track = (id: number) => ({
  id,
  mid: `fixture-recent-${id}`,
  name: `Fixture recent song ${id}`,
  file: { media_mid: `fixture-media-${id}` },
});
const shell = (type: number, lists: Record<string, unknown> = {}) => ({
  type,
  data: {
    allItems: { commList: [], geDanList: [], nums: {} },
    songList: [],
    albumList: [],
    geDanList: [],
    mvList: [],
    radioList: [],
    listenBookList: [],
    ...lists,
  },
  updateTime: 1790000000,
  code: 0,
});
const SONGS = shell(2, {
  songList: [
    {
      track: track(1),
      lastTime: 1790000001,
      listenCnt: 3,
      lastPlayDevice: 'fixture-private-device',
    },
    {
      track: track(2),
      lastTime: 1790000002,
      listenCnt: 1,
      lastPlayDevice: 'fixture-private-device',
    },
  ],
});
const ALBUMS = shell(3, {
  albumList: [
    {
      id: 301,
      mid: 'fixtureAlbum301',
      name: 'Fixture album',
      singerName: 'Fixture singer',
      num: 12,
      lastTime: 1790000003,
      index: 0,
      pmid: 'fixture-pmid',
      track: { id: 0, mid: '' },
    },
  ],
});
const PLAYLISTS = shell(4, {
  geDanList: [
    {
      id: 401,
      dirId: 5,
      name: 'Fixture playlist',
      pic: 'https://y.gtimg.cn/fixture-playlist.jpg',
      creater: 'Fixture creator',
      num: 30,
      lastTime: 1790000004,
      geDanType: 0,
      dirShow: 1,
      uin: 'fixture-private-uin',
      index: 0,
    },
  ],
});
const RADIOS = shell(5, {
  radioList: [
    {
      id: 501,
      name: 'Fixture radio',
      pic: 'https://y.gtimg.cn/fixture-radio.jpg',
      radioType: 1,
      lastTime: 1790000005,
      singerName: '',
      num: 0,
    },
  ],
});
const MVS = shell(6, {
  mvList: [
    {
      mvInfo: {
        vid: 'fixturevid601',
        name: 'Fixture MV',
        cover_pic: 'https://y.gtimg.cn/fixture-mv.jpg',
        singers: [{ id: 61, mid: 'fixtureSinger61', name: 'Fixture singer', picurl: 'x' }],
        video_pay: { is_pay: 1, price: 600 },
        uploader_encuin: 'fixture-private-uploader',
      },
      lastTime: 1790000006,
    },
  ],
});

describe.each(['node', 'serverless'] as const)('recent plays route: %s', (runtime) => {
  let token: string;
  let recorded: Recorded[];
  let reply: Reply;
  let call: (
    path: string,
    options?: { token?: string; env?: ServerlessEnv },
  ) => Promise<HttpResult>;

  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    if (url.hostname !== 'u.y.qq.com' || url.pathname !== '/cgi-bin/musicu.fcg')
      throw new Error(`Unstubbed request: ${url.origin}${url.pathname}`);
    const payload = JSON.parse(await fetched.text());
    const rpcs: Rpc[] = Object.entries(payload)
      .filter(([key]) => key.startsWith('req_'))
      .map(([, value]) => value as Rpc);
    recorded.push({ comm: payload.comm, cookie: fetched.headers.get('cookie'), rpcs });
    if (reply.httpStatus && reply.httpStatus >= 400)
      return new Response('fixture-private-error-page', { status: reply.httpStatus });
    return Response.json({
      code: reply.globalCode ?? 0,
      req_0: { code: reply.code ?? 0, data: reply.data ?? {} },
    });
  };

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    for (const level of ['debug', 'warn', 'error'] as const)
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockImplementation(upstream);
    recorded = [];
    reply = { data: SONGS };
    const session = {
      token: 'b'.repeat(64),
      credential: CONTRACT_CREDENTIAL,
      device: deviceFixture.device,
      expiresAt: CONTRACT_NOW + 3600000,
    };
    mockNodeService = createQrLoginService({
      http: createAuthHttpClient(),
      createSessionHttp: createAuthHttpClient,
      authSessionRepository: createMemoryAuthSessionRepository([session]),
      deviceRepository: createMemoryDeviceContextRepository(
        await deriveAndroidDevice(CONTRACT_SECRET),
      ),
    });
    token =
      runtime === 'node'
        ? session.token
        : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(
            session,
          );
    app.silent = true;
    call = async (path, options = {}) => {
      const headers: Record<string, string> = {};
      if (options.token) headers['X-QQ-Session'] = options.token;
      if (runtime === 'node') {
        const result = await request(app.callback()).get(path).set(headers);
        return { status: result.status, headers: result.headers, body: result.body };
      }
      const result = await handleRequest(
        new Request(`https://recent.invalid${path}`, { headers }),
        options.env ?? { QQ_SESSION_SECRET: CONTRACT_SECRET },
      );
      return {
        status: result.status,
        headers: Object.fromEntries(result.headers.entries()),
        body: (await result.json()) as HttpResult['body'],
      };
    };
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  it('answers 401 without a session and never reaches the upstream', async () => {
    const result = await call('/user/recent-plays');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await call('/user/recent-plays', { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it.each([
    '/user/recent-plays?type=',
    '/user/recent-plays?type=all',
    '/user/recent-plays?type=audiobook',
    '/user/recent-plays?type=2',
    '/user/recent-plays?type=SONG',
    '/user/recent-plays?type=song&type=album',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await call(path, { token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(recorded).toEqual([]);
  });

  it('reads recent songs by default, once, read-only, with the Android credential', async () => {
    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      type: 'song',
      items: [
        { song: track(1), lastTime: 1790000001, listenCount: 3 },
        { song: track(2), lastTime: 1790000002, listenCount: 1 },
      ],
      total: 2,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rpcs).toEqual([
      {
        module: 'music.musicasset.PlayRecentlyRead',
        method: 'GetPlayRecentlyInfo',
        param: { type: 2, updateTime: 0 },
      },
    ]);
    expect(recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-device');
  });

  it.each([
    [
      'album',
      3,
      ALBUMS,
      [
        {
          id: 301,
          mid: 'fixtureAlbum301',
          name: 'Fixture album',
          singerName: 'Fixture singer',
          lastTime: 1790000003,
        },
      ],
    ],
    [
      'playlist',
      4,
      PLAYLISTS,
      [
        {
          id: 401,
          dirId: 5,
          name: 'Fixture playlist',
          cover: 'https://y.gtimg.cn/fixture-playlist.jpg',
          creator: 'Fixture creator',
          songCount: 30,
          lastTime: 1790000004,
        },
      ],
    ],
    [
      'radio',
      5,
      RADIOS,
      [
        {
          id: 501,
          name: 'Fixture radio',
          cover: 'https://y.gtimg.cn/fixture-radio.jpg',
          radioType: 1,
          lastTime: 1790000005,
        },
      ],
    ],
    [
      'mv',
      6,
      MVS,
      [
        {
          vid: 'fixturevid601',
          name: 'Fixture MV',
          cover: 'https://y.gtimg.cn/fixture-mv.jpg',
          singers: [{ id: 61, mid: 'fixtureSinger61', name: 'Fixture singer' }],
          lastTime: 1790000006,
        },
      ],
    ],
  ])('type=%s asks for type %i and keeps only the public fields', async (type, code, data, items) => {
    reply = { data };

    const result = await call(`/user/recent-plays?type=${type}`, { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, type, items, total: items.length });
    expect(recorded[0].rpcs[0].param).toEqual({ type: code, updateTime: 0 });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('fixture-private');
    expect(text).not.toContain('video_pay');
  });

  it('total counts only what this answer returns', async () => {
    reply = {
      data: shell(2, {
        allItems: { nums: { 2: 2500 } },
        songList: [
          { track: track(1), lastTime: 1 },
          { track: null },
          { track: track(3), lastTime: 3 },
        ],
      }),
    };

    const result = await call('/user/recent-plays?type=song', { token });

    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([
      { song: track(1), lastTime: 1 },
      { song: track(3), lastTime: 3 },
    ]);
    expect(result.body.total).toBe(2);
  });

  it.each([
    ['an empty list', shell(2)],
    ['null', shell(2, { songList: null })],
  ])('nothing played (%s) is a normal empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, type: 'song', items: [], total: 0 });
  });

  it.each([
    ['a non-list', shell(2, { songList: {} })],
    ['nothing readable', shell(2, { songList: [{ track: { id: 1, mid: '' } }] })],
    ['no data object', { type: 2, data: null, code: 0 }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero code inside the data is an upstream failure, not an empty list', async () => {
    reply = { data: { ...shell(2), code: 2001 } };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });

  it('a rejected credential answers 401', async () => {
    reply = { code: 1000 };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    reply = { code: 1101 };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    reply = { httpStatus: 503 };

    const result = await call('/user/recent-plays', { token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless') {
    it('needs the session secret like the other login routes', async () => {
      const result = await call('/user/recent-plays', { token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(recorded).toEqual([]);
    });
  }
});
