import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * D8: the `exports` contract is tested against the artifact `npm pack` produces, not against the
 * repo source. Those differ in exactly the ways that matter here — `files`, the subpath map and
 * whether the built output is actually present — and a test that imports `src/` would pass while
 * a published package was broken.
 *
 * 🔴 Adding `exports` is the breaking change that makes this a major release: it stops any deep
 * import that is not listed. The assertions below are the contract that justifies 3.0.0.
 */

const repoRoot = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let fixture: string;
let installed: string;

// `npm` is a `.cmd` shim on Windows, which `execFileSync` cannot spawn directly (EINVAL), so the
// shell runs it. That means arguments have to be quoted: the repository path contains a space.
const run = (command: string, args: string[], cwd: string): string =>
  execFileSync(
    command,
    args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)),
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    },
  );

/** Runs the entry point in a child process, because requiring the root binds a port. */
const runInNode = (source: string): { status: number; stdout: string; stderr: string } => {
  const scriptPath = path.join(fixture, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(scriptPath, source, 'utf8');
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
};

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-artifact-'));
  // `npm pack` does not compile; `prepublishOnly` only runs on publish (appendix D #15).
  run(npm, ['run', 'build:js'], repoRoot);
  const packed = run(npm, ['pack', '--silent', '--pack-destination', fixture], repoRoot).trim();
  const tarball = path.join(fixture, packed.split('\n').pop() as string);

  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'artifact-fixture', version: '1.0.0', private: true }),
    'utf8',
  );
  run(npm, ['install', tarball, '--no-package-lock', '--ignore-scripts', '--silent'], fixture);
  installed = path.join(fixture, 'node_modules', '@yakult-green-tea', 'qq-music-api');
}, 600_000);

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('published artifact', () => {
  it('should ship both builds and the hand-pinned root types', () => {
    expect(fs.existsSync(path.join(installed, 'dist/src/app.js'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'dist/src/serverless/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'dist/src/serverless/index.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'dist-esm/src/serverless/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'types/root.d.ts'))).toBe(true);
  });

  it('should keep the root entry resolvable by require, which is Electron lifeline', () => {
    // §5.3 #7. `main` stays, and `.` resolves to the same CJS file it always did.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
    ) as Record<string, any>;

    expect(manifest.main).toBe('dist/src/app.js');
    expect(manifest.exports['.'].require).toBe('./dist/src/app.js');
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  it('should still listen and export the repository hook when the root is required', () => {
    const result = runInNode(`
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const root = require('@yakult-green-tea/qq-music-api');
      const shape = {
        hasDefault: typeof (root.default ?? root) === 'object',
        configure: typeof root.configureAuthSessionRepository,
        // NODE_ENV=test keeps it from binding a port; the export must still exist and be null.
        server: root.server === null ? 'null' : typeof root.server,
      };
      console.log(JSON.stringify(shape));
    `);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hasDefault: true,
      configure: 'function',
      server: 'null',
    });
  });

  it('should expose ./serverless without starting a server or loading Koa', () => {
    // The whole point of the subpath: importing it must not do any of the things the root does.
    const result = runInNode(`
      const before = process.getActiveResourcesInfo?.() ?? [];
      const mod = await import('@yakult-green-tea/qq-music-api/serverless');
      const after = process.getActiveResourcesInfo?.() ?? [];
      const loaded = Object.keys(await import('node:module').then((m) => m).catch(() => ({})));
      console.log(JSON.stringify({
        handler: typeof mod.handleRequest,
        // Nothing may be left running: no listening socket, no timer, no websocket.
        leakedResources: after.filter((r) => !before.includes(r)),
      }));
    `);

    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.handler).toBe('function');
    expect(observed.leakedResources).toEqual([]);
  });

  it('should answer a request through the packaged serverless entry', () => {
    const result = runInNode(`
      const { handleRequest } = await import('@yakult-green-tea/qq-music-api/serverless');
      const response = await handleRequest(
        new Request('https://worker.invalid/login/channels'),
        { QQ_SESSION_SECRET: 'a-secret' },
      );
      console.log(JSON.stringify(await response.json()));
    `);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      code: 200,
      data: { channels: ['wechat'], sessionMode: 'sealed', configured: true },
    });
  });

  it('should refuse a deep import that the exports map does not list', () => {
    // 🔴 This is the breaking part of the change, asserted rather than assumed.
    const result = runInNode(`
      try {
        await import('@yakult-green-tea/qq-music-api/dist/src/services/auth/qrLogin.js');
        console.log('resolved');
      } catch (error) {
        console.log(error.code ?? 'threw');
      }
    `);

    expect(result.stdout.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
