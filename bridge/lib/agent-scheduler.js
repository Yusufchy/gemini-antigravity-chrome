/**
 * Multi-Agent Concurrency Scheduler & Bounded Parallel Worker Pool (v2.2.0).
 *
 * Coordinates multiple autonomous AI agents / swarms sharing a single Chrome browser:
 *   - Tracks client -> agentId ownership for automatic cleanup on disconnect.
 *   - Runs bounded parallel fan-outs (`runBoundedPool`) with per-task latency telemetry.
 *   - Prevents unbounded tab storms via configurable concurrency caps (1..12).
 */

'use strict';

async function runBoundedPool(items, concurrency, workerFn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.min(12, Number(concurrency) || 6, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= list.length) return;
      const started = Date.now();
      try {
        const value = await workerFn(list[idx], idx);
        results[idx] = {
          index: idx,
          ok: true,
          durationMs: Date.now() - started,
          value
        };
      } catch (err) {
        results[idx] = {
          index: idx,
          ok: false,
          durationMs: Date.now() - started,
          error: err?.message || String(err)
        };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

class AgentScheduler {
  constructor() {
    this.clientAgents = new Map(); // clientId -> Set<agentId>
    this.metrics = {
      totalDispatched: 0,
      activeInFlight: 0,
      peakConcurrency: 0,
      parallelBatchesRun: 0
    };
  }

  registerAgentClient(clientId, agentId) {
    if (!clientId || !agentId) return;
    let set = this.clientAgents.get(clientId);
    if (!set) {
      set = new Set();
      this.clientAgents.set(clientId, set);
    }
    set.add(String(agentId));
  }

  unregisterAgent(agentId) {
    if (!agentId) return;
    for (const set of this.clientAgents.values()) {
      set.delete(String(agentId));
    }
  }

  getAgentsForClient(clientId) {
    const set = this.clientAgents.get(clientId);
    return set ? Array.from(set) : [];
  }

  removeClient(clientId) {
    const agents = this.getAgentsForClient(clientId);
    this.clientAgents.delete(clientId);
    return agents;
  }

  async trackDispatch(fn) {
    this.metrics.totalDispatched++;
    this.metrics.activeInFlight++;
    if (this.metrics.activeInFlight > this.metrics.peakConcurrency) {
      this.metrics.peakConcurrency = this.metrics.activeInFlight;
    }
    try {
      return await fn();
    } finally {
      this.metrics.activeInFlight = Math.max(0, this.metrics.activeInFlight - 1);
    }
  }

  getMetrics() {
    return { ...this.metrics, activeClients: this.clientAgents.size };
  }
}

module.exports = { AgentScheduler, runBoundedPool };
