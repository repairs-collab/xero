export type MetricName = 'sync_freshness_seconds' | 'queue_age_seconds' | 'pending_approvals' | 'paused_customers' | 'open_tasks' | 'send_outcomes_total' | 'replies_total' | 'opt_outs_total' | 'api_headroom' | 'webhook_failures_total' | 'unknown_send_results_total';
export type MetricLabels = Readonly<Record<string, string>>;
export interface Metrics { increment(name: MetricName, value?: number, labels?: MetricLabels): void; gauge(name: MetricName, value: number, labels?: MetricLabels): void; }

export class InMemoryMetrics implements Metrics {
  readonly values = new Map<string, number>();
  private key(name: MetricName, labels: MetricLabels = {}) { return `${name}:${Object.entries(labels).sort(([left],[right]) => left.localeCompare(right)).map(([key,value]) => `${key}=${value}`).join(',')}`; }
  increment(name: MetricName, value = 1, labels: MetricLabels = {}): void { const key = this.key(name, labels); this.values.set(key, (this.values.get(key) ?? 0) + value); }
  gauge(name: MetricName, value: number, labels: MetricLabels = {}): void { this.values.set(this.key(name, labels), value); }
}
