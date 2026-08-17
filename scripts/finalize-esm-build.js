const fs = require('node:fs');
const path = require('node:path');

// TypeScript emits ES modules with the relative specifiers exactly as written — `./router`, not
// `./router.js`. Bundlers resolve that, but Node's own ESM resolver does not, so a published
// artifact that is only ever bundled would still fail the moment anyone imported it directly.
// This rewrites the specifiers and marks the directory as ESM.
//
// Only relative specifiers are touched. Bare specifiers stay untouched, and there should be none:
// the serverless graph is asserted to carry zero npm packages.

const esmDir = path.join(process.cwd(), 'dist-esm');

const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.[^'"]*)(\2)/g;

const resolveSpecifier = (fileDir, specifier) => {
  if (specifier.endsWith('.js') || specifier.endsWith('.json')) return specifier;
  // A directory import means its index file; anything else is a module that needs its extension.
  const target = path.join(fileDir, specifier);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return `${specifier}/index.js`;
  return `${specifier}.js`;
};

const listJsFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });

if (!fs.existsSync(esmDir)) {
  throw new Error('dist-esm is missing; run the ESM compile before finalizing it.');
}

let rewritten = 0;
for (const filePath of listJsFiles(esmDir)) {
  const source = fs.readFileSync(filePath, 'utf8');
  const fileDir = path.dirname(filePath);
  const updated = source.replace(RELATIVE_IMPORT, (_match, keyword, quote, specifier) => {
    rewritten += 1;
    return `${keyword}${quote}${resolveSpecifier(fileDir, specifier)}${quote}`;
  });
  if (updated !== source) fs.writeFileSync(filePath, updated, 'utf8');
}

// Without this, Node reads `.js` under this directory as CommonJS and every import above fails.
fs.writeFileSync(
  path.join(esmDir, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  'utf8',
);

process.stdout.write(`finalize-esm-build: rewrote ${rewritten} relative specifiers\n`);
