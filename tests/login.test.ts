const mockQrLoginService = {
  createSession: jest.fn(),
  createQr: jest.fn(),
  checkQr: jest.fn(),
  cancelSession: jest.fn(),
  getLoginStatus: jest.fn(),
  getUserDetail: jest.fn(),
  getUserAlbums: jest.fn(),
  getUserLikedSongs: jest.fn(),
  getUserPlaylists: jest.fn(),
  logout: jest.fn(),
};

jest.mock('../src/services/auth/qrLogin', () => {
  const actual = jest.requireActual('../src/services/auth/qrLogin');
  return {
    ...actual,
    __esModule: true,
    default: mockQrLoginService,
    qrLoginService: mockQrLoginService,
  };
});

import request from 'supertest';
import app from '../src/app';
import { QrLoginServiceError } from '../src/services/auth/qrLogin';
import { AuthCredentialRejectedError } from '../src/util/authError';
import { logger } from '../src/util/logger';

const server = app.callback();

describe('QQ login controllers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQrLoginService.createSession.mockResolvedValue('qr-key');
    mockQrLoginService.createQr.mockResolvedValue('data:image/png;base64,fixture');
    mockQrLoginService.checkQr.mockReturnValue({ code: 801, message: 'Waiting for QR scan' });
    mockQrLoginService.getLoginStatus.mockResolvedValue(null);
    mockQrLoginService.getUserDetail.mockResolvedValue(null);
    mockQrLoginService.getUserAlbums.mockResolvedValue(null);
    mockQrLoginService.getUserLikedSongs.mockResolvedValue(null);
    mockQrLoginService.getUserPlaylists.mockResolvedValue(null);
  });

  it('should create a QR key and image with provider-compatible response fields', async () => {
    const keyResponse = await request(server).get('/login/qr/key');
    const imageResponse = await request(server).get('/login/qr/create').query({ key: 'qr-key' });

    expect(keyResponse.status).toBe(200);
    expect(keyResponse.body).toEqual({ code: 200, data: { unikey: 'qr-key' } });
    expect(imageResponse.body).toEqual({
      code: 200,
      data: { qrimg: 'data:image/png;base64,fixture' },
    });
  });

  it('should pass an explicit login channel through and default to the App channel', async () => {
    const wechatResponse = await request(server).get('/login/qr/key').query({ channel: 'wechat' });
    const qqResponse = await request(server).get('/login/qr/key').query({ channel: 'qq' });
    const defaultResponse = await request(server).get('/login/qr/key');

    expect(wechatResponse.status).toBe(200);
    expect(qqResponse.status).toBe(200);
    expect(defaultResponse.status).toBe(200);
    expect(mockQrLoginService.createSession).toHaveBeenNthCalledWith(1, 'wechat');
    expect(mockQrLoginService.createSession).toHaveBeenNthCalledWith(2, 'qq');
    expect(mockQrLoginService.createSession).toHaveBeenNthCalledWith(3, 'qq');
  });

  it('should accept the legacy `mobile` channel and normalize it to `qq`', async () => {
    const response = await request(server).get('/login/qr/key').query({ channel: 'mobile' });

    // 老的 Folia、外部 `VITE_QQ_API_BASE` 部署和 Docker gateway 都还可能送 `mobile`，改名不该把
    // 它们打断；但归一在入口完成，服务层收到的只有 canonical 值。
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ code: 200, data: { unikey: 'qr-key' } });
    expect(mockQrLoginService.createSession).toHaveBeenCalledWith('qq');
  });

  it('should reject a login channel that is not routable', async () => {
    const response = await request(server).get('/login/qr/key').query({ channel: 'telepathy' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 400,
      message: 'channel must be one of qq, wechat',
    });
    expect(mockQrLoginService.createSession).not.toHaveBeenCalled();
  });

  it('should reject QR create, check, and cancel requests without a key', async () => {
    const createResponse = await request(server).get('/login/qr/create');
    const checkResponse = await request(server).get('/login/qr/check');
    const cancelResponse = await request(server).get('/login/qr/cancel');

    expect(createResponse.status).toBe(400);
    expect(checkResponse.status).toBe(400);
    expect(cancelResponse.status).toBe(400);
    expect(createResponse.body).toMatchObject({ code: 400 });
    expect(checkResponse.body).toMatchObject({ code: 400 });
    expect(cancelResponse.body).toMatchObject({ code: 400 });
    expect(mockQrLoginService.cancelSession).not.toHaveBeenCalled();
  });

  it('should cancel one QR session by key and stay idempotent for unknown keys', async () => {
    const first = await request(server).get('/login/qr/cancel').query({ key: 'qr-key' });
    const repeated = await request(server).get('/login/qr/cancel').query({ key: 'never-issued' });

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(first.body).toEqual({ code: 200 });
    expect(repeated.body).toEqual({ code: 200 });
    expect(mockQrLoginService.cancelSession).toHaveBeenNthCalledWith(1, 'qr-key');
    expect(mockQrLoginService.cancelSession).toHaveBeenNthCalledWith(2, 'never-issued');
  });

  it('should keep the cancelled QR key out of the request logs', async () => {
    const loggerSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

    await request(server).get('/login/qr/cancel').query({ key: 'log-secret-cancel-key' });

    const logged = JSON.stringify(loggerSpy.mock.calls);
    expect(logged).not.toContain('log-secret-cancel-key');
    expect(logged).toContain('MASKED');
    loggerSpy.mockRestore();
  });

  it('should return Retry-After when QR creation is backed off', async () => {
    mockQrLoginService.createSession.mockRejectedValue(
      new QrLoginServiceError('backed off', 429, 31000),
    );

    const response = await request(server).get('/login/qr/key');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('31');
    expect(response.body).toEqual(expect.objectContaining({ code: 429, retryAfterMs: 31000 }));
  });

  it('should set an opaque HttpOnly cookie after confirmation and use it for status', async () => {
    mockQrLoginService.checkQr.mockReturnValue({
      code: 803,
      message: 'Authorization login successful',
      cookie: 'qqmusic_session=opaque-token',
    });
    mockQrLoginService.getLoginStatus.mockResolvedValue({ musicid: 123, nickname: '我的 QQ 账号' });
    const agent = request.agent(server);

    const checkResponse = await agent.get('/login/qr/check').query({ key: 'qr-key' });
    const statusResponse = await agent.get('/login/status');

    expect(checkResponse.status).toBe(200);
    expect(checkResponse.headers['set-cookie'][0]).toContain('qqmusic_session=opaque-token');
    expect(checkResponse.headers['set-cookie'][0].toLowerCase()).toContain('httponly');
    expect(statusResponse.body).toEqual({
      code: 200,
      data: { profile: { musicid: 123, nickname: '我的 QQ 账号' } },
    });
    expect(mockQrLoginService.getLoginStatus).toHaveBeenCalledWith('opaque-token');
  });

  it('should accept the opaque cookie query for a cross-origin transport', async () => {
    mockQrLoginService.getUserDetail.mockResolvedValue({ musicid: 123 });

    const response = await request(server)
      .get('/user/detail')
      .query({ cookie: 'qqmusic_session=query-token' });

    expect(response.status).toBe(200);
    expect(mockQrLoginService.getUserDetail).toHaveBeenCalledWith('query-token');
  });

  it('should redact QR keys and opaque cookies from all request logs', async () => {
    const loggerSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    mockQrLoginService.checkQr.mockReturnValue({
      code: 803,
      message: 'Authorization login successful',
      cookie: 'qqmusic_session=log-secret-cookie',
    });

    await request(server).get('/login/qr/check').query({ key: 'log-secret-key' });
    await request(server)
      .get('/login/status')
      .query({ cookie: 'qqmusic_session=log-secret-query' });

    const logged = JSON.stringify(loggerSpy.mock.calls);
    expect(logged).not.toContain('log-secret-key');
    expect(logged).not.toContain('log-secret-cookie');
    expect(logged).not.toContain('log-secret-query');
    expect(logged).toContain('MASKED');
    loggerSpy.mockRestore();
  });

  it('should return unauthenticated status, detail, and playlist responses safely', async () => {
    const statusResponse = await request(server).get('/login/status');
    const detailResponse = await request(server).get('/user/detail');
    const playlistResponse = await request(server).get('/user/playlist');
    const likedResponse = await request(server).get('/user/liked-songs');
    const albumResponse = await request(server).get('/user/albums');

    expect(statusResponse.body).toEqual({ code: 200, data: {} });
    expect(detailResponse.status).toBe(401);
    expect(playlistResponse.status).toBe(401);
    expect(likedResponse.status).toBe(401);
    expect(albumResponse.status).toBe(401);
  });

  it('should answer 401 when the upstream rejects the credential instead of a server error', async () => {
    // 之前这里是 500：客户端只能判成网络故障，于是失效的会话永远清不掉。
    for (const method of [
      'getUserDetail',
      'getUserPlaylists',
      'getUserLikedSongs',
      'getUserAlbums',
    ] as const)
      mockQrLoginService[method].mockRejectedValue(new AuthCredentialRejectedError(1000));

    const cookie = { cookie: 'qqmusic_session=stale-token' };
    const detail = await request(server).get('/user/detail').query(cookie);
    const playlist = await request(server).get('/user/playlist').query(cookie);
    const liked = await request(server).get('/user/liked-songs').query(cookie);
    const albums = await request(server).get('/user/albums').query(cookie);

    for (const response of [detail, playlist, liked, albums]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: 401, message: 'Login required' });
    }
  });

  it('should keep answering 500 for upstream failures that are not credential rejections', async () => {
    // 只有那三个安全码算「凭证被拒」。一次上游抖动不该把用户登出。
    mockQrLoginService.getUserDetail.mockRejectedValue(new Error('upstream exploded'));

    const response = await request(server)
      .get('/user/detail')
      .query({ cookie: 'qqmusic_session=opaque-token' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'upstream exploded' });
  });

  it('should keep /login/status at 200 with an empty payload when the credential was rejected', async () => {
    // Folia 靠 `data.profile` 在不在判断登录态，因此这条路由永远是 200；服务层已经把被拒的凭证
    // 收敛成 null，控制器不需要知道原因。
    mockQrLoginService.getLoginStatus.mockResolvedValue(null);

    const response = await request(server)
      .get('/login/status')
      .query({ cookie: 'qqmusic_session=stale-token' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ code: 200, data: {} });
  });

  it('should return authenticated playlists and clear the session on logout', async () => {
    mockQrLoginService.getUserPlaylists.mockResolvedValue({
      v_playlist: [{ tid: 7, dirName: '我喜欢' }],
      total: 1,
      bFinish: true,
    });

    const playlistResponse = await request(server)
      .get('/user/playlist')
      .query({ cookie: 'qqmusic_session=opaque-token', uid: '123' });
    const logoutResponse = await request(server)
      .get('/logout')
      .query({ cookie: 'qqmusic_session=opaque-token' });

    expect(playlistResponse.body).toEqual({
      code: 200,
      playlist: [{ tid: 7, dirName: '我喜欢' }],
      total: 1,
      more: false,
    });
    expect(mockQrLoginService.getUserPlaylists).toHaveBeenCalledWith('opaque-token', '123');
    expect(logoutResponse.body).toEqual({ code: 200 });
    expect(mockQrLoginService.logout).toHaveBeenCalledWith('opaque-token');
  });

  it('should return a bounded page from the built-in liked songs', async () => {
    mockQrLoginService.getUserLikedSongs.mockResolvedValue({
      songlist: [{ id: 9, mid: 'liked-song-mid' }],
      total_song_num: 163,
      hasmore: 1,
    });

    const response = await request(server)
      .get('/user/liked-songs')
      .query({ cookie: 'qqmusic_session=opaque-token', offset: '100', limit: '500' });

    expect(response.body).toEqual({
      code: 200,
      songs: [{ id: 9, mid: 'liked-song-mid' }],
      total: 163,
      more: true,
    });
    expect(mockQrLoginService.getUserLikedSongs).toHaveBeenCalledWith('opaque-token', 100, 100);
  });

  it('should return favourite albums without leaking the upstream field names', async () => {
    mockQrLoginService.getUserAlbums.mockResolvedValue({
      albumlist: [{ albumid: 88971, albummid: '000MkMni19ClKG', albumname: '范特西' }],
      totalalbum: 37,
      has_more: 1,
    });

    const response = await request(server)
      .get('/user/albums')
      .query({ cookie: 'qqmusic_session=opaque-token', offset: '20', limit: '500' });

    expect(response.body).toEqual({
      code: 200,
      albums: [{ albumid: 88971, albummid: '000MkMni19ClKG', albumname: '范特西' }],
      total: 37,
      more: true,
    });
    // `albumlist` / `totalalbum` / `has_more` are upstream spellings and must not reach callers.
    expect(Object.keys(response.body)).toEqual(['code', 'albums', 'total', 'more']);
    expect(mockQrLoginService.getUserAlbums).toHaveBeenCalledWith('opaque-token', 20, 100);
  });

  it('should report no further pages once the last favourite album has been read', async () => {
    mockQrLoginService.getUserAlbums.mockResolvedValue({
      albumlist: [{ albumid: 88971, albummid: '000MkMni19ClKG' }],
      totalalbum: 2,
      has_more: 0,
    });

    const response = await request(server)
      .get('/user/albums')
      .query({ cookie: 'qqmusic_session=opaque-token', offset: '1', limit: '1' });

    // `has_more` is 0, and offset 1 + 1 row already reaches the total of 2.
    expect(response.body).toMatchObject({ total: 2, more: false });
  });

  it('should surface a failed favourite-album read instead of an empty collection', async () => {
    // A rejected upstream call, a dropped connection and a timeout all arrive here as a
    // rejection. None of them may be reported as "this account has no favourite albums".
    for (const failure of [
      new Error('get-user-favorite-albums failed (HTTP 200, global=4000, code=4000)'),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' }),
    ]) {
      mockQrLoginService.getUserAlbums.mockRejectedValueOnce(failure);

      const response = await request(server)
        .get('/user/albums')
        .query({ cookie: 'qqmusic_session=opaque-token' });

      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('albums');
    }
  });

  it('should tolerate a favourite-album reply whose fields are the wrong shape', async () => {
    // Accepted by upstream, but `albumlist` is not a list and `totalalbum` is not a number.
    mockQrLoginService.getUserAlbums.mockResolvedValue({
      albumlist: { unexpected: true },
      totalalbum: 'many',
    });

    const response = await request(server)
      .get('/user/albums')
      .query({ cookie: 'qqmusic_session=opaque-token' });

    // Never a 500, and never a fabricated total: an unreadable list is an empty one.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ code: 200, albums: [], total: 0, more: false });
  });

  it('should answer with an empty album page rather than failing', async () => {
    mockQrLoginService.getUserAlbums.mockResolvedValue({
      albumlist: [],
      totalalbum: 0,
      has_more: 0,
    });

    const response = await request(server)
      .get('/user/albums')
      .query({ cookie: 'qqmusic_session=opaque-token' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ code: 200, albums: [], total: 0, more: false });
  });
});
