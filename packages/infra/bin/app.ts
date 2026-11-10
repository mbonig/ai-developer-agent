import { App } from 'aws-cdk-lib';
import { StateStack } from '../lib/state-stack.ts';
import { SandboxStack } from '../lib/sandbox-stack.ts';
import { OrchestratorStack } from '../lib/orchestrator-stack.ts';
import { IngressStack } from '../lib/ingress-stack.ts';
import { DeployRoleStack } from '../lib/deploy-role-stack.ts';

const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '071128183726',
  region: app.node.tryGetContext('region') ?? 'us-west-2',
};

const state = new StateStack(app, 'AgentState', { env });
const sandbox = new SandboxStack(app, 'AgentSandbox', { env, state });
const orchestrator = new OrchestratorStack(app, 'AgentOrchestrator', { env, state, sandbox });
new IngressStack(app, 'AgentIngress', { env, state, orchestrator });

// Deployed by hand once; the deploy workflow lists the four stacks above explicitly and skips this one.
new DeployRoleStack(app, 'AgentDeployRole', {
  env,
  repo: `${app.node.tryGetContext('githubOrg') ?? 'mbonig'}/${app.node.tryGetContext('githubRepo') ?? 'ai-developer-agent'}`,
  environment: 'production',
});
