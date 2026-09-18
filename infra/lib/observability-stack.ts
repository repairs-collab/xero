import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

import type { DataStack } from './data-stack.js';
import type { DeploymentStage } from './network-stack.js';
import type { ServiceStack } from './service-stack.js';

export interface ObservabilityStackProps extends StackProps {
  stage: DeploymentStage;
  data: DataStack;
  services: ServiceStack;
}

export class ObservabilityStack extends Stack {
  readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    this.alarmTopic = new Topic(this, 'AlarmTopic', {
      topicName: `${props.stage}-bill-chaser-alarms`,
      enforceSSL: true
    });

    const alarms: Alarm[] = [];
    const runningTasks = (name: string, serviceName: string) =>
      new Alarm(this, name, {
        alarmName: `${props.stage}-bill-chaser-${name}`,
        metric: new Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensionsMap: {
            ClusterName: props.services.cluster.clusterName,
            ServiceName: serviceName
          },
          period: Duration.minutes(1),
          statistic: 'Minimum'
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.BREACHING
      });
    alarms.push(
      runningTasks('web-unhealthy', props.services.webService.serviceName),
      runningTasks('worker-unhealthy', props.services.workerService.serviceName),
      new Alarm(this, 'RdsStorage', {
        alarmName: `${props.stage}-bill-chaser-rds-storage`,
        metric: props.data.database.metricFreeStorageSpace({
          period: Duration.minutes(5),
          statistic: 'Minimum'
        }),
        threshold: 10 * 1024 * 1024 * 1024,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.BREACHING
      }),
      new Alarm(this, 'RdsConnections', {
        alarmName: `${props.stage}-bill-chaser-rds-connections`,
        metric: props.data.database.metricDatabaseConnections({
          period: Duration.minutes(5),
          statistic: 'Maximum'
        }),
        threshold: 150,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING
      })
    );

    const operationalAlarm = (
      id: string,
      metricName: string,
      threshold: number,
      comparisonOperator = ComparisonOperator.GREATER_THAN_THRESHOLD
    ) =>
      new Alarm(this, id, {
        alarmName: `${props.stage}-bill-chaser-${metricName}`,
        metric: new Metric({
          namespace: 'BillChaser5000',
          metricName,
          dimensionsMap: { Environment: props.stage },
          period: Duration.minutes(5),
          statistic: 'Maximum'
        }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator,
        treatMissingData: TreatMissingData.NOT_BREACHING
      });
    alarms.push(
      operationalAlarm('QueueAge', 'queue_age_seconds', 300),
      operationalAlarm('StaleSync', 'sync_freshness_seconds', 900),
      operationalAlarm('ProviderAuth', 'provider_authentication_failures_total', 0),
      operationalAlarm('WebhookSignature', 'webhook_signature_failures_total', 0),
      operationalAlarm('UnknownSend', 'unknown_send_results_total', 0)
    );
    for (const alarm of alarms) alarm.addAlarmAction(new SnsAction(this.alarmTopic));
  }
}
