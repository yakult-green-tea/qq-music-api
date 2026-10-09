const mockYCommon = jest.fn();

jest.mock('../src/services/y_common', () => ({
  __esModule: true,
  default: mockYCommon,
}));

import request from 'supertest';
import app from '../src/app';
import qrLoginService from '../src/services/auth/qrLogin.node';
import { AuthCredentialRejectedError } from '../src/util/authError';
import aiDissInfo211192 from './fixtures/official-playlists/ai-dissinfo-211192.json';
import fcgCode10 from './fixtures/official-playlists/fcg-code-10.json';

// Koa 这一侧的端到端：真的 controller、真的 service，只把匿名 CGI 和带凭据的读取换成 fixture。
// 重点是重读失败绝不能变成 401 —— Folia 收到 401 会清掉登录态，而这只是一条读歌单的路由。

const server = app.callback();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('GET /getSongListDetail：算法歌单用凭据重读（Node）', () => {
  let readWithCredential: jest.SpyInstance;

  beforeEach(() => {
    mockYCommon.mockReset();
    mockYCommon.mockResolvedValue({ data: clone(fcgCode10) });
    readWithCredential = jest
      .spyOn(qrLoginService, 'getAuthenticatedSongListDetail')
      .mockResolvedValue(clone(aiDissInfo211192.req_0.data));
  });

  afterEach(() => {
    readWithCredential.mockRestore();
  });

  it('带着会话时返回改写后的歌单', async () => {
    const response = await request(server)
      .get('/getSongListDetail/211192')
      .set('X-QQ-Session', 'session-token')
      .expect(200);

    expect(response.body.response.code).toBe(0);
    expect(response.body.response.cdlist[0]).toMatchObject({
      disstid: '211192',
      dissname: '歌手漫游 | 专享歌手Mix',
      total_song_num: 50,
    });
    expect(readWithCredential).toHaveBeenCalledWith('session-token', '211192');
  });

  it('凭据被上游拒绝：仍是 200 加原来的 code 10，不是 401', async () => {
    readWithCredential.mockRejectedValue(new AuthCredentialRejectedError(1000));

    const response = await request(server)
      .get('/getSongListDetail/211192')
      .set('X-QQ-Session', 'session-token')
      .expect(200);

    expect(response.body).toEqual({ response: fcgCode10 });
  });

  it('会话不存在：原样返回 code 10', async () => {
    readWithCredential.mockResolvedValue(null);

    const response = await request(server)
      .get('/getSongListDetail/211192')
      .set('X-QQ-Session', 'unknown-token')
      .expect(200);

    expect(response.body).toEqual({ response: fcgCode10 });
  });

  it('没有会话：不重读，原样返回 code 10', async () => {
    const response = await request(server).get('/getSongListDetail/211192').expect(200);

    expect(response.body).toEqual({ response: fcgCode10 });
    expect(readWithCredential).not.toHaveBeenCalled();
  });

  it('普通歌单（code 0）带着会话也不重读', async () => {
    const publicPlaylist = {
      code: 0,
      cdlist: [{ disstid: '7011264340', dissname: '公开歌单', songlist: [] }],
    };
    mockYCommon.mockResolvedValue({ data: clone(publicPlaylist) });

    const response = await request(server)
      .get('/getSongListDetail/7011264340')
      .set('X-QQ-Session', 'session-token')
      .expect(200);

    expect(response.body).toEqual({ response: publicPlaylist });
    expect(readWithCredential).not.toHaveBeenCalled();
  });
});
