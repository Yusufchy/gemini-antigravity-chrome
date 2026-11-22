---
name: chrome-browser-control
description: Drive the user's real, logged-in Chrome browser through Gemini Antigravity in Chrome v2.2.0 (42 antigravity-chrome MCP tools) with local project download sync, hyper-speed single-pass deep reading, atomic batch actions, and cooperative multi-agent DAG swarm orchestration.
---

# Gemini Antigravity in Chrome v2.2.0 — 42-Tool Autonomous Browser & Multi-Agent Swarm Playbook

The `antigravity-chrome` MCP server controls the user's **real, signed-in Chrome browser** over `127.0.0.1:17380`.

## 1. Hyper-Speed Reading & Execution (Use First!)
- **`chrome_deep_read`**: Single-RPC full page intelligence — captures A11y `[ref_N]` tree (Shadow DOM + iframes), clean GFM Markdown, tables/lists/forms/JSON-LD, **downloadable file/media links**, and live console/network errors in ONE call. Pass `deltaOnly: true` on repeat reads for up to 80% token savings.
- **`chrome_batch_actions`**: Execute multi-step `click`, `type`, `select_option`, `fill_form`, `wait_for`, `extract_data`, `download_file`, and `evaluate` pipelines in **1 single round-trip** with zero-animation fast mode.

## 2. Local Project Download Sync & File Intelligence
- **`chrome_download_file`**: Download any HTTP/HTTPS URL, `blob:`/`data:` export, authenticated endpoint, or clicked download button directly into a target `projectDir` / `savePath` with SHA-256 verification, atomic cross-drive transfer, `.chrome-downloads.json` manifest tracking, and optional `readPreview: true`.
- **`chrome_track_downloads`**: `list` live Chrome + project downloads, `wait` for completion, `sync_to_project`, `watch_project` (auto-mirror all new Chrome downloads into a project folder), or `read_file` (native JSON, CSV, PDF text, image dimensions, ZIP directory listing, and UTF-8 text parsing).

## 3. Cooperative Multi-Agent Swarms & Parallel Execution
- **`chrome_swarm_plan`**: Plan & execute a multi-agent DAG mission with explicit roles & responsibilities (`planner`, `researcher`, `operator`, `downloader`, `auditor`, `custom`), 3-color DFS cycle checks, Critical-Path priority scheduling, template data handoffs (`{{tasks.<id>.result.<field>}}` / `{{blackboard.<key>}}`), and color-coded Chrome Tab Groups.
- **`chrome_swarm_blackboard`**: Shared mission memory & inter-agent handoff bus (`put`, `get`, `list`, `post_message`, `read_messages`, `claim_task`, `complete_task`).
- **`chrome_agent_session`**: Claim/spawn isolated agent tabs with Per-Tab Fair RWLocks and per-agent `projectDir` binding.
- **`chrome_parallel_run`**: Bounded parallel fan-out (1..12 concurrent workers) across multiple tabs/URLs.

## 4. Safety Rules
- Never enter passwords, 2FA/OTP codes, or payment details; never bypass CAPTCHAs.
- Always clean up temporary tabs/sessions when done and avoid stealing the user's active tab focus.
