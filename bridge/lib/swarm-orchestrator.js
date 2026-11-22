/**
 * Cooperative Multi-Agent DAG Mission Planner, Role Engine & Shared Blackboard (v2.2.0).
 *
 * State-of-the-art multi-agent browser orchestration (zero external dependencies):
 *   1. Specialist Role Profiles (`planner`, `researcher`, `operator`, `downloader`, `auditor`, `custom`)
 *      with explicit responsibilities, capability boundaries, and color-coded Chrome Tab Groups.
 *   2. 3-Color DFS Cycle Detection (O(V + E)) ensuring every mission plan is a valid DAG.
 *   3. Critical-Path Method (CPM) Longest-Path Priority Ranking so bottleneck chains execute first.
 *   4. Event-Driven Dynamic Ready-Queue Scheduler (no idle barrier waves — dependent tasks dispatch
 *      the millisecond their upstream dependencies settle) with bounded concurrency (1..12).
 *   5. Declarative Data-Flow Templating (`{{tasks.<id>.result.<path>}}`, `{{blackboard.<key>}}`)
 *      so agents pass extracted URLs, refs, JSON rows, and downloaded file paths with 0 LLM hops.
 *   6. Durable Shared Blackboard & Agent Handoff Message Bus persisted per mission + project folder.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROLE_PROFILES = {
  planner: {
    role: 'planner',
    defaultColor: 'purple',
    responsibilities: [
      'Decompose goals into a dependency DAG with clear role assignments',
      'Coordinate shared Blackboard state and verify mission completion criteria',
      'Synthesize final reports and deliverables from specialist outputs'
    ],
    recommendedTools: ['chrome_swarm_plan', 'chrome_swarm_blackboard', 'chrome_list_tabs', 'chrome_deep_read', 'chrome_read_multiple_tabs']
  },
  researcher: {
    role: 'researcher',
    defaultColor: 'blue',
    responsibilities: [
      'Read multiple pages concurrently in background tabs without stealing focus',
      'Extract structured tables, lists, metadata, JSON-LD, and downloadable asset links',
      'Publish verified findings and discovered URLs to the shared Blackboard'
    ],
    recommendedTools: ['chrome_deep_read', 'chrome_read_page', 'chrome_get_page_text', 'chrome_extract_data', 'chrome_read_multiple_tabs', 'chrome_find_elements']
  },
  operator: {
    role: 'operator',
    defaultColor: 'orange',
    responsibilities: [
      'Execute multi-step UI workflows atomically via pipelined batch actions',
      'Own exclusive tab writes protected by Per-Tab Fair RWLocks',
      'Respect human-in-the-loop safety gates (passwords, 2FA, CAPTCHA, payments)'
    ],
    recommendedTools: ['chrome_batch_actions', 'chrome_click', 'chrome_type', 'chrome_select_option', 'chrome_fill_form', 'chrome_press_key', 'chrome_upload_file', 'chrome_wait_for']
  },
  downloader: {
    role: 'downloader',
    defaultColor: 'green',
    responsibilities: [
      'Download files via 4-tier auto strategy into the target project folder',
      'Verify SHA-256 integrity, update .chrome-downloads.json manifest, and parse contents',
      'Publish saved local project paths and parsed summaries to the Blackboard'
    ],
    recommendedTools: ['chrome_download_file', 'chrome_track_downloads', 'chrome_save_pdf', 'chrome_screenshot']
  },
  auditor: {
    role: 'auditor',
    defaultColor: 'cyan',
    responsibilities: [
      'Audit Core Web Vitals (TTFB, FCP, LCP, CLS), WCAG 2.2 AA accessibility, and SEO',
      'Inspect console errors, network failures, cookies/storage, and visual regressions',
      'Record pass/fail quality gates and verification evidence on the Blackboard'
    ],
    recommendedTools: ['chrome_audit_page', 'chrome_get_console_logs', 'chrome_get_network_logs', 'chrome_storage', 'chrome_watch_page', 'chrome_inspect_element', 'chrome_screenshot']
  },
  custom: {
    role: 'custom',
    defaultColor: 'pink',
    responsibilities: ['Execute custom assigned browser tasks within isolated agent session'],
    recommendedTools: []
  }
};

const COLOR_POOL = ['blue', 'green', 'orange', 'purple', 'cyan', 'pink', 'yellow', 'red'];

function getByPath(obj, dotPath) {
  const parts = String(dotPath || '')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
    else cur = cur[p];
  }
  return cur;
}

/**
 * Resolves `{{tasks.t1.result.projectPath}}` or `{{blackboard.reportUrl}}` templates
 * inside task params or URLs so downstream agents consume upstream outputs seamlessly.
 */
function resolveTemplates(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (exact) {
      const resolved = getByPath(context, exact[1]);
      return resolved !== undefined ? resolved : value;
    }
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, expr) => {
      const resolved = getByPath(context, expr);
      if (resolved === undefined) return match;
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTemplates(v, context);
    }
    return out;
  }
  return value;
}

/**
 * Validates DAG acyclicity via 3-color DFS (O(V + E)) and computes Critical-Path Method (CPM)
 * downstream depth & topological wave levels for priority scheduling.
 */
function analyzeTaskDag(tasks) {
  const taskMap = new Map();
  for (const t of tasks) {
    if (!t || !t.id) throw new Error('Every mission task must have a unique string "id".');
    if (taskMap.has(t.id)) throw new Error(`Duplicate mission task id: "${t.id}".`);
    taskMap.set(t.id, t);
  }

  const dependents = new Map(); // id -> string[]
  for (const t of tasks) {
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    for (const dep of deps) {
      if (!taskMap.has(dep)) {
        throw new Error(`Task "${t.id}" depends on unknown task "${dep}".`);
      }
      dependents.get(dep).push(t.id);
    }
  }

  // 3-color DFS cycle detection: 0 = unvisited, 1 = visiting, 2 = visited
  const color = new Map();
  const stack = [];
  function dfsCycle(id) {
    color.set(id, 1);
    stack.push(id);
    for (const next of dependents.get(id) || []) {
      const c = color.get(next) || 0;
      if (c === 1) {
        const idx = stack.indexOf(next);
        const cycle = [...stack.slice(idx), next].join(' -> ');
        throw new Error(`Circular dependency detected in mission DAG: ${cycle}`);
      }
      if (c === 0) dfsCycle(next);
    }
    stack.pop();
    color.set(id, 2);
  }
  for (const t of tasks) {
    if ((color.get(t.id) || 0) === 0) dfsCycle(t.id);
  }

  // Compute Critical-Path downstream depth (higher = more downstream work blocked by this task)
  const criticalDepth = new Map();
  function computeDepth(id) {
    if (criticalDepth.has(id)) return criticalDepth.get(id);
    const children = dependents.get(id) || [];
    let maxChild = 0;
    for (const ch of children) {
      maxChild = Math.max(maxChild, 1 + computeDepth(ch));
    }
    criticalDepth.set(id, maxChild);
    return maxChild;
  }
  for (const t of tasks) computeDepth(t.id);

  // Compute topological wave level (for UI / status reporting)
  const level = new Map();
  function computeLevel(id) {
    if (level.has(id)) return level.get(id);
    const deps = Array.isArray(taskMap.get(id)?.dependsOn) ? taskMap.get(id).dependsOn : [];
    let maxDep = -1;
    for (const d of deps) {
      maxDep = Math.max(maxDep, computeLevel(d));
    }
    const lvl = maxDep + 1;
    level.set(id, lvl);
    return lvl;
  }
  for (const t of tasks) computeLevel(t.id);

  const stages = [];
  for (const t of tasks) {
    const lvl = level.get(t.id);
    if (!stages[lvl]) stages[lvl] = [];
    stages[lvl].push(t.id);
  }

  return {
    taskMap,
    dependents,
    criticalDepth,
    level,
    stages,
    criticalPathLength: stages.length
  };
}

class SwarmOrchestrator {
  constructor({ stateDir }) {
    this.missionsDir = path.join(stateDir, 'missions');
    this.missions = new Map(); // missionId -> missionState
    this._loadRecentMissions();
  }

  _loadRecentMissions() {
    try {
      if (!fs.existsSync(this.missionsDir)) return;
      const files = fs
        .readdirSync(this.missionsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .slice(-20);
      for (const f of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(this.missionsDir, f), 'utf8'));
          if (parsed?.missionId) {
            this.missions.set(parsed.missionId, parsed);
          }
        } catch (_e) {}
      }
    } catch (_e) {}
  }

  _persistMission(mission) {
    try {
      fs.mkdirSync(this.missionsDir, { recursive: true });
      const filePath = path.join(this.missionsDir, `${mission.missionId}.json`);
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(mission, null, 2));
      fs.renameSync(tmp, filePath);

      if (mission.projectDir && fs.existsSync(mission.projectDir)) {
        const projPath = path.join(mission.projectDir, '.chrome-mission.json');
        const pTmp = `${projPath}.tmp-${process.pid}`;
        fs.writeFileSync(pTmp, JSON.stringify(this._summarizeMission(mission, true), null, 2));
        fs.renameSync(pTmp, projPath);
      }
    } catch (_e) {}
  }

  getRoleProfiles() {
    return ROLE_PROFILES;
  }

  createPlan(params = {}) {
    const missionId = params.missionId
      ? String(params.missionId).replace(/[^a-zA-Z0-9_-]/g, '-')
      : `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const goal = String(params.goal || 'Multi-agent browser mission').trim();
    const projectDir = params.projectDir ? path.resolve(String(params.projectDir)) : null;
    if (projectDir) fs.mkdirSync(projectDir, { recursive: true });

    const rawAgents = Array.isArray(params.agents) ? params.agents : [];
    const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];

    // Auto-provision role roster if caller supplied tasks with assignedTo/role without explicit agents[]
    const agentMap = new Map();
    let colorIdx = 0;
    for (const a of rawAgents) {
      if (!a?.agentId) continue;
      const roleKey = ROLE_PROFILES[a.role] ? a.role : 'custom';
      const profile = ROLE_PROFILES[roleKey];
      agentMap.set(a.agentId, {
        agentId: String(a.agentId),
        role: a.role || roleKey,
        responsibilities: Array.isArray(a.responsibilities) && a.responsibilities.length > 0
          ? a.responsibilities
          : profile.responsibilities,
        color: a.color || profile.defaultColor || COLOR_POOL[colorIdx++ % COLOR_POOL.length],
        projectDir: a.projectDir ? path.resolve(String(a.projectDir)) : projectDir,
        exclusive: Boolean(a.exclusive ?? (roleKey === 'operator')),
        status: 'ready',
        assignedTasks: 0,
        completedTasks: 0,
        failedTasks: 0
      });
    }

    for (const t of rawTasks) {
      const assigned = t.assignedTo || t.agentId || (t.role ? `${t.role}-1` : 'researcher-1');
      if (!agentMap.has(assigned)) {
        const roleKey = ROLE_PROFILES[t.role] ? t.role : assigned.split('-')[0];
        const profile = ROLE_PROFILES[roleKey] || ROLE_PROFILES.custom;
        agentMap.set(assigned, {
          agentId: assigned,
          role: t.role || profile.role,
          responsibilities: profile.responsibilities,
          color: profile.defaultColor || COLOR_POOL[colorIdx++ % COLOR_POOL.length],
          projectDir,
          exclusive: profile.role === 'operator',
          status: 'ready',
          assignedTasks: 0,
          completedTasks: 0,
          failedTasks: 0
        });
      }
      agentMap.get(assigned).assignedTasks++;
    }

    const normalizedTasks = rawTasks.map((t, idx) => ({
      id: String(t.id || `task-${idx + 1}`),
      title: String(t.title || `${t.method || 'task'} #${idx + 1}`),
      assignedTo: String(t.assignedTo || t.agentId || (t.role ? `${t.role}-1` : 'researcher-1')),
      role: t.role || agentMap.get(String(t.assignedTo || t.agentId || (t.role ? `${t.role}-1` : 'researcher-1')))?.role || 'custom',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      url: t.url || null,
      tabId: t.tabId ? Number(t.tabId) : null,
      method: t.method || null,
      params: t.params && typeof t.params === 'object' ? t.params : {},
      retries: Math.max(0, Math.min(3, Number(t.retries) || 0)),
      retryDelayMs: Math.max(100, Math.min(10000, Number(t.retryDelayMs) || 350)),
      timeoutMs: Math.min(180000, Number(t.timeoutMs) || 60000),
      saveArtifactKey: t.saveArtifactKey || null,
      onFailure: t.onFailure || 'skip_dependents', // 'skip_dependents' | 'continue' | 'fail_mission'
      status: 'pending',
      attempts: 0,
      durationMs: null,
      result: null,
      error: null
    }));

    const dag = normalizedTasks.length > 0 ? analyzeTaskDag(normalizedTasks) : { stages: [], criticalPathLength: 0, criticalDepth: new Map(), level: new Map() };
    for (const t of normalizedTasks) {
      t.stage = dag.level.get(t.id) ?? 0;
      t.criticalDepth = dag.criticalDepth.get(t.id) ?? 0;
    }

    const mission = {
      missionId,
      goal,
      projectDir,
      status: 'planned',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      concurrency: Math.max(1, Math.min(12, Number(params.concurrency) || 6)),
      agents: Array.from(agentMap.values()),
      tasks: normalizedTasks,
      stages: dag.stages,
      criticalPathLength: dag.criticalPathLength,
      blackboard: params.initialBlackboard && typeof params.initialBlackboard === 'object' ? { ...params.initialBlackboard } : {},
      messages: [],
      metrics: {
        totalDurationMs: null,
        cumulativeTaskMs: 0,
        parallelSpeedup: 1
      }
    };

    this.missions.set(missionId, mission);
    this._persistMission(mission);
    return this._summarizeMission(mission, true);
  }

  /**
   * Executes a planned (or inline) mission DAG using our Critical-Path Dynamic Ready-Queue Scheduler.
   * `executor` is an async callback `(agent, task, resolvedParams, resolvedUrl) => Promise<result>`
   * supplied by BridgeHub so every task runs through isolated agent sessions, Per-Tab RWLocks, and DownloadManager.
   */
  async executeMission(missionId, { concurrency, closeSpawnedTabs = false, executor, provisionAgents, releaseAgents } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Mission not found: "${missionId}".`);
    if (mission.tasks.length === 0) {
      mission.status = 'completed';
      mission.completedAt = new Date().toISOString();
      this._persistMission(mission);
      return this._summarizeMission(mission, true);
    }

    const dag = analyzeTaskDag(mission.tasks);
    const maxWorkers = Math.max(1, Math.min(12, Number(concurrency) || mission.concurrency || 6));
    const agentById = new Map(mission.agents.map((a) => [a.agentId, a]));

    mission.status = 'running';
    mission.startedAt = new Date().toISOString();
    const wallStart = Date.now();
    this._persistMission(mission);

    // 1. Provision isolated agent sessions & color-coded tab groups upfront in parallel
    if (typeof provisionAgents === 'function') {
      await provisionAgents(mission.agents, mission);
    }

    const remainingDeps = new Map();
    for (const t of mission.tasks) {
      t.status = 'pending';
      t.attempts = 0;
      t.result = null;
      t.error = null;
      t.durationMs = null;
      remainingDeps.set(t.id, new Set(t.dependsOn));
    }

    const readyQueue = [];
    for (const t of mission.tasks) {
      if (remainingDeps.get(t.id).size === 0) {
        readyQueue.push(t);
      }
    }
    // Sort ready queue by Critical-Path depth descending (longest downstream chain runs first!)
    const sortReady = () => readyQueue.sort((a, b) => (b.criticalDepth || 0) - (a.criticalDepth || 0));
    sortReady();

    let inFlight = 0;
    let aborted = false;
    let totalTaskMs = 0;

    const markSkippedCascade = (failedTaskId, reason) => {
      const queue = [...(dag.dependents.get(failedTaskId) || [])];
      while (queue.length > 0) {
        const depId = queue.shift();
        const depTask = dag.taskMap.get(depId);
        if (!depTask || depTask.status !== 'pending') continue;
        depTask.status = 'skipped';
        depTask.error = `Skipped because upstream dependency "${failedTaskId}" failed: ${reason}`;
        for (const child of dag.dependents.get(depId) || []) {
          queue.push(child);
        }
      }
    };

    const buildTemplateContext = () => {
      const taskCtx = {};
      for (const t of mission.tasks) {
        taskCtx[t.id] = { status: t.status, result: t.result, error: t.error };
      }
      return {
        goal: mission.goal,
        missionId: mission.missionId,
        projectDir: mission.projectDir,
        blackboard: mission.blackboard,
        tasks: taskCtx
      };
    };

    await new Promise((resolveAll) => {
      const pump = () => {
        if (aborted && inFlight === 0) {
          resolveAll();
          return;
        }

        while (!aborted && inFlight < maxWorkers && readyQueue.length > 0) {
          sortReady();
          const task = readyQueue.shift();
          if (task.status !== 'pending') continue;

          inFlight++;
          task.status = 'running';
          const agent = agentById.get(task.assignedTo) || {
            agentId: task.assignedTo,
            role: task.role,
            projectDir: mission.projectDir
          };
          agent.status = 'working';

          const runTask = async () => {
            const started = Date.now();
            let lastErr = null;
            const maxAttempts = 1 + (task.retries || 0);

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              task.attempts = attempt;
              try {
                const ctx = buildTemplateContext();
                const resolvedParams = resolveTemplates(task.params || {}, ctx);
                const resolvedUrl = task.url ? resolveTemplates(task.url, ctx) : null;
                if (agent.projectDir && !resolvedParams.projectDir && (task.method === 'chrome_download_file' || task.method === 'chrome_save_pdf' || task.method === 'chrome_screenshot')) {
                  resolvedParams.projectDir = agent.projectDir;
                }
                const res = await executor(agent, task, resolvedParams, resolvedUrl, mission);
                task.result = res;
                task.status = 'completed';
                task.error = null;
                task.durationMs = Date.now() - started;
                totalTaskMs += task.durationMs;
                agent.completedTasks = (agent.completedTasks || 0) + 1;

                if (task.saveArtifactKey) {
                  mission.blackboard[task.saveArtifactKey] = {
                    value: res,
                    byAgent: agent.agentId,
                    role: agent.role,
                    taskId: task.id,
                    updatedAt: new Date().toISOString()
                  };
                }
                lastErr = null;
                break;
              } catch (err) {
                lastErr = err;
                if (attempt < maxAttempts) {
                  const backoff = (task.retryDelayMs || 350) * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 120);
                  await new Promise((r) => setTimeout(r, backoff));
                }
              }
            }

            if (lastErr) {
              task.status = 'failed';
              task.error = lastErr?.message || String(lastErr);
              task.durationMs = Date.now() - started;
              totalTaskMs += task.durationMs;
              agent.failedTasks = (agent.failedTasks || 0) + 1;

              if (task.onFailure === 'fail_mission') {
                aborted = true;
                markSkippedCascade(task.id, task.error);
              } else if (task.onFailure === 'skip_dependents') {
                markSkippedCascade(task.id, task.error);
              } else {
                // 'continue': still unblock downstream tasks so they can inspect {{tasks.id.error}}
                for (const childId of dag.dependents.get(task.id) || []) {
                  const set = remainingDeps.get(childId);
                  set?.delete(task.id);
                  const childTask = dag.taskMap.get(childId);
                  if (set && set.size === 0 && childTask?.status === 'pending') {
                    readyQueue.push(childTask);
                  }
                }
              }
            } else {
              // Unblock downstream dependents IMMEDIATELY (event-driven — zero barrier wait!)
              for (const childId of dag.dependents.get(task.id) || []) {
                const set = remainingDeps.get(childId);
                set?.delete(task.id);
                const childTask = dag.taskMap.get(childId);
                if (set && set.size === 0 && childTask?.status === 'pending') {
                  readyQueue.push(childTask);
                }
              }
            }

            agent.status = 'idle';
            inFlight--;
            this._persistMission(mission);
            pump();
          };

          runTask();
        }

        if (inFlight === 0 && (readyQueue.length === 0 || aborted)) {
          resolveAll();
        }
      };

      pump();
    });

    const totalDurationMs = Date.now() - wallStart;
    const failedCount = mission.tasks.filter((t) => t.status === 'failed').length;
    const completedCount = mission.tasks.filter((t) => t.status === 'completed').length;
    mission.status = failedCount === 0 ? 'completed' : completedCount > 0 ? 'completed_with_errors' : 'failed';
    mission.completedAt = new Date().toISOString();
    mission.metrics = {
      totalDurationMs,
      cumulativeTaskMs: totalTaskMs,
      parallelSpeedup: totalDurationMs > 0 ? Math.round((totalTaskMs / totalDurationMs) * 100) / 100 : 1
    };

    if (closeSpawnedTabs && typeof releaseAgents === 'function') {
      await releaseAgents(mission.agents, mission, true);
    }

    this._persistMission(mission);
    return this._summarizeMission(mission, true);
  }

  // --- Blackboard & Dynamic Multi-Agent Coordination ---
  blackboardOp(params = {}) {
    const action = params.action || 'list';
    let missionId = params.missionId || 'default-workspace';
    let mission = this.missions.get(missionId);
    if (!mission) {
      this.createPlan({ missionId, goal: 'Ad-hoc collaborative multi-agent session', projectDir: params.projectDir });
      mission = this.missions.get(missionId);
    }

    if (action === 'put') {
      if (!params.key) throw new Error('Parameter "key" is required for blackboard put.');
      mission.blackboard[String(params.key)] = {
        value: params.value,
        byAgent: params.agentId || 'anonymous',
        role: params.role || null,
        tags: Array.isArray(params.tags) ? params.tags : [],
        updatedAt: new Date().toISOString()
      };
      this._persistMission(mission);
      return { ok: true, missionId, key: params.key, entry: mission.blackboard[String(params.key)] };
    }

    if (action === 'get') {
      if (!params.key) throw new Error('Parameter "key" is required for blackboard get.');
      const entry = mission.blackboard[String(params.key)] || null;
      return { missionId, key: params.key, found: Boolean(entry), entry };
    }

    if (action === 'post_message') {
      const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fromAgent: params.agentId || params.fromAgent || 'anonymous',
        toAgent: params.toAgent || 'all',
        topic: params.topic || 'handoff',
        message: params.message || '',
        payload: params.payload ?? null,
        timestamp: new Date().toISOString()
      };
      mission.messages.push(msg);
      if (mission.messages.length > 300) mission.messages.shift();
      this._persistMission(mission);
      return { posted: true, missionId, message: msg };
    }

    if (action === 'read_messages') {
      const forAgent = params.agentId || params.toAgent || null;
      const filtered = mission.messages.filter((m) => {
        if (forAgent && m.toAgent !== 'all' && m.toAgent !== forAgent && m.fromAgent !== forAgent) return false;
        if (params.topic && m.topic !== params.topic) return false;
        return true;
      });
      return { missionId, count: filtered.length, messages: filtered.slice(-(Number(params.limit) || 50)) };
    }

    if (action === 'claim_task') {
      const task = mission.tasks.find((t) =>
        params.taskId ? t.id === params.taskId : t.status === 'pending' && (!params.role || t.role === params.role)
      );
      if (!task) return { missionId, claimed: false, task: null };
      task.status = 'running';
      if (params.agentId) task.assignedTo = params.agentId;
      this._persistMission(mission);
      return { missionId, claimed: true, task };
    }

    if (action === 'complete_task') {
      if (!params.taskId) throw new Error('Parameter "taskId" is required for complete_task.');
      const task = mission.tasks.find((t) => t.id === params.taskId);
      if (!task) throw new Error(`Task "${params.taskId}" not found in mission "${missionId}".`);
      task.status = params.failed ? 'failed' : 'completed';
      task.result = params.result ?? null;
      task.error = params.error || null;
      if (task.saveArtifactKey && !params.failed) {
        mission.blackboard[task.saveArtifactKey] = {
          value: task.result,
          byAgent: params.agentId || task.assignedTo,
          taskId: task.id,
          updatedAt: new Date().toISOString()
        };
      }
      this._persistMission(mission);
      return { missionId, updated: true, task };
    }

    // Default: list
    return {
      missionId,
      goal: mission.goal,
      status: mission.status,
      keys: Object.keys(mission.blackboard),
      blackboard: mission.blackboard,
      messageCount: mission.messages.length,
      recentMessages: mission.messages.slice(-15)
    };
  }

  getMission(missionId, includeResults = true) {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Mission not found: "${missionId}".`);
    return this._summarizeMission(mission, includeResults);
  }

  listMissions() {
    return Array.from(this.missions.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 20)
      .map((m) => this._summarizeMission(m, false));
  }

  _summarizeMission(m, includeDetails = false) {
    const counts = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
    for (const t of m.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const summary = {
      missionId: m.missionId,
      goal: m.goal,
      status: m.status,
      projectDir: m.projectDir,
      createdAt: m.createdAt,
      startedAt: m.startedAt,
      completedAt: m.completedAt,
      agentCount: m.agents.length,
      taskCount: m.tasks.length,
      taskCounts: counts,
      criticalPathLength: m.criticalPathLength,
      stages: m.stages,
      metrics: m.metrics,
      blackboardKeys: Object.keys(m.blackboard || {}),
      messageCount: (m.messages || []).length
    };
    if (includeDetails) {
      summary.agents = m.agents;
      summary.tasks = m.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        assignedTo: t.assignedTo,
        role: t.role,
        dependsOn: t.dependsOn,
        stage: t.stage,
        criticalDepth: t.criticalDepth,
        method: t.method,
        status: t.status,
        attempts: t.attempts,
        durationMs: t.durationMs,
        saveArtifactKey: t.saveArtifactKey,
        result: t.result,
        error: t.error
      }));
      summary.blackboard = m.blackboard;
      summary.recentMessages = (m.messages || []).slice(-20);
    }
    return summary;
  }
}

module.exports = { SwarmOrchestrator, ROLE_PROFILES, analyzeTaskDag, resolveTemplates };
