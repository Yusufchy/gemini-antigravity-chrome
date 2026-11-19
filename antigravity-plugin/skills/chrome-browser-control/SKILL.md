---
name: chrome-browser-control
description: Drive the user's real, logged-in Chrome browser through the Gemini Antigravity v2.1.0 extension (34 antigravity-chrome MCP tools). Use when the user asks to do something "in Chrome", "in my browser", on a site they are logged into, across multiple open tabs, on PDFs, to audit Core Web Vitals/WCAG, inspect cookies/storage, emulate dark mode/network/geo, record macros/Playwright tests, or export PDFs/GIFs.
---

# Chrome Browser Control (Gemini Antigravity in Chrome v2.1.0 — 34 Tools)

The `antigravity-chrome` MCP server controls the user's **own** authenticated Chrome profile — keeping cookies, SSO logins, and active tabs intact.

## Core Autonomous Loop

1. **Locate** — `chrome_status`, `chrome_list_tabs`, or `chrome_open_url`.
2. **Perceive & Extract** —
   - Interactive tasks: `chrome_read_page` (pierces Shadow DOM + same-origin iframes, reports cross-origin frames, and extracts PDF text).
   - Fast reading / research: `chrome_get_page_text` (clean Markdown with GFM tables & code blocks) or `chrome_read_multiple_tabs` (parallel cross-tab synthesis).
   - Zero-token structured scraping: `chrome_extract_data {mode: "auto" | "tables" | "lists" | "links" | "metadata" | "schema"}`.
   - Targeted search & inspection: `chrome_find_elements {query, role}` (includes Playwright locators) and `chrome_inspect_element {ref, includeScreenshot: true}` (includes WCAG contrast ratio & computed CSS).
3. **Act & Emulate** —
   - Click / Hover / Drag / Scroll: `chrome_click {ref}`, `chrome_hover`, `chrome_drag_and_drop`, `chrome_scroll`.
   - Forms & Dropdowns: `chrome_type`, `chrome_select_option` (native `<select>`, `<select multiple>`, and custom ARIA `[role="combobox"]`), `chrome_fill_form`, `chrome_press_key`, `chrome_upload_file`.
   - State & Emulation: `chrome_storage` (HTTP-only cookies via CDP + `localStorage` + `sessionStorage`), `chrome_emulate` (`colorScheme`, `networkProfile`, `cpuThrottlingRate`, `timezoneId`, `geolocation`), `chrome_resize_viewport`, `chrome_handle_dialog`.
4. **Audit, Watch & Export** —
   - Live Lighthouse-grade audit: `chrome_audit_page` (Core Web Vitals TTFB/FCP/LCP/CLS + WCAG 2.2 AA contrast & tap targets + SEO/JSON-LD scores).
   - Change monitoring: `chrome_watch_page {action: "baseline" | "check", selector}`.
   - Recording & Export: `chrome_save_pdf {savePath}`, `chrome_screenshot`, `chrome_gif_recorder`, and `chrome_macro_recorder {action: "start" | "stop" | "replay", savePath}` (Playwright `.spec.ts` codegen).

## Safety & Guardrails

- Stop and hand back to the user when a `SAFETY GATE` (`AUTHENTICATION_PASSWORD`, `MFA_CHALLENGE`, `CAPTCHA_CHALLENGE`, `PAYMENT_CHECKOUT`) is reported, or when control is `PAUSED` or gated by Supervised (`Ask`) mode.
- Confirm with the user before irreversible actions (purchases, sending messages/emails, deleting data, publishing) unless explicitly requested.
