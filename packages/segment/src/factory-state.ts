import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const run = (args: string[], cwd: string, input?: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  const p = spawn('tar', args, { cwd });
  const out: Buffer[] = []; let err = '';
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => (err += d));
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`tar failed (${code}): ${err.slice(0, 200)}`))));
  if (input) p.stdin.end(input); else p.stdin.end();
});

/** The factory keeps its work items in a gitignored .swamp directory. Segments are disposable, so that state travels through S3. */
export async function packFactoryState(factoryDir: string): Promise<Buffer | undefined> {
  if (!existsSync(join(factoryDir, '.swamp'))) return undefined;
  return run(['-czf', '-', '.swamp'], factoryDir);
}

export async function unpackFactoryState(factoryDir: string, tgz: Buffer): Promise<void> {
  await run(['-xzf', '-'], factoryDir, tgz);
}
