# Gemini Antigravity in Chrome (v2.1.0)

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install%20v2.1.0-2563eb?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg)
[![MCP Tools](https://img.shields.io/badge/MCP%20Tools-34%20Local%20Tools-10b981)](https://extensions.vionixai.tech/gemini-antigravity/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3%20%7C%20100%25%20Local-0f172a)](https://extensions.vionixai.tech/gemini-antigravity/)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1)](./LICENSE)

**Gemini Antigravity in Chrome** is a Manifest V3 Chrome extension and **100% local Model Context Protocol (MCP) browser automation bridge** built by **[VionixAI](https://vionixai.tech/)** that connects **Google Antigravity IDE (v2.33+) & Gemini CLI** directly to your active, signed-in Google Chrome browser.

- **Official Landing Page & Docs**: [https://extensions.vionixai.tech/gemini-antigravity/](https://extensions.vionixai.tech/gemini-antigravity/)
- **Chrome Web Store**: [https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg](https://chromewebstore.google.com/detail/jilnmjdedhlhhnlopjijgbkoblbeihmg)
- **Machine-Readable LLM Spec**: [https://extensions.vionixai.tech/gemini-antigravity/llms.md](https://extensions.vionixai.tech/gemini-antigravity/llms.md)
- **VionixAI Chrome Extensions Hub**: [https://extensions.vionixai.tech/](https://extensions.vionixai.tech/)

---

## Why Local MV3 MCP Instead of Cloud Headless Browsers?

| Capability | Gemini Antigravity in Chrome v2.1.0 | Cloud Headless Agents |
| :--- | :--- | :--- |
| **Authenticated Sessions** | Runs in your real Chrome profile (keeps SSO & cookies) | Forces re-login, breaks on MFA |
| **Localhost Dev Servers** | Native access to `localhost:3000` & staging apps | Requires external tunnels |
| **Privacy & Data Boundary** | 100% local `127.0.0.1:17380` + Native Messaging | Streams DOM & screenshots to cloud VMs |
| **DevTools & QA Suite** | 34 MCP tools: CWV/WCAG 2.2 audit, HTTP-only cookies, CDP emulation, vector PDF, GIF89a & `@playwright/test` codegen | Basic click/type loops only |
| **Safety Guardrails** | Auto-pauses on passwords, 2FA/OTP, CAPTCHA & payments | Limited or manual VM takeover |

---

## Complete 34-Tool Local MCP Suite

| Category | Tools |
| :--- | :--- |
| **Page Understanding & Inspection (8)** | `chrome_status`, `chrome_list_tabs`, `chrome_open_url`, `chrome_read_page` (Shadow DOM + iframes), `chrome_get_page_text` (GFM Markdown + PDFs), `chrome_find_elements` (Playwright locators), `chrome_inspect_element` (CSS + WCAG contrast), `chrome_read_multiple_tabs` |
| **Browser Actuation & Forms (11)** | `chrome_click`, `chrome_hover`, `chrome_highlight`, `chrome_type`, `chrome_select_option` (native, multi-select, ARIA combobox), `chrome_fill_form`, `chrome_press_key`, `chrome_drag_and_drop`, `chrome_upload_file`, `chrome_scroll`, `chrome_wait_for` |
| **Audits, Emulation & Storage (7)** | `chrome_audit_page` (Core Web Vitals + WCAG 2.2 AA + SEO 0–100), `chrome_emulate` (dark/light, reducedMotion, network, CPU, timezone, GPS, UA), `chrome_resize_viewport`, `chrome_storage` (HTTP-only CDP cookies + Web Storage), `chrome_evaluate`, `chrome_get_console_logs`, `chrome_get_network_logs` |
| **Codegen, Extraction, PDF & GIF (8)** | `chrome_macro_recorder` (human replay + `@playwright/test` `.spec.ts` codegen), `chrome_extract_data` (JSON/GFM tables + JSON-LD), `chrome_save_pdf` (CDP vector PDF), `chrome_watch_page` (live DOM diff), `chrome_screenshot` (Set-of-Marks + background CDP), `chrome_gif_recorder` (pure-JS GIF89a), `chrome_handle_dialog`, `chrome_manage_tabs` |

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
