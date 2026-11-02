import { createSign } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 GitHub App JWT. GitHub allows at most 10 minutes; clock skew is covered by backdating iat. */
export function signAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

export const TOKEN_PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write' } as const;

export interface TokenRequest { installationId: number; repo: string }
export interface VendedToken { token: string; expiresAt: string }

/** Installation token scoped to exactly one repository with the minimum permissions. */
export async function vendToken(
  req: TokenRequest, appId: string, privateKeyPem: string, fetchImpl: typeof fetch = fetch,
): Promise<VendedToken> {
  if (!Number.isInteger(req.installationId) || !/^[A-Za-z0-9._-]+$/.test(req.repo)) throw new Error('invalid token request');
  const r = await fetchImpl(`https://api.github.com/app/installations/${req.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signAppJwt(appId, privateKeyPem)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-developer-agent',
    },
    body: JSON.stringify({ repositories: [req.repo], permissions: TOKEN_PERMISSIONS }),
  });
  if (!r.ok) throw new Error(`GitHub token request failed: ${r.status}`);
  const j = (await r.json()) as { token: string; expires_at: string };
  return { token: j.token, expiresAt: j.expires_at };
}
