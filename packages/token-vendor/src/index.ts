import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { vendToken, type TokenRequest, type VendedToken } from './github-app.ts';

const secrets = new SecretsManagerClient({});
let keyCache: string | undefined;

// Only this function's role can read the App private key (see the infra stack).
async function privateKey(): Promise<string> {
  keyCache ??= (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.APP_KEY_SECRET_ARN! }))).SecretString!;
  return keyCache;
}

/** Invoked directly (Lambda Invoke) by the orchestrator and segment roles only; there is no public URL. */
export async function handler(event: TokenRequest): Promise<VendedToken> {
  return vendToken(event, process.env.GITHUB_APP_ID!, await privateKey());
}
