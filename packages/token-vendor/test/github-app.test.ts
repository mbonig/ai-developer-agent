import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { signAppJwt, vendToken, TOKEN_PERMISSIONS, BASE_PERMISSIONS } from '../src/github-app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('JWT verifies with the public key and has the right claims', () => {
  const jwt = signAppJwt('123', pem, 1_000_000);
  const [h, b, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: '123' });
});

test('token request is scoped to one repo with minimum permissions', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ token: 'tok', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' } }), { status: 201 });
  }) as unknown as typeof fetch;
  const t = await vendToken({ installationId: 42, repo: 'app' }, '123', pem, fakeFetch);
  assert.deepEqual(t, { token: 'tok', expiresAt: '2030-01-01T00:00:00Z', permissions: { contents: 'write' } });
  assert.equal(seen!.url, 'https://api.github.com/app/installations/42/access_tokens');
  assert.deepEqual(JSON.parse(seen!.init.body as string), { repositories: ['app'], permissions: TOKEN_PERMISSIONS });
});

test('rejects bad input and GitHub errors', async () => {
  await assert.rejects(vendToken({ installationId: 1, repo: 'a/b' }, '1', pem), /invalid/);
  const bad = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(vendToken({ installationId: 1, repo: 'app' }, '1', pem, bad), /404/);
});

test('if the installation has not accepted the Workflows permission, the token falls back to the base permissions instead of failing', async () => {
  const asked: Array<Record<string, string>> = [];
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    const perms = JSON.parse(init.body as string).permissions as Record<string, string>; asked.push(perms);
    return perms.workflows ? new Response('{"message":"permissions not granted"}', { status: 422 })
      : new Response(JSON.stringify({ token: 'tok', expires_at: '2030-01-01T00:00:00Z' }), { status: 201 });
  }) as unknown as typeof fetch;
  const t = await vendToken({ installationId: 42, repo: 'app' }, '123', pem, fakeFetch);
  assert.equal(t.token, 'tok');
  assert.deepEqual(asked, [{ ...TOKEN_PERMISSIONS }, { ...BASE_PERMISSIONS }]);
  assert.ok('workflows' in asked[0] && !('workflows' in asked[1]));

  const always422 = (async () => new Response('no', { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(vendToken({ installationId: 1, repo: 'app' }, '1', pem, always422), /422/);   // a real refusal still surfaces
});
