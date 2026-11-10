export interface GithubApi {
  /** Posts a comment once per marker (check-then-act). Returns true if a comment was created. */
  postComment(a: { installationId: number; owner: string; repo: string; number: number; body: string; marker: string }): Promise<boolean>;
  /** Opens a PR for `head` unless one already exists for that head branch. Returns the PR number, or undefined when the branch has no commits to propose. */
  /** Replaces the `<!-- marker:start -->...<!-- marker:end -->` block of a PR description, or appends it. Safe to repeat. */
  upsertPrSection(a: PrSection): Promise<void>;
  openPr(a: { installationId: number; owner: string; repo: string; head: string; title: string; body: string; draft: boolean }): Promise<number | undefined>;
}

export interface PrSection { installationId: number; owner: string; repo: string; number: number; marker: string; markdown: string }

export type TokenFn = (installationId: number, repo: string) => Promise<string>;

export const markerComment = (marker: string) => `<!-- agent:${marker} -->`;

export function createGithubApi(getToken: TokenFn, fetchImpl: typeof fetch = fetch): GithubApi {
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-developer-agent',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path} failed: ${r.status}`);
    return r.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const graphql = async (token: string, query: string, variables: Record<string, unknown>) => {
    const r = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ai-developer-agent' },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await r.json()) as { errors?: Array<{ message: string }> };
    if (!r.ok || j.errors?.length) throw new Error(`GitHub GraphQL failed: ${r.status} ${j.errors?.[0]?.message ?? ''}`);
  };

  return {
    async postComment({ installationId, owner, repo, number, body, marker }) {
      const token = await getToken(installationId, repo);
      const tag = markerComment(marker);
      for (let page = 1; ; page++) {
        const items = await call(token, 'GET', `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        if (items.some((c: { body?: string }) => c.body?.includes(tag))) return false;
        if (items.length < 100) break;
      }
      await call(token, 'POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: `${body}\n\n${tag}` });
      return true;
    },

    async upsertPrSection({ installationId, owner, repo, number, marker, markdown }) {
      const token = await getToken(installationId, repo);
      const pr = await call(token, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
      const body: string = pr.body ?? '';
      const next = replaceSection(body, marker, markdown);
      if (next !== body) await call(token, 'PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { body: next });
    },

    async openPr({ installationId, owner, repo, head, title, body, draft }) {
      const token = await getToken(installationId, repo);
      const existing = await call(token, 'GET', `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=all`);
      if (existing.length > 0) {
        const found = existing[0];
        if (found.draft && !draft) { // an earlier session stopped and left a draft: finishing makes it a real pull request
          await call(token, 'PATCH', `/repos/${owner}/${repo}/pulls/${found.number}`, { title, body });
          await graphql(token, 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', { id: found.node_id });
        }
        return found.number as number;
      }
      const info = await call(token, 'GET', `/repos/${owner}/${repo}`);
      const ahead = await call(token, 'GET', `/repos/${owner}/${repo}/compare/${encodeURIComponent(info.default_branch)}...${encodeURIComponent(head)}`).then((c) => c.ahead_by as number, () => 0); // missing branch counts as nothing to propose
      if (ahead === 0) return undefined;
      const pr = await call(token, 'POST', `/repos/${owner}/${repo}/pulls`, { title, body, head, base: info.default_branch, draft });
      return pr.number as number;
    },
  };
}

/** Replaces the marked block if present, else appends it after a blank line. */
export function replaceSection(body: string, marker: string, markdown: string): string {
  const start = `<!-- ${marker}:start -->`; const end = `<!-- ${marker}:end -->`;
  const a = body.indexOf(start); const b = body.indexOf(end);
  if (a !== -1 && b > a) return body.slice(0, a) + markdown + body.slice(b + end.length);
  return `${body.trimEnd()}\n\n${markdown}\n`;
}
