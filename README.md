# Gemini Antigravity in Chrome (v2.2.0)

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install%20v2.2.0-2563eb?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg)
[![MCP Tools](https://img.shields.io/badge/MCP%20Tools-42%20Local%20Tools-10b981)](https://extensions.vionixai.tech/gemini-antigravity/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3%20%7C%20100%25%20Local-0f172a)](https://extensions.vionixai.tech/gemini-antigravity/)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1)](./LICENSE)

**Gemini Antigravity in Chrome** is a Manifest V3 Chrome extension and **100% local Model Context Protocol (MCP) browser automation & cooperative multi-agent DAG swarm bridge** built by **[VionixAI](https://vionixai.tech/)** that connects **Google Antigravity IDE (v2.33+) & Gemini CLI** directly to your active, signed-in Google Chrome browser.

- **Official Landing Page & Docs**: [https://extensions.vionixai.tech/gemini-antigravity/](https://extensions.vionixai.tech/gemini-antigravity/)
- **Chrome Web Store**: [https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg](https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg)
- **Machine-Readable LLM Spec**: [https://extensions.vionixai.tech/gemini-antigravity/llms.md](https://extensions.vionixai.tech/gemini-antigravity/llms.md)
- **VionixAI Chrome Extensions Hub**: [https://extensions.vionixai.tech/](https://extensions.vionixai.tech/)

---

## Why Local MV3 MCP Instead of Cloud Headless Browsers?

| Capability | Gemini Antigravity in Chrome v2.2.0 | Cloud Headless Agents |
| :--- | :--- | :--- |
| **Authenticated Sessions** | Runs in your real Chrome profile (keeps SSO & cookies) | Forces re-login, breaks on MFA |
| **Local Project Downloads** | 4-tier zero-prompt download engine straight to `projectDir` with SHA-256 + JSON/CSV/PDF/ZIP/image parsing | Trapped in remote sandbox |
| **Multi-Agent DAG Swarms** | Specialist roles (`planner`, `researcher`, `operator`, `downloader`, `auditor`), 3-color DFS DAG planner, Critical-Path scheduler, Per-Tab RWLocks & shared Blackboard | Single-agent serial loops |
| **Hyper-Speed Reading** | Single-RPC `chrome_deep_read` (FNV-1a delta diffing) + atomic `chrome_batch_actions` + Ready-Tab Cache | 4–8 serial round-trips |
| **Privacy & Data Boundary** | 100% local `127.0.0.1:17380` + Native Messaging | Streams DOM & screenshots to cloud VMs |
| **Safety Guardrails** | Auto-pauses on passwords, 2FA/OTP, CAPTCHA & payments | Limited or manual VM takeover |

---

## Complete 42-Tool Local MCP Suite

| Category | Tools |
| :--- | :--- |
| **Local Project Downloads & File Intelligence (2)** | `chrome_download_file` (4-tier zero-prompt delivery to `projectDir` + SHA-256 + `.chrome-downloads.json`), `chrome_track_downloads` (`list`, `wait`, `sync_to_project`, `watch_project`, native `read_file` for JSON/CSV/PDF/ZIP/images) |
| **Cooperative Multi-Agent Swarm & Parallelism (4)** | `chrome_swarm_plan` (role-based DAG planner, Critical-Path dynamic scheduler, `{{tasks.*}}` template handoffs), `chrome_swarm_blackboard` (shared memory & inter-agent bus), `chrome_agent_session` (Per-Tab Fair RWLocks & color-coded Tab Groups), `chrome_parallel_run` (1–12 worker parallel fan-out) |
| **Hyper-Speed Reading & Pipelines (10)** | `chrome_deep_read` (single-RPC full intelligence + FNV-1a delta diff + downloadable asset scanner), `chrome_batch_actions` (atomic multi-step pipeline in 1 round-trip), `chrome_status`, `chrome_list_tabs`, `chrome_open_url`, `chrome_read_page`, `chrome_get_page_text`, `chrome_find_elements`, `chrome_inspect_element`, `chrome_read_multiple_tabs` |
| **Browser Actuation & Forms (11)** | `chrome_click`, `chrome_hover`, `chrome_highlight`, `chrome_type`, `chrome_select_option`, `chrome_fill_form`, `chrome_press_key`, `chrome_drag_and_drop`, `chrome_upload_file`, `chrome_scroll`, `chrome_wait_for` |
| **Audits, Emulation & Storage (7)** | `chrome_audit_page` (Core Web Vitals + WCAG 2.2 AA + SEO 0–100), `chrome_emulate`, `chrome_resize_viewport`, `chrome_storage` (HTTP-only CDP cookies + Web Storage), `chrome_evaluate`, `chrome_get_console_logs`, `chrome_get_network_logs` |
| **Codegen, Extraction, PDF & GIF (8)** | `chrome_macro_recorder` (human replay + `@playwright/test` `.spec.ts` codegen), `chrome_extract_data`, `chrome_save_pdf`, `chrome_watch_page`, `chrome_screenshot`, `chrome_gif_recorder`, `chrome_handle_dialog`, `chrome_manage_tabs` |

---

## Quick Start

### 1. Install the Chrome Extension
Install directly from the **[Chrome Web Store](https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg)** (ID: `jilnmjdedhlhhnlopjijgbkoblbeihmg`), or load `./extension` unpacked in `chrome://extensions`.

### 2. Register the Local Native Bridge
Requires Node.js 18+:

```bash
node scripts/install.js
```

### 3. Add to Any MCP Client (`mcp.json`)
```json
{
  "mcpServers": {
    "antigravity-chrome": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-antigravity-chrome/bridge/mcp-server.js"]
    }
  }
}
```

### 4. Keyboard Shortcuts
`Alt+Shift+G` (Side Panel) · `Alt+Shift+E` (Element Picker) · `Alt+Shift+S` (Pause/Resume)

---

## Security & Privacy
- **100% Local**: Communicates strictly over `127.0.0.1:17380` and Chrome Native Messaging (`com.google.antigravity.chrome_bridge`) with a per-user 256-bit token.
- **Zero Telemetry**: Zero browsing history, credentials, or DOM content ever leaves your machine. See [SECURITY.md](./SECURITY.md) and [PRIVACY.md](./PRIVACY.md).

## VionixAI Ecosystem
- [VionixAI Chrome Extensions Hub](https://extensions.vionixai.tech/) ([llms.txt](https://extensions.vionixai.tech/llms.txt))
- [VionixAI Platform Home](https://vionixai.tech/)
- [VionixAI 81 Free Browser Engineering Tools](https://tools.vionixai.tech/)
- [WPConnect AI — WordPress MCP & OpenAPI 3.1 Bridge](https://wpconnect.vionixai.tech/)

## License
MIT © 2026 [VionixAI](https://vionixai.tech/)
