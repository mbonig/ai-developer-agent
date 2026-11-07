import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { OpenIdConnectProvider, Role, WebIdentityPrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';

export interface DeployRoleStackProps extends StackProps {
  /** GitHub "owner/repo" allowed to assume the role. */
  repo: string;
  /** GitHub environment the deploy job runs in. */
  environment: string;
  /** Reuse an existing GitHub OIDC provider (an account can only have one per URL). */
  existingProviderArn?: string;
}

/**
 * Role that GitHub Actions assumes via OIDC to run `cdk deploy`. It can only assume the CDK
 * bootstrap roles, which hold the real deployment permissions. Deploy this stack by hand
 * (`cdk deploy AgentDeployRole`); the workflow does not deploy it, so it can't edit its own role.
 */
export class DeployRoleStack extends Stack {
  constructor(scope: Construct, id: string, props: DeployRoleStackProps) {
    super(scope, id, props);
    const providerArn = props.existingProviderArn ?? new OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    }).openIdConnectProviderArn;

    const role = new Role(this, 'DeployRole', {
      roleName: 'agent-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(providerArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:environment:${props.environment}`,
        },
      }),
    });
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*-${this.account}-${this.region}`],
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*/version`],
    }));

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn, description: 'Save as the AWS_DEPLOY_ROLE_ARN secret' });
  }
}
