/**
 * MCP tool definitions exposed to Antigravity (v2.2.0 — 42 Autonomous Browser, File-Sync & Multi-Agent Swarm Tools).
 *
 * v2.2.0 Breakthrough Capabilities:
 *   - Project-Scoped Download Engine & Local File Intelligence (`chrome_download_file`, `chrome_track_downloads`)
 *   - Hyper-Speed Single-Pass Full Reader with FNV-1a Delta Diffing (`chrome_deep_read`)
 *   - Atomic Pipelined Multi-Step Batch Executor (`chrome_batch_actions`)
 *   - Isolated Multi-Agent Sessions with Per-Tab Fair RWLocks & Color Tab Groups (`chrome_agent_session`)
 *   - Bounded Multi-Tab / Multi-Agent Parallel Fan-Out Engine (`chrome_parallel_run`)
 *   - Cooperative Multi-Agent DAG Mission Planner & Shared Blackboard (`chrome_swarm_plan`, `chrome_swarm_blackboard`)
 */

'use strict';

const tabId = {
  type: 'number',
  description: 'Target tab id (from chrome_list_tabs). Defaults to this agentId\'s leased tab, else the controlled/active tab.'
};

const agentId = {
  type: 'string',
  description: 'Optional multi-agent session ID (from chrome_agent_session). Isolates tab ownership, tab group color, and default projectDir across concurrent agents.'
};

const fast = {
  type: 'boolean',
  description: 'Skip decorative cursor animations and artificial delays for maximum speed (auto-enabled in background tabs & batches).'
};

const target = {
  ref: { type: 'string', description: 'Element ref from chrome_read_page, chrome_deep_read, or chrome_find_elements, e.g. "ref_12" (preferred).' },
  selector: { type: 'string', description: 'CSS selector fallback (pierces open Shadow DOM).' },
  text: { type: 'string', description: 'Visible text / accessible name fallback for buttons and links.' }
};

const TOOLS = [
  {
    name: 'chrome_status',
    description: "Check connection to the user's real Chrome browser (version, autonomy mode, paused state, active multi-agent sessions, tracked local downloads, watchProjectDir, active JS dialog, GIF & Macro status, active tab).",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'chrome_list_tabs',
    description: "List open tabs in the user's Chrome with ids, titles, URLs, pinned/audible flags, agent ownership, and Antigravity tab group membership.",
    inputSchema: { type: 'object', properties: { currentWindowOnly: { type: 'boolean' }, agentId } }
  },
  {
    name: 'chrome_open_url',
    description: "Open or navigate to a URL in the user's authenticated Chrome profile. Supports agentId isolation (defaults to background tab when agentId is set so parallel agents never steal focus) and event-driven load completion.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        newTab: { type: 'boolean', description: 'Default true. false = navigate the controlled/agent tab.' },
        tabId,
        agentId,
        active: { type: 'boolean', description: 'Focus tab? Defaults to false when agentId is provided, else true.' },
        waitForLoad: { type: 'boolean' },
        includeSnapshot: { type: 'boolean' },
        timeoutMs: { type: 'number' }
      },
      required: ['url']
    }
  },
  {
    name: 'chrome_read_page',
    description: 'Read the page Accessibility & DOM tree (piercing open Shadow DOM and same-origin iframes, reporting cross-origin frames, plus PDF text extraction): interactive elements with stable [ref_N] ids, visible text, active JS dialogs, and safety gates.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        refId: { type: 'string', description: 'Optional element ref to scope inspection to a specific subtree.' },
        viewportOnly: { type: 'boolean' },
        includeText: { type: 'boolean' },
        maxElements: { type: 'number' },
        maxTextLength: { type: 'number' },
        maxDepth: { type: 'number' }
      }
    }
  },
  {
    name: 'chrome_deep_read',
    description: 'Hyper-fast single-RPC full-intelligence page reader: captures A11y interactive [ref_N] tree (Shadow DOM + iframes), clean GFM Markdown text, structured tables/lists/forms/OpenGraph/JSON-LD, downloadable file/media links, AND live console errors + failed network requests in ONE round-trip. Supports FNV-1a incremental delta diffing (deltaOnly=true) to cut repeat-read tokens by up to 80%.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        deltaOnly: { type: 'boolean', description: 'If true and a previous deep read exists for this tab (or sinceHash matches), return only added/changed/removed elements and text lines.' },
        sinceHash: { type: 'string', description: 'Optional FNV-1a stateHash from a previous chrome_deep_read call.' },
        includeMarkdown: { type: 'boolean', description: 'Default true.' },
        includeStructured: { type: 'boolean', description: 'Include tables, lists, forms, metadata, and JSON-LD (default true).' },
        includeAssets: { type: 'boolean', description: 'Scan downloadable file/document/media links on the page (default true).' },
        includeTelemetry: { type: 'boolean', description: 'Include console errors and failed/recent network requests (default true).' },
        viewportOnly: { type: 'boolean' },
        maxElements: { type: 'number', description: 'Default 220.' },
        maxTextLength: { type: 'number', description: 'Default 18000.' }
      }
    }
  },
  {
    name: 'chrome_get_page_text',
    description: 'Extract clean, token-efficient Markdown text (headings, lists, GFM tables, links, code blocks, YouTube metadata, or PDF document text) from the page without interactive ref overhead.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        maxLength: { type: 'number', description: 'Maximum character length (default 24000).' }
      }
    }
  },
  {
    name: 'chrome_find_elements',
    description: 'Fast semantic & DOM search across light DOM, Shadow DOM, and same-origin iframes by text, accessible name, placeholder, role, or CSS selector. Returns matching [ref_N] elements with coordinates and Playwright locators.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        query: { type: 'string', description: 'Text, label, placeholder, id, or CSS selector to find.' },
        role: { type: 'string', description: 'Optional ARIA role filter, e.g. "button", "textbox", "combobox", "link".' },
        limit: { type: 'number', description: 'Max matches to return (default 25).' }
      }
    }
  },
  {
    name: 'chrome_inspect_element',
    description: 'Deep UI & DevTools inspection of an element: tag, CSS selector path, Playwright locator, attributes, bounding box, computed CSS layout/typography styles, WCAG contrast ratio, outerHTML, and optional cropped element screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        x: { type: 'number' },
        y: { type: 'number' },
        includeScreenshot: { type: 'boolean', description: 'Capture a cropped PNG screenshot of just this element.' }
      }
    }
  },
  {
    name: 'chrome_read_multiple_tabs',
    description: 'High-speed parallel cross-tab synthesis: read Markdown, full deep-read intelligence, or DOM snapshots from up to 12 open tabs concurrently via a bounded worker pool.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: { type: 'array', items: { type: 'number' } },
        urlPattern: { type: 'string', description: 'Regex matching tab URL or title.' },
        agentId,
        mode: { type: 'string', enum: ['markdown', 'deep', 'snapshot'], description: 'Default "markdown". Use "deep" for full structured+interactive info.' },
        concurrency: { type: 'number', description: 'Parallel workers 1..12 (default 6).' },
        maxLengthPerTab: { type: 'number', description: 'Max characters per tab (default 6000).' }
      }
    }
  },
  {
    name: 'chrome_batch_actions',
    description: 'Atomic pipelined multi-step action runner inside Chrome: executes a sequence of actions (click, type, select_option, fill_form, press_key, scroll, hover, wait_for, extract_data, read_page, deep_read, get_page_text, download_file, evaluate, sleep) in 1 single round-trip with fast zero-animation mode (3x-6x speedup).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        steps: {
          type: 'array',
          description: 'Ordered actions to execute.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'click',
                  'type',
                  'select_option',
                  'fill_form',
                  'press_key',
                  'scroll',
                  'hover',
                  'wait_for',
                  'extract_data',
                  'read_page',
                  'deep_read',
                  'get_page_text',
                  'download_file',
                  'evaluate',
                  'sleep'
                ]
              },
              params: { type: 'object', description: 'Parameters for this action step.' }
            },
            required: ['action']
          }
        },
        stopOnError: { type: 'boolean', description: 'Stop batch on first failing step (default true).' },
        fast: { type: 'boolean', description: 'Skip cursor animations (default true).' },
        includeFinalDeepRead: { type: 'boolean', description: 'Append a chrome_deep_read snapshot after all steps complete.' }
      },
      required: ['steps']
    }
  },
  {
    name: 'chrome_download_file',
    description: 'Download ANY file directly into a local project folder (projectDir or savePath) with SHA-256 verification, atomic cross-drive delivery, project manifest logging (.chrome-downloads.json), and optional instant content preview. Automatically picks the best of 4 strategies: (1) chrome.downloads + atomic sync, (2) in-page authenticated fetch for blob:/data: URLs, (3) click-trigger + download capture, or (4) direct Node stream with CDP session cookies.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        url: { type: 'string', description: 'Direct HTTP/HTTPS, blob:, or data: URL to download.' },
        ...target,
        projectDir: { type: 'string', description: 'Absolute local project directory where the file should be saved (e.g. "D:/my-project/data"). Uses agent/watched projectDir if omitted.' },
        savePath: { type: 'string', description: 'Optional exact absolute local file path (overrides projectDir + filename).' },
        filename: { type: 'string', description: 'Optional target filename inside projectDir.' },
        strategy: { type: 'string', enum: ['auto', 'chrome_downloads', 'page_fetch', 'click', 'node_stream'], description: 'Default "auto".' },
        mode: { type: 'string', enum: ['move', 'copy'], description: 'When syncing from Chrome Downloads to projectDir: "move" (default) or "copy".' },
        overwrite: { type: 'boolean', description: 'Overwrite existing file instead of auto-numbering (default false).' },
        writeManifest: { type: 'boolean', description: 'Update <projectDir>/.chrome-downloads.json ledger (default true).' },
        readPreview: { type: 'boolean', description: 'Immediately parse & return project-usable preview (text/JSON/CSV/PDF/image dims/ZIP listing).' },
        timeoutMs: { type: 'number', description: 'Download timeout in ms (default 60000).' }
      }
    }
  },
  {
    name: 'chrome_track_downloads',
    description: 'Track local Chrome & project downloads in real time, wait for in-progress downloads, sync any downloaded file into a project folder, bind a watched projectDir for automatic mirroring of all downloads, or read/parse a downloaded file (JSON, CSV, PDF text, image dimensions, ZIP contents, UTF-8 text) directly for project use.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'wait', 'sync_to_project', 'watch_project', 'read_file', 'clear_history'],
          description: 'Operation to perform.'
        },
        downloadId: { type: 'number', description: 'Chrome download ID (from list).' },
        id: { type: 'string', description: 'Internal ledger record ID.' },
        filePath: { type: 'string', description: 'Absolute local file path for read_file or sync_to_project.' },
        filename: { type: 'string', description: 'Filename filter or target filename.' },
        filenamePattern: { type: 'string', description: 'Regex pattern for wait/list.' },
        latest: { type: 'boolean', description: 'Target the most recent completed download.' },
        projectDir: { type: 'string', description: 'Target local project folder for sync_to_project, watch_project, or list filtering.' },
        savePath: { type: 'string', description: 'Exact local destination path for sync_to_project.' },
        subdir: { type: 'string', description: 'Optional subdirectory inside watched projectDir.' },
        mode: { type: 'string', enum: ['copy', 'move'], description: 'Copy or move when syncing (default "copy" for watch_project, "copy" for sync_to_project).' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Optional extension filter for watch_project, e.g. [".pdf", ".csv", ".json"].' },
        disable: { type: 'boolean', description: 'Set true with action="watch_project" to disable auto-mirroring.' },
        overwrite: { type: 'boolean' },
        writeManifest: { type: 'boolean' },
        state: { type: 'string', enum: ['in_progress', 'complete', 'interrupted'], description: 'Filter for action="list".' },
        query: { type: 'string', description: 'Regex search across filename/URL/path.' },
        agentId,
        sinceMs: { type: 'number', description: 'Unix ms timestamp filter for wait.' },
        timeoutMs: { type: 'number', description: 'Wait timeout in ms (default 45000).' },
        maxBytes: { type: 'number', description: 'Max bytes to read in read_file (default 65536).' },
        maxRows: { type: 'number', description: 'Max CSV/TSV rows to parse (default 150).' },
        includeImage: { type: 'boolean', description: 'Return image content block when reading an image file.' },
        limit: { type: 'number', description: 'Max entries returned by list (default 30).' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_agent_session',
    description: 'Multi-agent concurrency & session isolator: claim isolated tabs, spawn dedicated background worker tabs in color-coded Chrome Tab Groups, bind per-agent projectDir download folders, prevent cross-agent tab collisions with Per-Tab Fair RWLocks, or inspect/release active agents.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'spawn_tab', 'release', 'list', 'status'] },
        agentId: { type: 'string', description: 'Unique agent identifier, e.g. "researcher-1", "qa-2". Required for claim/spawn_tab/release.' },
        tabId: { type: 'number', description: 'Existing tabId to lease to this agent.' },
        url: { type: 'string', description: 'URL to open in a fresh background tab for this agent.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Multiple URLs to spawn concurrently for this agent.' },
        exclusive: { type: 'boolean', description: 'Block writes from other agents to this agent\'s leased tabs (default false).' },
        projectDir: { type: 'string', description: 'Bind a dedicated local download destination folder for this agent.' },
        color: { type: 'string', enum: ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'yellow', 'red', 'grey'], description: 'Optional Chrome Tab Group color for visual multi-agent tracking.' },
        active: { type: 'boolean', description: 'Focus spawned tab? Default false (non-disruptive background execution).' },
        waitForLoad: { type: 'boolean', description: 'Default true.' },
        closeTabs: { type: 'boolean', description: 'On action="release", close temporary tabs spawned/owned by this agent.' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_parallel_run',
    description: 'Multi-agent / multi-tab parallel execution engine: fan out N independent browser tasks (deep_read, download_file, batch_actions, audit_page, extract_data, evaluate, etc.) across multiple tabs simultaneously using a bounded worker pool (1..12 concurrent workers) with Per-Tab Fair RWLocks and per-task latency metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of browser tasks to run concurrently.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional caller task label.' },
              agentId: { type: 'string', description: 'Optional agentId scope for this task.' },
              tabId: { type: 'number', description: 'Existing tabId (optional if url is provided).' },
              url: { type: 'string', description: 'If provided without tabId, spawns an isolated background tab, loads it, runs method, and optionally closes it.' },
              method: { type: 'string', description: 'Any chrome_* tool name (e.g. "chrome_deep_read", "chrome_download_file", "chrome_batch_actions", "chrome_extract_data").' },
              params: { type: 'object', description: 'Tool arguments for method.' }
            },
            required: ['method']
          }
        },
        concurrency: { type: 'number', description: 'Max simultaneous tasks 1..12 (default 6).' },
        closeSpawnedTabs: { type: 'boolean', description: 'Automatically close temporary tabs spawned via task.url after each task finishes (default false).' },
        timeoutMs: { type: 'number', description: 'Per-task timeout in ms (default 60000).' }
      },
      required: ['tasks']
    }
  },
  {
    name: 'chrome_swarm_plan',
    description: 'Cooperative Multi-Agent DAG Mission Planner & Executor: define a team of specialist agents with explicit roles & responsibilities (planner, researcher, operator, downloader, auditor, custom) and a dependency DAG of browser tasks. Validates acyclicity via 3-color DFS, prioritizes critical-path bottlenecks, runs dynamic event-driven parallel execution across color-coded tab groups, passes upstream outputs via {{tasks.<id>.result.<field>}} and {{blackboard.<key>}} templates, and persists mission state to <projectDir>/.chrome-mission.json.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_plan', 'execute', 'status', 'list', 'roles', 'release'] },
        missionId: { type: 'string', description: 'Mission identifier (auto-generated on create_plan if omitted).' },
        goal: { type: 'string', description: 'High-level mission objective.' },
        projectDir: { type: 'string', description: 'Shared local project directory for mission downloads and .chrome-mission.json.' },
        concurrency: { type: 'number', description: 'Max concurrent worker tasks 1..12 (default 6).' },
        provisionNow: { type: 'boolean', description: 'On create_plan, immediately provision agent tab groups & sessions.' },
        closeSpawnedTabs: { type: 'boolean', description: 'On execute, close temporary tabs spawned via task.url (default true).' },
        closeTabs: { type: 'boolean', description: 'On release, close all tabs owned by mission agents.' },
        agents: {
          type: 'array',
          description: 'Team roster with roles and responsibilities.',
          items: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              role: { type: 'string', enum: ['planner', 'researcher', 'operator', 'downloader', 'auditor', 'custom'] },
              responsibilities: { type: 'array', items: { type: 'string' } },
              color: { type: 'string', enum: ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'yellow', 'red', 'grey'] },
              projectDir: { type: 'string' },
              exclusive: { type: 'boolean' }
            },
            required: ['agentId']
          }
        },
        tasks: {
          type: 'array',
          description: 'Directed Acyclic Graph (DAG) of tasks assigned to specialist agents.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              assignedTo: { type: 'string', description: 'agentId from agents[] roster.' },
              role: { type: 'string', enum: ['planner', 'researcher', 'operator', 'downloader', 'auditor', 'custom'] },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Upstream task IDs that must finish before this task runs.' },
              url: { type: 'string', description: 'Optional URL to open in a background tab for this task (supports {{...}} templates).' },
              tabId: { type: 'number' },
              method: { type: 'string', description: 'Any chrome_* tool name.' },
              params: { type: 'object', description: 'Tool arguments (supports {{tasks.<id>.result.<path>}} & {{blackboard.<key>}} templates).' },
              retries: { type: 'number', description: 'Automatic retry count 0..3 with exponential backoff.' },
              saveArtifactKey: { type: 'string', description: 'Automatically store task output under this key in the mission Blackboard.' },
              onFailure: { type: 'string', enum: ['skip_dependents', 'continue', 'fail_mission'] },
              timeoutMs: { type: 'number' }
            },
            required: ['id', 'method']
          }
        },
        initialBlackboard: { type: 'object', description: 'Optional initial shared key-value data for all agents.' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_swarm_blackboard',
    description: 'Shared Multi-Agent Mission Blackboard & Inter-Agent Handoff Bus: store/read structured artifacts, exchange targeted handoff messages between specialist agents (fromAgent -> toAgent/all), and dynamically claim or complete shared mission tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['put', 'get', 'list', 'post_message', 'read_messages', 'claim_task', 'complete_task'] },
        missionId: { type: 'string', description: 'Mission ID (defaults to "default-workspace").' },
        projectDir: { type: 'string' },
        agentId: { type: 'string', description: 'Calling agent identifier.' },
        role: { type: 'string' },
        key: { type: 'string', description: 'Blackboard key for put/get.' },
        value: { description: 'Any JSON-serializable artifact value for put.' },
        tags: { type: 'array', items: { type: 'string' } },
        toAgent: { type: 'string', description: 'Target agentId or "all" for post_message/read_messages.' },
        topic: { type: 'string', description: 'Message topic, e.g. "urls_discovered", "file_ready", "audit_passed".' },
        message: { type: 'string' },
        payload: { description: 'Structured JSON payload attached to handoff message.' },
        taskId: { type: 'string', description: 'Task ID for claim_task/complete_task.' },
        result: { description: 'Result object for complete_task.' },
        failed: { type: 'boolean' },
        error: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_click',
    description: 'Click an element by ref/selector/text, or at viewport (x,y). Supports left/right/middle, doubleClick, tripleClick, modifier keys, fast=true, and useCdp=true hardware input.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        doubleClick: { type: 'boolean' },
        tripleClick: { type: 'boolean' },
        ctrlKey: { type: 'boolean' },
        shiftKey: { type: 'boolean' },
        altKey: { type: 'boolean' },
        metaKey: { type: 'boolean' },
        useCdp: { type: 'boolean' },
        fast
      }
    }
  },
  {
    name: 'chrome_hover',
    description: 'Glide cursor to an element or coordinate and trigger mouseover/hover menus.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        x: { type: 'number' },
        y: { type: 'number' },
        dwellMs: { type: 'number' },
        label: { type: 'string' },
        fast
      }
    }
  },
  {
    name: 'chrome_highlight',
    description: 'Highlight an element with a clean inspection frame on the live page (clear=true removes highlight).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        clear: { type: 'boolean' },
        durationMs: { type: 'number' },
        label: { type: 'string' }
      }
    }
  },
  {
    name: 'chrome_drag_and_drop',
    description: 'Drag from sourceRef/sourceSelector/(startX,startY) to targetRef/targetSelector/(endX,endY). Set useCdp=true for hardware mouse drag on canvases or sliders.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        sourceRef: { type: 'string' },
        sourceSelector: { type: 'string' },
        startX: { type: 'number' },
        startY: { type: 'number' },
        targetRef: { type: 'string' },
        targetSelector: { type: 'string' },
        endX: { type: 'number' },
        endY: { type: 'number' },
        steps: { type: 'number' },
        useCdp: { type: 'boolean' }
      }
    }
  },
  {
    name: 'chrome_upload_file',
    description: 'Upload one or more local files into an <input type="file"> or drag-and-drop dropzone on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ref: { type: 'string', description: 'Ref of <input type="file"> or dropzone.' },
        selector: { type: 'string', description: 'CSS selector of file input or dropzone.' },
        filePath: { type: 'string', description: 'Absolute local path to file to upload.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Multiple absolute local file paths.' }
      }
    }
  },
  {
    name: 'chrome_type',
    description: 'Type text into an input, textarea, contenteditable, or <select> (React/Vue/Angular compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        text: { type: 'string', description: 'Text value to enter.' },
        clearFirst: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
        humanSpeed: { type: 'boolean' },
        useCdp: { type: 'boolean' },
        fast
      },
      required: ['text']
    }
  },
  {
    name: 'chrome_select_option',
    description: 'Select single or multiple options in a native <select> or custom ARIA [role="combobox"] / [role="listbox"] dropdown by value, visible label, index, or values array.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        value: { type: 'string', description: 'Option value or visible label to select.' },
        label: { type: 'string', description: 'Visible option label to match.' },
        index: { type: 'number', description: 'Zero-based option index.' },
        values: { type: 'array', items: { type: 'string' }, description: 'Multiple values/labels for <select multiple>.' },
        fast
      }
    }
  },
  {
    name: 'chrome_fill_form',
    description: 'Populate multiple form inputs, native/ARIA selects, radios, or checkboxes in a single call.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        fast,
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              selector: { type: 'string' },
              value: { type: 'string' },
              checked: { type: 'boolean' }
            }
          }
        }
      },
      required: ['fields']
    }
  },
  {
    name: 'chrome_press_key',
    description: 'Press a keyboard key or shortcut chord (e.g. "Enter", "Escape", "Tab", "Control+a"). Set useCdp=true for hardware-level key events.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        key: { type: 'string' },
        useCdp: { type: 'boolean' }
      },
      required: ['key']
    }
  },
  {
    name: 'chrome_scroll',
    description: 'Scroll the viewport, a scrollable container, or scroll an element into view (toElement=true). Set useCdp=true for hardware mouseWheel events on canvas/virtualized UIs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ...target,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
        amount: { type: 'number' },
        toElement: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        useCdp: { type: 'boolean' },
        fast
      }
    }
  },
  {
    name: 'chrome_wait_for',
    description: 'Wait until a selector, text, or URL substring appears (or disappears with state="hidden"). Max 30s.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        selector: { type: 'string' },
        text: { type: 'string' },
        urlIncludes: { type: 'string' },
        state: { type: 'string', enum: ['visible', 'hidden'] },
        timeoutMs: { type: 'number' }
      }
    }
  },
  {
    name: 'chrome_handle_dialog',
    description: 'Accept or dismiss a native JavaScript alert, confirm, prompt, or beforeunload dialog, or configure autoDismiss=true so dialogs never block automation.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        accept: { type: 'boolean', description: 'true to click OK/Accept, false to Cancel/Dismiss.' },
        promptText: { type: 'string', description: 'Text to enter into window.prompt().' },
        autoDismiss: { type: 'boolean', description: 'Automatically dismiss future dialogs on this tab.' }
      }
    }
  },
  {
    name: 'chrome_resize_viewport',
    description: 'Emulate responsive mobile, tablet, or desktop viewport dimensions via CDP (or reset=true to restore default).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        mobile: { type: 'boolean' },
        reset: { type: 'boolean' }
      }
    }
  },
  {
    name: 'chrome_emulate',
    description: 'Emulate colorScheme (dark/light), reducedMotion, mediaType (screen/print), networkProfile (offline/slow-3g/fast-3g/4g/online), cpuThrottlingRate (1-20), timezoneId, geolocation {latitude,longitude}, or userAgent via CDP. Pass reset=true to clear all overrides.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        colorScheme: { type: 'string', enum: ['dark', 'light', 'no-preference'] },
        reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
        mediaType: { type: 'string', enum: ['screen', 'print', ''] },
        networkProfile: { type: 'string', enum: ['online', 'offline', 'slow-3g', 'fast-3g', '4g'] },
        cpuThrottlingRate: { type: 'number', description: '1 = no throttling, 4 = 4x slowdown, etc.' },
        timezoneId: { type: 'string', description: 'IANA timezone ID, e.g. "America/New_York" or "Asia/Dhaka".' },
        geolocation: {
          type: 'object',
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            accuracy: { type: 'number' }
          }
        },
        userAgent: { type: 'string' },
        reset: { type: 'boolean', description: 'Restore all emulated media, network, CPU, timezone, and geolocation settings.' }
      }
    }
  },
  {
    name: 'chrome_storage',
    description: 'Inspect, set, delete, or clear HTTP-only & browser Cookies (via CDP), localStorage, or sessionStorage on the target tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        storageType: { type: 'string', enum: ['cookies', 'localStorage', 'sessionStorage', 'all'], description: 'Default "all" for get, required for set/delete/clear.' },
        action: { type: 'string', enum: ['get', 'set', 'delete', 'clear'], description: 'Default "get".' },
        key: { type: 'string', description: 'Cookie name or Web Storage key.' },
        value: { type: 'string', description: 'Value to store when action="set".' },
        domain: { type: 'string', description: 'Optional cookie domain.' },
        path: { type: 'string', description: 'Optional cookie path (default "/").' },
        secure: { type: 'boolean' },
        httpOnly: { type: 'boolean' },
        sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
        expires: { type: 'number', description: 'Unix epoch seconds for cookie expiration.' }
      }
    }
  },
  {
    name: 'chrome_audit_page',
    description: 'Run a live Core Web Vitals (TTFB, FCP, LCP, CLS, render-blocking resources, lazy-LCP anti-patterns), WCAG 2.2 AA Accessibility (sRGB contrast < 4.5:1, unlabeled controls, small tap targets < 24px, heading skips), and SEO/OpenGraph/JSON-LD audit with 0-100 scores.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        categories: {
          type: 'array',
          items: { type: 'string', enum: ['performance', 'accessibility', 'seo'] },
          description: 'Defaults to all three categories.'
        }
      }
    }
  },
  {
    name: 'chrome_extract_data',
    description: 'Deterministic zero-token structured scraper: extract HTML tables (as JSON objects + GFM Markdown), repeating card/list grids, links, OpenGraph metadata, and JSON-LD schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        mode: { type: 'string', enum: ['auto', 'tables', 'lists', 'links', 'metadata', 'schema'], description: 'Default "auto".' },
        selector: { type: 'string', description: 'Optional container CSS selector to scope extraction.' },
        limit: { type: 'number', description: 'Max items/rows per collection (default 100).' }
      }
    }
  },
  {
    name: 'chrome_save_pdf',
    description: 'Export the target tab to a crisp vector PDF via CDP Page.printToPDF and save directly to savePath or projectDir on disk (auto-tracked in download ledger).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        savePath: { type: 'string', description: 'Optional local .pdf path to write on disk.' },
        projectDir: { type: 'string', description: 'Optional project directory to save PDF into.' },
        filename: { type: 'string', description: 'Optional filename when using projectDir.' },
        landscape: { type: 'boolean' },
        printBackground: { type: 'boolean', description: 'Default true.' },
        scale: { type: 'number', description: 'Scale factor 0.1 to 2.0 (default 1).' },
        pageRanges: { type: 'string', description: 'Optional page ranges, e.g. "1-3".' }
      }
    }
  },
  {
    name: 'chrome_screenshot',
    description: 'Capture screenshot of viewport, fullPage, specific element ref, or clip region {x,y,width,height}. annotateElements=true draws Set-of-Marks ref badges. Optional savePath/projectDir writes PNG/JPEG to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        ref: { type: 'string', description: 'Optional element ref to crop screenshot to.' },
        clip: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          }
        },
        annotateElements: { type: 'boolean' },
        fullPage: { type: 'boolean' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        savePath: { type: 'string', description: 'Optional local file path to save the screenshot.' },
        projectDir: { type: 'string', description: 'Optional project folder to save the screenshot into.' }
      }
    }
  },
  {
    name: 'chrome_gif_recorder',
    description: 'Record multi-step browser interactions into an animated GIF89a file. Actions: "start" | "capture_frame" | "stop" | "status".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        action: { type: 'string', enum: ['start', 'capture_frame', 'stop', 'status'] },
        caption: { type: 'string', description: 'Optional caption overlay for captured frame.' },
        savePath: { type: 'string', description: 'Optional local .gif file path to write on stop.' },
        projectDir: { type: 'string', description: 'Optional project folder to write GIF into on stop.' },
        maxWidth: { type: 'number' },
        delayMs: { type: 'number' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_macro_recorder',
    description: 'Record real human clicks, text inputs, selects, and key presses on a live tab, replay recorded steps autonomously, or export a ready-to-run Playwright .spec.ts test script.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        action: { type: 'string', enum: ['start', 'stop', 'status', 'replay', 'clear'] },
        testName: { type: 'string', description: 'Optional test name for generated Playwright .spec.ts.' },
        savePath: { type: 'string', description: 'Optional local .spec.ts file path to save Playwright code on stop.' }
      },
      required: ['action']
    }
  },
  {
    name: 'chrome_watch_page',
    description: 'Monitor a live tab or CSS selector for content changes: "baseline" stores a snapshot, "check" returns whether content changed plus added/removed lines.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        action: { type: 'string', enum: ['baseline', 'check', 'clear'], description: 'Default "check" (creates baseline if none exists).' },
        selector: { type: 'string', description: 'Optional CSS selector to monitor instead of entire body.' },
        ref: { type: 'string', description: 'Optional element ref to monitor.' }
      }
    }
  },
  {
    name: 'chrome_evaluate',
    description: "Run JavaScript in the page's main world via CDP and return the JSON-serializable result.",
    inputSchema: {
      type: 'object',
      properties: { tabId, agentId, expression: { type: 'string' }, awaitPromise: { type: 'boolean' } },
      required: ['expression']
    }
  },
  {
    name: 'chrome_get_console_logs',
    description: 'Read console messages and uncaught exceptions with optional regex pattern filter, onlyErrors filter, and clear flag.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        pattern: { type: 'string', description: 'Regex filter for log messages.' },
        onlyErrors: { type: 'boolean' },
        clear: { type: 'boolean' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'chrome_get_network_logs',
    description: 'Read network requests, HTTP methods, status codes, POST payloads, or fetch a specific response body (requestId + includeBody=true).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        urlPattern: { type: 'string', description: 'Regex filter for request URLs.' },
        requestId: { type: 'string', description: 'CDP requestId to fetch response body for.' },
        includeBody: { type: 'boolean' },
        clear: { type: 'boolean' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'chrome_manage_tabs',
    description: 'Tab actions: activate | close | duplicate | pin | unpin | mute | unmute | reload | go_back | go_forward | group | ungroup | detach_debugger.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        agentId,
        action: {
          type: 'string',
          enum: [
            'activate',
            'close',
            'duplicate',
            'pin',
            'unpin',
            'mute',
            'unmute',
            'reload',
            'go_back',
            'go_forward',
            'group',
            'ungroup',
            'detach_debugger'
          ]
        }
      },
      required: ['action']
    }
  }
];

function normalizeParams(name, args = {}) {
  if (name === 'chrome_type') {
    return { ...args, text: args.text };
  }
  return args;
}

module.exports = { TOOLS, normalizeParams };
