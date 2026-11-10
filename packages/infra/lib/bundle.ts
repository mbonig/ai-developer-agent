import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
const outRoot = resolve(here, '../.build');

/** Bundles a TypeScript entry (and everything it imports, including the AWS SDK) into one ESM file. */
export function bundle(name: string, entry: string, outFile = 'index.mjs'): string {
  const outdir = join(outRoot, name);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  buildSync({
    entryPoints: [resolve(repoRoot, entry)], outfile: join(outdir, outFile), bundle: true, platform: 'node', target: 'node24', format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning', sourcemap: false, legalComments: 'none',
  });
  return outdir;
}

/** Directory holding the Dockerfile and bundled segment server, zipped by the S3 asset. */
export function bundleSegmentImage(): string {
  const dir = bundle('segment-image', 'packages/segment/src/main.ts', 'segment.mjs');
  copyFileSync(resolve(repoRoot, 'packages/segment/Dockerfile'), join(dir, 'Dockerfile'));
  return dir;
}
