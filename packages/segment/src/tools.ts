import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { confinePath, truncateOutput, applyEdit, scrubbedEnv } from './fs-tools.ts';
import { chownNew, type RunAs } from './sandbox.ts';

export interface ToolCtx {
  root: string;
  runCommandTimeoutSeconds: number;
  toolOutputMaxBytes: number;
  /** Environment to scrub for run_command. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** When set, commands run as this unprivileged user and files the harness writes are handed to it. */
  runAs?: RunAs;
}
export interface ToolResult { text: string; isError?: boolean; image?: { format: 'png' | 'jpeg' | 'gif' | 'webp'; bytes: Uint8Array } }
type Input = Record<string, unknown>;
type Tool = (input: Input, c: ToolCtx) => Promise<ToolResult>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
};
const ok = (text: string, c: ToolCtx): ToolResult => ({ text: truncateOutput(text, c.toolOutputMaxBytes) });
const SKIP = new Set(['.git', 'node_modules']);

/** Spawns a command in its own process group, with a timeout that kills the whole group. */
function run(cmd: string, args: string[], c: ToolCtx, opts: { shell?: boolean } = {}): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: c.root, env: { ...scrubbedEnv(c.env ?? process.env), ...(c.runAs ? { HOME: c.runAs.home } : {}) }, uid: c.runAs?.uid, gid: c.runAs?.gid, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell });
    const cap = c.toolOutputMaxBytes * 8;
    let head = ''; let tail = ''; let total = 0; let timedOut = false;
    const take = (d: Buffer) => {
      let s = d.toString('utf8'); total += s.length;
      if (head.length < cap) { const room = cap - head.length; head += s.slice(0, room); s = s.slice(room); }
      if (s) tail = (tail + s).slice(-cap);
    };
    p.stdout!.on('data', take); p.stderr!.on('data', take);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ } }, c.runCommandTimeoutSeconds * 1000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* group already gone */ } // reap stragglers
      resolve({ output: total > head.length + tail.length ? `${head}\n...[output elided]...\n${tail}` : head + tail, code, timedOut });
    });
  });
}

export const tools: Record<string, Tool> = {
  async list_files(i, c) {
    const base = confinePath(c.root, typeof i.path === 'string' ? i.path : '.');
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (out.length < 2000) await walk(full); } else out.push(relative(c.root, full));
      }
    };
    await walk(base);
    return ok(out.slice(0, 2000).sort().join('\n') || '(no files)', c);
  },

  async read_file(i, c) {
    const p = confinePath(c.root, str(i.path, 'path'));
    const lines = (await readFile(p, 'utf8')).split('\n');
    const start = Math.max(1, Number(i.start_line ?? 1));
    const end = Math.min(lines.length, Number(i.end_line ?? lines.length));
    return ok(lines.slice(start - 1, end).map((l, n) => `${start + n}\t${l}`).join('\n'), c);
  },

  async view_image(i, c) {
    const p = confinePath(c.root, str(i.path, 'path'));
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const format = ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' } as const)[ext as 'png'];
    if (!format) throw new Error('view_image supports png, jpg, jpeg, gif and webp files');
    const buf = await readFile(p);
    if (buf.length > 3_500_000) throw new Error(`image is ${buf.length} bytes; the limit is 3500000. Render it smaller.`);
    return { text: `${relative(c.root, p)} (${format}, ${buf.length} bytes) is attached.`, image: { format, bytes: new Uint8Array(buf) } };
  },

  async write_file(i, c) {
    const p = confinePath(c.root, str(i.path, 'path'));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, str(i.content, 'content'));
    if (c.runAs) chownNew(p, c.root, c.runAs);
    return { text: `wrote ${relative(c.root, p)}` };
  },

  async edit_file(i, c) {
    const p = confinePath(c.root, str(i.path, 'path'));
    await writeFile(p, applyEdit(await readFile(p, 'utf8'), str(i.old_string, 'old_string'), str(i.new_string, 'new_string')));
    if (c.runAs) chownNew(p, c.root, c.runAs);
    return { text: `edited ${relative(c.root, p)}` };
  },

  async grep(i, c) {
    const target = relative(c.root, confinePath(c.root, typeof i.path === 'string' ? i.path : '.')) || '.';
    const pattern = str(i.pattern, 'pattern');
    const globArgs = typeof i.glob === 'string' ? ['--glob', i.glob] : [];
    let r;
    try { r = await run('rg', ['--line-number', '--no-heading', '--max-columns', '300', '--glob', '!node_modules', '--glob', '!.git', ...globArgs, '-e', pattern, '--', target], c); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      r = await run('grep', ['-rnE', '--exclude-dir=.git', '--exclude-dir=node_modules', '-e', pattern, '--', target], c); // dev machines without rg
    }
    if (r.code === 1) return { text: 'no matches' };
    if (r.code !== 0) return { text: r.output, isError: true };
    return ok(r.output, c);
  },

  async run_command(i, c) {
    const r = await run('bash', ['-c', str(i.command, 'command')], c);
    const text = truncateOutput(r.output, c.toolOutputMaxBytes);
    if (r.timedOut) return { text: `timed out after ${c.runCommandTimeoutSeconds}s; partial output:\n${text}`, isError: true };
    return { text: `exit code: ${r.code}\n${text}`, isError: r.code !== 0 };
  },
};

export async function execTool(name: string, input: Input, c: ToolCtx): Promise<ToolResult> {
  const t = tools[name];
  if (!t) return { text: `unknown tool ${name}`, isError: true };
  try { return await t(input, c); } catch (e) { return { text: e instanceof Error ? e.message : String(e), isError: true }; }
}

export async function fileExists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }
