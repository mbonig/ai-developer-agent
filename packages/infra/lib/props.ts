import type { Construct } from 'constructs';

export interface AppSettings {
  githubOrg: string;
  agentLabel: string;
  githubAppId: string;
  bedrockModelId: string;
  maxTokensPerIssue: string;
  microvmBaseImageVersion: string;
  microvmMemoryMiB: number;
  enableFactory: string;
  alarmEmail?: string;
}

export function settings(scope: Construct): AppSettings {
  const get = (k: string, d?: string) => {
    const v = scope.node.tryGetContext(k) ?? d;
    if (v === undefined) throw new Error(`Missing CDK context ${k}`);
    return String(v);
  };
  return {
    githubOrg: get('githubOrg', 'mbonig'),
    agentLabel: get('agentLabel', 'agent'),
    githubAppId: get('githubAppId', '0'), // set with: -c githubAppId=<id>
    bedrockModelId: get('bedrockModelId', 'us.anthropic.claude-sonnet-5'),
    maxTokensPerIssue: get('maxTokensPerIssue', '12000000'),
    microvmBaseImageVersion: get('microvmBaseImageVersion', '3'), 
    microvmMemoryMiB: Number(get('microvmMemoryMiB', '8192')),
    enableFactory: get('enableFactory', 'true'),
    alarmEmail: scope.node.tryGetContext('alarmEmail'),
  };
}
