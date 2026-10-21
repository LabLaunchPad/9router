# 9Router Non-Technical User UX & Product Architecture Specification

_Date: March 9, 2026_
_Focus: Transforming 9Router into an intuitive, accessible, and delightful AI Gateway for non-developer team members, solo creators, and product managers._

---

## Executive Summary

While 9Router excels as a high-performance developer gateway for AI CLI tools, non-technical users (product managers, operations leads, beginner coders, and team admins) face steep friction when attempting to configure providers, understand model combos, debug API keys, or interpret token savings.

To solve this, this specification outlines a comprehensive **Non-Tech Design System & UX Blueprint** built across 4 distinct non-technical user personas.

---

## 🎭 Persona Audit & UX Pain-Point Matrix

### 1. 🐣 Persona 1: Non-Tech Beginner / Solo Creator
* **Goal:** Use Claude Code or Cursor with free/cheap AI models without spending money or editing JSON config files manually.
* **Current Friction:**
  - Endpoint setting (`http://localhost:20128/v1`) and Bearer tokens are intimidating.
  - Model identifiers like `cc/claude-opus-4-7` or `kr/claude-sonnet-4.5` look like code syntax.
* **Required UX Solution:**
  - **1-Click Guided Setup Wizard:** Automatic preset selector ("Free Forever", "Pro Coding Stack", "Budget Max").
  - **Copy-and-Paste Setup Snippets:** Visual GUI cards for Cursor, Claude Code, Cline, and OpenClaw with 1-click config downloads.

---

### 2. 📊 Persona 2: Product & Operations Lead (Cost Manager)
* **Goal:** Monitor token usage, track cost savings, and prevent accidental credit overspending.
* **Current Friction:**
  - Dashboard cost numbers look like real credit card charges ("$290 Display Cost" causes panic).
  - Raw token counts ("47M prompt tokens") lack intuitive context.
* **Required UX Solution:**
  - **Savings Tracker Card:** Prominent badge clarifying: *"Total Estimated Savings: $290.00 — Actual Spent: $0.00 (Kiro Free Tier)"*.
  - **Plain-English Usage Tooltips:** Translates raw token counts into human-readable equivalence (*"Equivalent to ~150 long coding sessions"*).

---

### 3. 👥 Persona 3: Non-Developer Team Member
* **Goal:** Connect team provider accounts (OpenAI, Anthropic, Kiro, Google Vertex) without handling complex OAuth credentials or JSON service accounts.
* **Current Friction:**
  - OAuth error messages and token expiration notices are cryptic.
  - Connection statuses show technical error strings (`HTTP 401: Invalid Grant`).
* **Required UX Solution:**
  - **Visual Account Health Status Badges:** Green ("Connected & Ready"), Yellow ("Token Refreshing"), Red ("Action Needed: Reconnect").
  - **1-Click Re-Auth Flow:** Single-click "Reconnect Account" modal with step-by-step visual guidance.

---

### 4. ♿ Persona 4: Visual Clarity & Accessibility Specialist
* **Goal:** Clear visual hierarchy, high contrast, intuitive iconography, and screen-reader accessible controls.
* **Current Friction:**
  - High density of monospace text inputs and dense JSON payloads.
  - Modal dialogues lack clear primary/secondary button distinction on smaller screens.
* **Required UX Solution:**
  - **Structured Form Controls:** Friendly drop-down pickers instead of raw text inputs.
  - **Accessible Contrast & Tooltips:** Informative helper icons next to complex options (e.g., RTK Token Saver, Caveman Mode, Ponytail).

---

## 🛠️ Proposed UI Enhancements & Architecture

### A. Guided "First-Time Onboarding Wizard"
When a user launches 9Router for the first time, present a 3-step setup modal:
1. **Choose Your Goal:**
   - 🆓 *Zero-Cost AI Coding* (Connects Kiro AI & OpenCode Free)
   - 💳 *Maximize Subscriptions* (Connects Claude Code / OpenAI Codex)
   - ⚡ *Balanced High-Performance* (3-tier Combo)
2. **Auto-Generate Default Key:** Automatically copy setup configuration to clipboard.
3. **CLI Integration Selector:** One-click copy for Cursor / Claude CLI / Cline.

---

### B. Plain-English Cost & Savings Explainer Component
In `/dashboard/usage` and `/dashboard`:
* Add a prominent **"How 9Router Billing Works"** callout card:
  > **Zero Cost Guarantee:** 9Router is 100% free software. Displayed costs represent estimated savings compared to commercial API prices. You are never billed by 9Router.

---

### C. Visual Model Combo Builder
Replace manual text comma-separated model inputs in `/dashboard/combos` with a visual **Drag-and-Drop Fallback Ladder**:
* Tier 1: Primary Model (Subscription)
* Tier 2: Backup Model (Cheap)
* Tier 3: Emergency Fallback (Free)

---

## 🎯 Implementation Roadmap

1. **Phase 1 (Visual Guidance):** Add plain-English tooltips, security callouts, and savings explainers across Endpoint, Providers, and Usage pages.
2. **Phase 2 (Preset Combos):** Introduce 1-click Preset Combo templates ("Free Forever", "Coding Heavy") in the Combos dashboard.
3. **Phase 3 (CLI Integrations UI):** Enhance the CLI Tools page with visual step-by-step connection cards.
