/**
 * MCP tool definitions exposed to Antigravity (v2.1.0 — 34 Autonomous Browser & DevTools Tools).
 * Surpasses Claude in Chrome, ChatGPT/Operator, @playwright/mcp, chrome-devtools-mcp, Stagehand, Automa & HARPA.
 */

'use strict';

const tabId = {
  type: 'number',
  description: 'Target tab id (from chrome_list_tabs). Defaults to the tab Antigravity is currently controlling, else the active tab.'
};

const target = {
  ref: { type: 'string', description: 'Element ref from chrome_read_page or chrome_find_elements, e.g. "ref_12" (preferred).' },
  selector: { type: 'string', description: 'CSS selector fallback (pierces open Shadow DOM).' },
  text: { type: 'string', description: 'Visible text / accessible name fallback for buttons and links.' }
};

const TOOLS = [
  {
    name: 'chrome_status',
    description: "Check connection to the user's real Chrome browser (version, autonomy mode, paused state, active JS dialog, GIF & Macro recording status, active tab).",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'chrome_list_tabs',
    description: "List open tabs in the user's Chrome with ids, titles, URLs, pinned/audible flags, and Antigravity tab group membership.",
    inputSchema: { type: 'object', properties: { currentWindowOnly: { type: 'boolean' } } }
  },
  {
    name: 'chrome_open_url',
    description: "Open or navigate to a URL in the user's authenticated Chrome profile. Opens in the 'Antigravity' tab group by default and returns an initial page snapshot.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        newTab: { type: 'boolean', description: 'Default true. false = navigate the controlled tab.' },
        tabId,
        active: { type: 'boolean' },
        waitForLoad: { type: 'boolean' },
        includeSnapshot: { type: 'boolean' }
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
    name: 'chrome_get_page_text',
    description: 'Extract clean, token-efficient Markdown text (headings, lists, GFM tables, links, code blocks, YouTube metadata, or PDF document text) from the page without interactive ref overhead.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
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
        ...target,
        x: { type: 'number' },
        y: { type: 'number' },
        includeScreenshot: { type: 'boolean', description: 'Capture a cropped PNG screenshot of just this element.' }
      }
    }
  },
  {
    name: 'chrome_read_multiple_tabs',
    description: 'Cross-tab synthesis: read clean Markdown content from multiple open tabs in parallel (by tabIds array, urlPattern regex, or all tabs in the Antigravity group).',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: { type: 'array', items: { type: 'number' } },
        urlPattern: { type: 'string', description: 'Regex matching tab URL or title.' },
        maxLengthPerTab: { type: 'number', description: 'Max characters per tab (default 6000).' }
      }
    }
  },
  {
    name: 'chrome_click',
    description: 'Click an element by ref/selector/text, or at viewport (x,y). Supports left/right/middle, doubleClick, tripleClick, modifier keys, and useCdp=true hardware input.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
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
        useCdp: { type: 'boolean' }
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
        ...target,
        x: { type: 'number' },
        y: { type: 'number' },
        dwellMs: { type: 'number' },
        label: { type: 'string' }
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
        ...target,
        text: { type: 'string', description: 'Text value to enter.' },
        clearFirst: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
        humanSpeed: { type: 'boolean' },
        useCdp: { type: 'boolean' }
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
        ...target,
        value: { type: 'string', description: 'Option value or visible label to select.' },
        label: { type: 'string', description: 'Visible option label to match.' },
        index: { type: 'number', description: 'Zero-based option index.' },
        values: { type: 'array', items: { type: 'string' }, description: 'Multiple values/labels for <select multiple>.' }
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
        ...target,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
        amount: { type: 'number' },
        toElement: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        useCdp: { type: 'boolean' }
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
        mode: { type: 'string', enum: ['auto', 'tables', 'lists', 'links', 'metadata', 'schema'], description: 'Default "auto".' },
        selector: { type: 'string', description: 'Optional container CSS selector to scope extraction.' },
        limit: { type: 'number', description: 'Max items/rows per collection (default 100).' }
      }
    }
  },
  {
    name: 'chrome_save_pdf',
    description: 'Export the target tab to a crisp vector PDF via CDP Page.printToPDF and optionally save directly to savePath on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        savePath: { type: 'string', description: 'Optional local .pdf path to write on disk.' },
        landscape: { type: 'boolean' },
        printBackground: { type: 'boolean', description: 'Default true.' },
        scale: { type: 'number', description: 'Scale factor 0.1 to 2.0 (default 1).' },
        pageRanges: { type: 'string', description: 'Optional page ranges, e.g. "1-3".' }
      }
    }
  },
  {
    name: 'chrome_screenshot',
    description: 'Capture screenshot of viewport, fullPage, specific element ref, or clip region {x,y,width,height}. annotateElements=true draws Set-of-Marks ref badges.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
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
        format: { type: 'string', enum: ['png', 'jpeg'] }
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
        action: { type: 'string', enum: ['start', 'capture_frame', 'stop', 'status'] },
        caption: { type: 'string', description: 'Optional caption overlay for captured frame.' },
        savePath: { type: 'string', description: 'Optional local .gif file path to write on stop.' },
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
      properties: { tabId, expression: { type: 'string' }, awaitPromise: { type: 'boolean' } },
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
