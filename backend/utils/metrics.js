/**
 * Minimal in-process Prometheus-compatible metrics registry.
 *
 * No external dependencies — the render() output is in Prometheus text
 * exposition format, scrapeable by Prometheus / Grafana Agent / Datadog
 * (via openmetrics receiver) / VictoriaMetrics / etc.
 *
 * Not meant to replace prom-client for heavy workloads. For a trading
 * backend at 1-10k users this is sufficient. If the process restarts,
 * counters reset — that's expected for an in-process registry.
 *
 * Usage:
 *   const m = require('./utils/metrics');
 *   const sigCounter = m.counter('chm_signals_produced_total', 'Signals produced', ['strategy']);
 *   sigCounter.inc({ strategy: 'smc' });
 *   const activeGauge = m.gauge('chm_active_bots', 'Active bots');
 *   activeGauge.set(42);
 *   const latency = m.histogram('chm_http_request_duration_ms', 'HTTP request latency (ms)',
 *     { buckets: [5, 25, 50, 100, 250, 500, 1000, 2500, 5000], labelNames: ['method', 'route'] });
 *   latency.observe({ method: 'GET', route: '/api/bots' }, 42);
 *   res.type('text/plain').send(m.render());
 */

const registry = new Map(); // name → { type, help, labelNames, instance }

function _labelKey(labels, labelNames) {
  if (!labels || !labelNames || !labelNames.length) return '';
  return labelNames.map((n) => `${n}="${String(labels[n] ?? '').replace(/["\\\n]/g, '_')}"`).join(',');
}

function _renderLine(name, labelKey, value) {
  return labelKey ? `${name}{${labelKey}} ${value}` : `${name} ${value}`;
}

function counter(name, help, labelNames = []) {
  if (registry.has(name)) return registry.get(name).instance;
  const values = new Map(); // labelKey → number
  const inst = {
    inc(labels = {}, n = 1) {
      const k = _labelKey(labels, labelNames);
      values.set(k, (values.get(k) || 0) + n);
    },
    get(labels = {}) { return values.get(_labelKey(labels, labelNames)) || 0; },
    reset() { values.clear(); },
    _render() {
      const out = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
      if (!values.size) out.push(_renderLine(name, '', 0));
      for (const [k, v] of values) out.push(_renderLine(name, k, v));
      return out.join('\n');
    },
  };
  registry.set(name, { type: 'counter', help, labelNames, instance: inst });
  return inst;
}

function gauge(name, help, labelNames = []) {
  if (registry.has(name)) return registry.get(name).instance;
  const values = new Map();
  const inst = {
    set(labelsOrVal, maybeVal) {
      const labels = typeof labelsOrVal === 'number' ? {} : labelsOrVal;
      const val = typeof labelsOrVal === 'number' ? labelsOrVal : maybeVal;
      values.set(_labelKey(labels, labelNames), val);
    },
    inc(labels = {}, n = 1) {
      const k = _labelKey(labels, labelNames);
      values.set(k, (values.get(k) || 0) + n);
    },
    dec(labels = {}, n = 1) {
      const k = _labelKey(labels, labelNames);
      values.set(k, (values.get(k) || 0) - n);
    },
    _render() {
      const out = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
      if (!values.size) out.push(_renderLine(name, '', 0));
      for (const [k, v] of values) out.push(_renderLine(name, k, v));
      return out.join('\n');
    },
  };
  registry.set(name, { type: 'gauge', help, labelNames, instance: inst });
  return inst;
}

function histogram(name, help, opts = {}) {
  if (registry.has(name)) return registry.get(name).instance;
  const buckets = (opts.buckets || [5, 25, 50, 100, 250, 500, 1000, 2500, 5000]).slice().sort((a, b) => a - b);
  const labelNames = opts.labelNames || [];
  const series = new Map(); // labelKey → { counts: Array<number>, sum, count }
  const _get = (k) => {
    let s = series.get(k);
    if (!s) { s = { counts: new Array(buckets.length).fill(0), sum: 0, count: 0 }; series.set(k, s); }
    return s;
  };
  const inst = {
    observe(labelsOrVal, maybeVal) {
      const labels = typeof labelsOrVal === 'number' ? {} : labelsOrVal;
      const val = typeof labelsOrVal === 'number' ? labelsOrVal : maybeVal;
      const s = _get(_labelKey(labels, labelNames));
      for (let i = 0; i < buckets.length; i++) if (val <= buckets[i]) s.counts[i]++;
      s.sum += val; s.count++;
    },
    _render() {
      const out = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
      for (const [k, s] of series) {
        const prefix = k ? k + ',' : '';
        for (let i = 0; i < buckets.length; i++) {
          out.push(_renderLine(name + '_bucket', prefix + `le="${buckets[i]}"`, s.counts[i]));
        }
        out.push(_renderLine(name + '_bucket', prefix + 'le="+Inf"', s.count));
        out.push(_renderLine(name + '_sum', k, s.sum));
        out.push(_renderLine(name + '_count', k, s.count));
      }
      return out.join('\n');
    },
  };
  registry.set(name, { type: 'histogram', help, labelNames, instance: inst });
  return inst;
}

function render() {
  const parts = [];
  for (const entry of registry.values()) parts.push(entry.instance._render());
  // Built-in process metrics
  const mem = process.memoryUsage();
  parts.push(`# TYPE chm_process_rss_bytes gauge\nchm_process_rss_bytes ${mem.rss}`);
  parts.push(`# TYPE chm_process_heap_used_bytes gauge\nchm_process_heap_used_bytes ${mem.heapUsed}`);
  parts.push(`# TYPE chm_process_uptime_seconds counter\nchm_process_uptime_seconds ${process.uptime()}`);
  return parts.join('\n') + '\n';
}

module.exports = { counter, gauge, histogram, render, _registry: registry };
