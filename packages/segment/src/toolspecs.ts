import type { Phase } from '@agent/shared';
import type { WorkMode } from './mode.ts';

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const s = (description: string) => ({ type: 'string', description });

export interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }

const VIEW: ToolSpec = { name: 'view_image', description: 'Look at an image file (png, jpg, gif, webp, up to 3.5 MB).',
  schema: obj({ path: s('Image path relative to the repo root') }, ['path']) };

const common: ToolSpec[] = [
  { name: 'list_files', description: 'List files under a directory (default: repository root), skipping .git and node_modules.',
    schema: obj({ path: s('Directory relative to the repo root') }, []) },
  { name: 'read_file', description: 'Read a file with line numbers. Optionally limit to a line range.',
    schema: obj({ path: s('File path'), start_line: { type: 'integer' }, end_line: { type: 'integer' } }, ['path']) },
  { name: 'view_image', description: 'Look at an image file (png, jpg, gif, webp, up to 3.5 MB). Use it to check screenshots and mock-ups you render before you show them to anyone.',
    schema: obj({ path: s('Image path relative to the repo root') }, ['path']) },
  { name: 'write_file', description: 'Create or overwrite a file. Parent directories are created.',
    schema: obj({ path: s('File path'), content: s('Full file content') }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replace one exact string in a file. Fails unless old_string matches exactly once.',
    schema: obj({ path: s('File path'), old_string: s('Exact text to replace'), new_string: s('Replacement text') }, ['path', 'old_string', 'new_string']) },
  { name: 'grep', description: 'Search file contents with ripgrep. Returns file:line:text matches.',
    schema: obj({ pattern: s('Regex pattern'), path: s('Directory or file'), glob: s('Glob filter, e.g. *.ts') }, ['pattern']) },
  { name: 'run_command', description: 'Run a shell command in the repository root (tests, builds, git status). Credentials are not available. Times out.',
    schema: obj({ command: s('Shell command') }, ['command']) },
  { name: 'ask_questions', description: 'Ask the humans on the issue or pull request questions and stop working until they reply. Use only when blocked.',
    schema: obj({ markdown: s('The questions, as markdown') }, ['markdown']) },
];

const SUBAGENT: ToolSpec = {
  name: 'run_subagent',
  description: 'Run an independent reviewer or researcher in a clean session with read-only intent (it can read files, search, and run read-only commands, but is told not to modify anything). It starts with no memory of this conversation, so give it everything it needs: the instructions (its role and which skill file to read) and the task. Returns its written report. Use it for the factory stages that dispatch reviewers, once per reviewer lens.',
  schema: obj({ instructions: s('The subagent\'s role and rules, for example the stage system prompt plus the path of the reviewer skill file to read first'), task: s('What to review or investigate, with the paths and commits it needs') }, ['instructions', 'task']),
};

export const REPORT_SPEC: ToolSpec = {
  name: 'report', description: 'Deliver your final report and end this session.',
  schema: obj({ markdown: s('The report, in markdown') }, ['markdown']),
};

/** Tools a subagent may use: reading, searching and running commands, plus its terminal report. */
export const subagentToolSpecs = (): ToolSpec[] =>
  [...common.filter((t) => ['list_files', 'read_file', 'grep', 'run_command'].includes(t.name)), VIEW, REPORT_SPEC];

export function toolSpecs(phase: Phase, mode: WorkMode = 'plain'): ToolSpec[] {
  const finish: ToolSpec = phase === 'IMPLEMENT'
    ? { name: 'finish', description: 'Call when the implementation is complete. The harness will open a pull request with this title and body.',
        schema: obj({ title: s('Pull request title'), body: s('Pull request description in markdown') }, ['title', 'body']) }
    : { name: 'finish', description: 'Call when you have addressed the review feedback. The summary is posted on the pull request.',
        schema: obj({ summary: s('Summary of what you changed, in markdown') }, ['summary']) };
  return [...common, ...(mode === 'factory' ? [SUBAGENT] : []), finish];
}

export const TERMINAL = new Set(['ask_questions', 'finish']);
