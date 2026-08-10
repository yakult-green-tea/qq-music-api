import { type LegacyHttpTransport, setLegacyHttpTransport } from '../src/services/httpTransport';

// Jest runs the catalog services without loading `src/app.ts`, so the suite acts as its own
// composition root and registers the same axios transport the Node entry point does.
//
// The axios transport is resolved lazily on first use. Importing it here would pull `src/util/*`
// into every suite's module registry before the suite's own `jest.mock()` calls are applied, and
// the already-resolved bindings inside those cached modules would silently ignore the mocks.
const resolveAxiosTransport = (): LegacyHttpTransport => {
  const { createAxiosLegacyTransport } = require('../src/util/request') as {
    createAxiosLegacyTransport: () => LegacyHttpTransport;
  };
  return createAxiosLegacyTransport();
};

setLegacyHttpTransport({
  kind: 'axios',
  get defaults() {
    return resolveAxiosTransport().defaults;
  },
  request: (url, method, options, target) =>
    resolveAxiosTransport().request(url, method, options, target),
});
