#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';

import { DataStack } from '../lib/data-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import {
  type DeploymentStage,
  NetworkStack
} from '../lib/network-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';
import { ServiceStack } from '../lib/service-stack.js';

const app = new App();
const stageValue = String(app.node.tryGetContext('stage') ?? 'development');
if (!['development', 'staging', 'production'].includes(stageValue)) {
  throw new Error('stage must be development, staging, or production');
}
const stage = stageValue as DeploymentStage;
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-southeast-2'
};
const prefix = `${stage}-bill-chaser`;
const hostname = String(
  app.node.tryGetContext('hostname') ?? `${stage}.billchaser.example.com`
);
const network = new NetworkStack(app, `${prefix}-network`, { env, stage });
const data = new DataStack(app, `${prefix}-data`, { env, stage, network });
const identity = new IdentityStack(app, `${prefix}-identity`, {
  env,
  stage,
  hostname
});
const services = new ServiceStack(app, `${prefix}-services`, {
  env,
  stage,
  network,
  data,
  identity,
  certificateArn: String(
    app.node.tryGetContext('certificateArn') ??
      'arn:aws:acm:ap-southeast-2:000000000000:certificate/configure-before-deploy'
  ),
  hostname,
  imageTag: String(app.node.tryGetContext('imageTag') ?? 'development')
});
new ObservabilityStack(app, `${prefix}-observability`, {
  env,
  stage,
  data,
  services
});

for (const stack of app.node.children) {
  Tags.of(stack).add('Application', 'BillChaser5000');
  Tags.of(stack).add('Environment', stage);
  Tags.of(stack).add('DataResidency', 'Australia');
}
