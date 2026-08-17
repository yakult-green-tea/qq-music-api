import { createFetchAuthHttpClient } from '../src/serverless/fetchAuthHttpClient';
import { createFetchLegacyTransport } from '../src/serverless/fetchLegacyTransport';

// These two clients exist because `fetch` cannot be asked to both follow redirects and reveal the
// `set-cookie` headers deposited along the way, which is exactly what the QQ login flow needs.
// The assertions below are mostly about that seam, not about HTTP in general.

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const calls: Call[] = [];
const responses: Response[] = [];

const respond = (
  body: string,
  init: { status?: number; headers?: Record<string, string>; setCookie?: string[] } = {},
): Response => {
  const headers = new Headers(init.headers ?? {});
  for (const cookie of init.setCookie ?? []) headers.append('set-cookie', cookie);
  return new Response(body, { status: init.status ?? 200, headers });
};

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  // `RequestInfo` is a DOM type and this project's lib is `es2022`, so the signature is taken
  // from `fetch` itself rather than named.
  global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const next = responses.shift();
    if (!next) throw new Error('no queued response');
    return next;
  }) as unknown as typeof fetch;
});

describe('createFetchAuthHttpClient', () => {
  it('should parse a JSON body into the axios response shape', async () => {
    responses.push(respond(JSON.stringify({ code: 0 })));

    const response = await createFetchAuthHttpClient().request({
      url: 'https://example.invalid/api',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ code: 0 });
  });

  it('should fall back to raw text when a JSON response is script text', async () => {
    // Several upstream login endpoints answer with `ptuiCB('...')` rather than JSON.
    responses.push(respond("ptuiCB('0','0','https://example.invalid')"));

    const response = await createFetchAuthHttpClient().request({
      url: 'https://example.invalid/api',
    });

    expect(response.data).toContain('ptuiCB');
  });

  it('should follow redirects manually so cookies on every hop reach the jar', async () => {
    // 🔴 The reason this client exists. `redirect: "follow"` would swallow the first hop's
    // `set-cookie` entirely, and the login flow depends on collecting them across hops.
    responses.push(
      respond('', {
        status: 302,
        headers: { location: 'https://example.invalid/second' },
        setCookie: ['first=1; Path=/', 'shared=a; Path=/'],
      }),
    );
    responses.push(respond('{}', { setCookie: ['second=2; Path=/', 'shared=b; Path=/'] }));

    const client = createFetchAuthHttpClient();
    await client.request({ url: 'https://example.invalid/first' });

    expect(calls).toHaveLength(2);
    expect(calls[0].headers['redirect'] ?? 'manual').toBeDefined();
    expect(calls[1].url).toBe('https://example.invalid/second');
    // The second hop must already carry what the first hop set.
    expect(calls[1].headers.cookie).toContain('first=1');
    // A later hop overwrites an earlier value for the same name.
    expect(client.getCookieHeader()).toContain('shared=b');
    expect(client.getCookieHeader()).toContain('second=2');
  });

  it('should downgrade POST to GET on a 302 and drop the body', async () => {
    responses.push(
      respond('', { status: 302, headers: { location: 'https://example.invalid/second' } }),
    );
    responses.push(respond('{}'));

    await createFetchAuthHttpClient().post('https://example.invalid/first', { a: 1 });

    expect(calls[0].method).toBe('POST');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toBeUndefined();
  });

  it('should preserve the method and body on a 307', async () => {
    responses.push(
      respond('', { status: 307, headers: { location: 'https://example.invalid/second' } }),
    );
    responses.push(respond('{}'));

    await createFetchAuthHttpClient().post('https://example.invalid/first', { a: 1 });

    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toBe(JSON.stringify({ a: 1 }));
  });

  it('should give up rather than loop on an endless redirect chain', async () => {
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        respond('', { status: 302, headers: { location: 'https://example.invalid/next' } }),
      );
    }

    await expect(
      createFetchAuthHttpClient().request({ url: 'https://example.invalid/first' }),
    ).rejects.toThrow('redirect limit exceeded');
  });

  it('should merge an explicitly supplied cookie header with the jar', async () => {
    responses.push(respond('{}', { setCookie: ['jar=1; Path=/'] }));
    responses.push(respond('{}'));

    const client = createFetchAuthHttpClient();
    await client.request({ url: 'https://example.invalid/first' });
    await client.request({
      url: 'https://example.invalid/second',
      headers: { Cookie: 'explicit=2' },
    });

    expect(calls[1].headers.cookie).toContain('jar=1');
    expect(calls[1].headers.cookie).toContain('explicit=2');
  });

  it('should fold params into the query string', async () => {
    responses.push(respond('{}'));

    await createFetchAuthHttpClient().request({
      url: 'https://example.invalid/api',
      params: { a: 1, skipped: undefined },
    });

    expect(calls[0].url).toBe('https://example.invalid/api?a=1');
  });

  it('should reject an error status the same way the axios client does', async () => {
    responses.push(respond('nope', { status: 500 }));

    await expect(
      createFetchAuthHttpClient().request({ url: 'https://example.invalid/api' }),
    ).rejects.toThrow('status 500');
  });

  it('should attach an abort signal to every request', async () => {
    responses.push(respond('{}'));

    await createFetchAuthHttpClient().request({ url: 'https://example.invalid/api' });

    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('createFetchLegacyTransport', () => {
  it('should carry the defaults the catalog services read from the seam', () => {
    const { defaults, kind } = createFetchLegacyTransport();

    expect(kind).toBe('fetch');
    expect(defaults.baseURL.y).toBe('https://y.qq.com');
    expect(defaults.baseURL.c).toBe('https://c.y.qq.com');
    expect(defaults.baseURL.u).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
    expect(defaults.commonParams.platform).toBe('yqq.json');
  });

  it('should prefix a relative path with the target base URL', async () => {
    responses.push(respond('{}'));
    responses.push(respond('{}'));

    const transport = createFetchLegacyTransport();
    await transport.request('/cgi-bin/x', 'get', {}, 'c');
    await transport.request('/cgi-bin/y', 'get', {}, 'y');

    expect(calls[0].url).toBe('https://c.y.qq.com/cgi-bin/x');
    expect(calls[1].url).toBe('https://y.qq.com/cgi-bin/y');
  });

  it('should treat the u target as an absolute musicu endpoint', async () => {
    responses.push(respond('{}'));

    await createFetchLegacyTransport().request('', 'post', { data: { a: 1 } }, 'u');

    expect(calls[0].url).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
    expect(calls[0].method).toBe('POST');
  });

  it('should set the referer the upstream expects for the target', async () => {
    responses.push(respond('{}'));

    await createFetchLegacyTransport().request('/cgi-bin/x', 'get', {}, 'c');

    expect(calls[0].headers.referer).toBe('https://c.y.qq.com/');
  });

  it('should adapt the response into the axios shape the services annotate', async () => {
    responses.push(respond(JSON.stringify({ code: 0, data: { ok: true } })));

    const response = await createFetchLegacyTransport().request('/cgi-bin/x', 'get', {}, 'c');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ code: 0, data: { ok: true } });
  });
});
