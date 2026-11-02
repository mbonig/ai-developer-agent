# Registering the GitHub App

You create the App once. It is installed on the `mbonig` account or org (configurable through `GITHUB_ORG`) and works for every repo it is installed on.

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
For an org, use the org's Settings → Developer settings instead.

| Field | Value |
|---|---|
| GitHub App name | anything unique, for example `mbonig-issue-agent` |
| Homepage URL | any URL, for example the repo URL |
| Webhook → Active | checked |
| Webhook URL | `https://lhqe4jrnsznp6jtddpqahlpnw40slpnt.lambda-url.us-west-2.on.aws/` (the deployed ingress, us-west-2) |
| Webhook secret | a long random string. Generate one with `openssl rand -hex 32` and keep it for step 3. |
| Where can this App be installed | **Only on this account** |

## 2. Permissions and events

**Repository permissions**

| Permission | Access |
|---|---|
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only (selected automatically) |

**Subscribe to events**

- Issues
- Issue comment
- Pull request
- Pull request review
- Pull request review comment

Leave everything else off.

## 3. Collect these values

1. **App ID** (shown on the App's settings page).
2. A **private key**: on the same page, under Private keys, click **Generate a private key**. A `.pem` file downloads.
3. The **webhook secret** from step 1.
4. After installing (step 4), the **installation ID**. It is the number at the end of the installation URL. The agent also reads it from each webhook, so I do not need it for deployment.

## 4. Install the App

App settings → **Install App** → choose the account → **Only select repositories** is recommended while testing. Pick a sandbox repo first.

## 5. Hand over the secrets without pasting them in chat

Run these yourself. They write straight into AWS and nothing passes through me. The stacks are deployed and have created the secrets with placeholder values. Overwrite them:

```bash
export AWS_PROFILE=AdministratorAccess-071128183726 AWS_REGION=us-west-2
aws secretsmanager put-secret-value --secret-id ai-developer-agent/github-app-private-key \
  --secret-string file:///path/to/your-app.private-key.pem
aws secretsmanager put-secret-value --secret-id ai-developer-agent/github-webhook-secret \
  --secret-string 'THE-WEBHOOK-SECRET'
```

The App ID is not secret. Send it to me in chat, or redeploy yourself with `cd packages/infra && npx cdk deploy AgentState --exclusively -c githubAppId=<id>`.

## 6. Start a run

1. Create the label `agent` on the repo (name configurable through `AGENT_LABEL`).
2. Open an issue, then apply the label.
3. The agent comments with questions or opens a PR.

Only comments from the repo's OWNER, MEMBER, or COLLABORATOR authors are acted on. Bot comments are always ignored.
