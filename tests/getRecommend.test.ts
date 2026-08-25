const mockUCommon = jest.fn();

jest.mock('../src/services', () => {
  const actual = jest.requireActual('../src/services');
  return {
    __esModule: true,
    default: {
      ...actual.default,
      UCommon: mockUCommon,
    },
  };
});

import request from 'supertest';
import app from '../src/app';

const server = app.callback();

describe('GET /getRecommend', () => {
  beforeEach(() => {
    mockUCommon.mockReset();
    mockUCommon.mockResolvedValue({ data: { code: 0, recomPlaylist: { data: [] } } });
  });

  it('正常流程: 验证接口能否正确返回业务数据', async () => {
    const response = await request(server).get('/getRecommend');
    expect(response.status).toBe(200);
    expect(response.body.response.code).toBe(0);
  });

  it('边界条件: 验证参数为空时的表现', async () => {
    const response = await request(server).get('/getRecommend?limit=0&page=-1');
    expect(response.status).toBe(200);
  });

  it('异常输入: 传入非法参数', async () => {
    const response = await request(server).get('/getRecommend?id=invalid_!@#');
    expect(response.status).toBe(200);
  });
});
