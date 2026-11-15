import request from 'supertest';

import app from '../src/app';
import { logger } from '../src/util/logger';

const server = app.callback();

describe('Explorer routes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('播放接口的说明与字段使用简体中文', async () => {
    const response = await request(server).get('/explorer/metadata');
    const endpoints = response.body.endpoints as Array<Record<string, any>>;
    const normal = endpoints.find((endpoint) => endpoint.name === 'getMusicPlay');
    const encrypted = endpoints.find((endpoint) => endpoint.name === 'getEncryptedMusicPlay');
    expect(normal?.description).toContain('播放链接');
    expect(normal?.description).toContain('重试一次');
    expect(encrypted?.description).toContain('加密');
    expect(encrypted?.queryParams.map((field: { label: string }) => field.label)).toEqual([
      '歌曲 MID',
      '音质',
    ]);
  });

  it('应将 /explorer 重定向到静态页面', async () => {
    const loggerSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const response = await request(server).get('/explorer');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/explorer/index.html');
    expect(loggerSpy).toHaveBeenCalledWith(
      '[explorer.server] route-redirect',
      expect.objectContaining({
        from: '/explorer',
        to: '/explorer/index.html',
      }),
    );
  });

  it('应返回 explorer 元数据', async () => {
    const loggerSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const response = await request(server).get('/explorer/metadata');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        title: 'QQ Music API Explorer',
        endpoints: expect.arrayContaining([
          expect.objectContaining({
            id: 'get-search',
            path: '/search',
          }),
          expect.objectContaining({
            id: 'qr-check',
            path: '/login/qr/check',
          }),
          expect.objectContaining({
            id: 'get-user-playlist',
            path: '/user/playlist',
          }),
        ]),
      }),
    );
    expect(loggerSpy).toHaveBeenCalledWith(
      '[explorer.server] route-metadata',
      expect.objectContaining({
        endpointCount: expect.any(Number),
        path: '/explorer/metadata',
        type: 'application/json',
      }),
    );
  });

  it('应返回 explorer 页面静态资源', async () => {
    const response = await request(server).get('/explorer/index.html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('QQ Music API Explorer');
    expect(response.text).toContain('/explorer/app.js');
    expect(response.text).toContain('workspace-toolbar');
    expect(response.text).toContain('method-select');
    expect(response.text).toContain('endpoint-combobox-input');
    expect(response.text).toContain('endpoint-combobox-list');
    expect(response.text).toContain('workspace-params-section');
    expect(response.text).toContain('workspace-results');
    expect(response.text).toContain('workspace-log-card');
    expect(response.text).toContain('log-search-input');
    expect(response.text).toContain('log-filter-group');
    expect(response.text).toContain('request-log-list');
    expect(response.text).toContain('jump-latest-log');
    expect(response.text).toContain('jump-latest-error-log');
    expect(response.text).toContain('data-log-filter="ERROR"');
    expect(response.text).toContain('data-log-filter="PENDING"');
    expect(response.text).toContain('aria-label="搜索并选择接口"');
    expect(response.text).not.toContain('sidebar');
    expect(response.text).not.toContain('endpoint-list');
    expect(response.text).not.toContain('endpoint-select');
    expect(response.text).not.toContain('method-filter');
    expect(response.text).not.toContain('workspace-toolbar-summary');
    expect(response.text).not.toContain('endpoint-count');
    expect(response.text).not.toContain('当前接口');
    expect(response.text).not.toContain('request-section-toggle-button');
    expect(response.text).not.toContain('log-detail-panel');
    expect(response.text).not.toContain('request-log-detail');
    expect(response.text).not.toContain('workspace-tab-list');
  });

  it('应在首页展示 Explorer 入口链接', async () => {
    const response = await request(server).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('进入 API Explorer');
    expect(response.text).toContain('核心能力');
    expect(response.text).toContain('快速试用');
  });
});
