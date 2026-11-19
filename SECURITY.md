# Security Policy — Gemini Antigravity in Chrome

## Local-Only Architecture
- **100% Local Loopback Transport**: All traffic between Chrome and Google Antigravity IDE (v2.33+) & Gemini CLI stays strictly on `127.0.0.1:17380` via Chrome Native Messaging (`com.google.antigravity.chrome_bridge`) and a per-user 256-bit authenticated bridge token.
- **Zero External Telemetry**: Neither the Chrome extension nor the MCP stdio bridge sends browsing history, cookies, credentials, or DOM snapshots to any third-party server.
- **Built-in Human-in-the-Loop Safety Gates**:
  1. Password & login fields — automatically paused for human entry
  2. Two-factor authentication (2FA / OTP) prompts — automatically paused
  3. CAPTCHA & anti-bot challenges — never bypassed; paused for human action
  4. Payment & checkout confirmations — paused unless explicitly approved
- **Per-Domain Guardrails**: Supports `Auto` and `Ask` autonomy modes plus user-configured allowed/blocked domain lists.

## Reporting a Vulnerability
Please report security issues privately through [VionixAI Support](https://vionixai.tech/contact/).
