import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { JSDOM } = require('jsdom');
const html = readFileSync(join(process.cwd(), 'public/explorer/index.html'), 'utf8');
const source = readFileSync(join(process.cwd(), 'public/explorer/app.js'), 'utf8').replace(
  '  initialize();\n})();',
  "  Object.defineProperty(window, '__requestLogs', { get: () => state.requestLogs });\n  initialize();\n})();",
);

describe('Explorer 播放日志隐私', () => {
  it.each(['/getEncryptedMusicPlay', '/getMusicPlay'])('成功请求只记录安全信息', async (route) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const { window } = dom;
    const logged: unknown[] = [];
    window.console.log = (...args: unknown[]) => logged.push(args);
    window.HTMLElement.prototype.scrollIntoView = () => undefined;
    const sensitive = ['fixture-secret-song', 'fixture-secret-key', 'fixture-secret-token', 'fixture-secret-link'];
    const responseBody = { data: { playUrl: { [sensitive[0]]: { url: sensitive[3], ekey: sensitive[1] } } } };
    const endpoint = {
      id: 'play', name: route.slice(1), path: route, method: 'GET', category: 'playback',
      queryParams: [
        { key: 'songmid', label: '歌曲', defaultValue: sensitive[0] },
        { key: 'token', label: '会话', defaultValue: sensitive[2] },
      ],
    };
    window.fetch = async (input: string) => input === '/explorer/metadata'
      ? { json: async () => ({ title: 'Explorer', description: '', endpoints: [endpoint] }) }
      : { status: 200, text: async () => JSON.stringify(responseBody) };
    window.eval(source);
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.document.getElementById('send-request').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retained = JSON.stringify({ logs: window.__requestLogs, console: logged, rendered: window.document.getElementById('request-log-list').textContent });
    expect(sensitive.some((value) => retained.includes(value))).toBe(false);
    expect(/songmid|ekey|token|\?/.test(retained)).toBe(false);
    expect(window.document.getElementById('response-preview').textContent.includes(sensitive[3])).toBe(true);
    dom.window.close();
  });
});
