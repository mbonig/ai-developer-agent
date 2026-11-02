# Spike findings (from AWS docs; nothing deployed yet)

## 0.1 Durable functions (TypeScript)
- Package `@aws/durable-execution-sdk-js`; handler wrapped with `withDurableExecution(async (event, ctx: DurableContext) => ...)`.
- `ctx.step`, `ctx.wait`, `ctx.waitForCallback(name, submitter(callbackId, ctx), { timeout })`, `ctx.createCallback`, `ctx.map` all exist. Failures surface as `CallbackError`.
- The submitter runs as a step, after the callback ID exists. Docs do not say whether the callback can be completed from inside its own submitter. **Unverified without a deployment.**
- CDK support for durable functions was not checked.
- CDK: `lambda.Function` accepts `durableConfig` and attaches the durable-execution managed policy itself. A function with `durableConfig` cannot have an explicit `functionName`.
- **Decision (changed):** the orchestrator does not complete a callback from inside its own submitter. It uses `createCallback`, parks with a conditional write, and if the park fails it completes its own callback from a separate step. Verified against the SDK's local test runner (`durable-selfwake.test.ts`). Not yet verified on the real service.

## 0.2 Lambda MicroVMs
- API actions: RunMicrovm, TerminateMicrovm, ListMicrovms, GetMicrovm, SuspendMicrovm, ResumeMicrovm, CreateMicrovmAuthToken (proxy auth token), plus image APIs.
- Idle policy: `autoResumeEnabled`, `maxIdleDurationSeconds` (min 60), `suspendedDurationSeconds`. **Idle is measured by inbound traffic through the proxy endpoint**, so an outbound-only workload would be suspended. Docs advise disabling auto-suspension or setting a long idle duration for async workloads. The design's mitigation (`maxIdleDurationSeconds >= SEGMENT_TIMEOUT`) fits. Max lifetime is 8 hours.
- CloudFormation: `AWS::Lambda::MicrovmImage` exists and `aws_lambda.CfnMicrovmImage` is in aws-cdk-lib. `GetAtt LatestActiveImageVersion` supplies the version for `RunMicrovm`.
- Launch flow: `RunMicrovm` (idle policy, role, client token) -> poll `GetMicrovm` until RUNNING -> `CreateMicrovmAuthToken` (port-scoped, 15 min) -> POST `<endpoint>/segment` with `X-aws-proxy-auth`. Default proxy port is 8080. Hooks live under `/aws/lambda-microvms/runtime/v1/`.
- CPU/memory are properties of the **image** (`minimumMemoryInMiB`), not of `RunMicrovm`. `MICROVM_VCPU` is therefore not a runtime setting. Only ARM_64 is supported.
- Egress to the public internet is on by default.
- **Verified on a real deployment (us-west-2, account 071128183726):**
  1. **Idle is traffic-based.** A VM with `maxIdleDurationSeconds=60` and no traffic was terminated. A 7200-second idle policy is accepted, so production VMs stay up for the whole segment timeout.
  2. **The endpoint is a bare hostname** (no `https://`). The launcher adds the scheme.
  3. **Credentials are exposed to every process** through an IMDSv2-style metadata service at 169.254.169.254, which lists the execution role. The agent's shell could therefore have read the segment role.
  4. **The kernel has no netfilter owner match and no nftables.** Per-user routing works: `ip rule add uidrange 1001-1001 lookup 100` plus `ip route add blackhole 169.254.0.0/16 table 100` blocks metadata for the agent user while the harness (root) keeps it, and GitHub stays reachable. It needs `additionalOsCapabilities: ["ALL"]` for NET_ADMIN.
  5. **Run hook delivery:** the body is an envelope `{ microvmId, runHookPayload: "<string>" }`.
  6. `AWS_REGION` is reserved as an image environment variable.
  7. The orchestrator needs `lambda:PassNetworkConnector` on `aws-network-connector:*` to call `RunMicrovm`.
  8. `SendDurableExecutionCallbackFailure` from the segment role works, so the callback IAM action names are right.
  9. A CloudFormation export cannot change while imported, so the image version is passed through an SSM parameter.

## 0.3 Regions and model (verified with the AWS CLI, account 071128183726, profile AdministratorAccess-071128183726)
- Target regions: us-east-1 and us-west-2.
- Bedrock: `us.anthropic.claude-sonnet-5-5` (US cross-region profile) is ACTIVE in both regions. `global.anthropic.claude-sonnet-5-5` also exists. **BEDROCK_MODEL_ID = `us.anthropic.claude-sonnet-5-5`.**
- Lambda MicroVMs: `list-microvms` and the managed image `al2023-1` respond in both regions.
- Durable functions: documented quotas list both regions, and the CLI has the durable-execution calls.
- GitHub org default: `mbonig`, configurable (`GITHUB_ORG`).

## 0.4
Blocked: needs a real GitHub org to observe `author_association` for private members.
