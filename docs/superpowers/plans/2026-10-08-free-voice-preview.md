# Free Voice Flow Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-cost, browser-only voice-flow preview that demonstrates AccountPulse's generic opening, protected invoice details, office-transfer path, and generic voicemail without placing a call or contacting a speech provider.

**Architecture:** A pure module owns the fictional scripts and deterministic preferred-voice selection. A small Client Component uses the browser Speech Synthesis API, displays explicit simulated keypad controls, and is rendered on the Administrator voice-settings page regardless of Retell configuration; existing customer calling and Retell controls remain untouched.

**Tech Stack:** Node.js `>=24 <25`, pnpm `10.20.0`, TypeScript, Next.js `16.3.6`, React `19.3.0`, Vitest `4.1.2`, browser Web Speech API.

**Spec:** `docs/superpowers/specs/2026-10-06-accountpulse-voice-reminders-design.md`, supplemented by the approved 8 October 2026 zero-cost feasibility probe.

## Global Constraints

- No telephone call, SIP connection, customer lookup, external speech API request, purchase, subscription, or production deployment.
- Use fictional invoices `DEMO-1001` for `AUD 120.50` and `DEMO-1002` for `AUD 80.05` only.
- Disclose no invoice detail before the simulated option-1 action.
- The voicemail path contains no customer name, invoice number, amount, or statement that money is owed.
- Prefer an `en-AU` browser voice, then `en-NZ`, then `en-GB`, then another English voice; clearly disclose when no Australian voice is available.
- Existing Retell setup preview, manual-call enablement, Customer Live SMS/email, and all database state remain unchanged.

## Review Focus

- A browser with no Speech Synthesis API must show a usable unsupported message and must not throw.
- An empty voice list must use the device default and disclose that an Australian voice was not found.
- Invoice details must be absent from the opening and voicemail scripts.
- Selecting the transfer path must only simulate the transfer and must not navigate or initiate a call.
- Repeated actions must cancel the prior utterance before speaking the next script.

---

### Task 1: Deterministic fictional flow and voice selection

**Files:**
- Create: `apps/web/src/app/(protected)/settings/voice/free-voice-flow.ts`
- Modify: `apps/web/tests/voice-settings-view.test.tsx`

**Interfaces:**
- Produces: `freeVoicePreviewScripts`, `selectFreePreviewVoice(voices)`, and `describeFreePreviewVoice(voice)`.
- Consumes: locked `fixedVoiceCallCopy.opening` and `fixedVoiceCallCopy.voicemail` from `@bc5000/domain`.

- [x] **Step 1: Write failing tests** proving script privacy, exact fictional details, voice preference order, and device-default fallback.
- [x] **Step 2: Run** `pnpm vitest run apps/web/tests/voice-settings-view.test.tsx` and verify failure is caused by the missing module/exports.
- [x] **Step 3: Implement the pure preview module** with literal, fictional content and deterministic voice selection.
- [x] **Step 4: Run** `pnpm vitest run apps/web/tests/voice-settings-view.test.tsx`; expected PASS.
- [ ] **Step 5: Commit** with message `feat: add free voice preview flow`.

### Task 2: Browser-only interactive preview

**Files:**
- Create: `apps/web/src/app/(protected)/settings/voice/free-voice-flow-preview.tsx`
- Modify: `apps/web/src/app/(protected)/settings/voice/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/tests/voice-settings-view.test.tsx`

**Interfaces:**
- Consumes: `freeVoicePreviewScripts`, `selectFreePreviewVoice`, and `describeFreePreviewVoice` from Task 1.
- Produces: `FreeVoiceFlowPreview`, rendered unconditionally on the Administrator voice-settings page.

- [ ] **Step 1: Write a failing view test** proving the preview is labelled free/browser-only, contains simulated option 1, option 2, voicemail, and end controls, and contains no telephone-number/customer input.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/tests/voice-settings-view.test.tsx`; expected FAIL because the component does not exist.
- [ ] **Step 3: Implement the Client Component** using `window.speechSynthesis`, cancelling before each utterance, preferring the selected Australian voice, and never invoking network or telephone APIs.
- [ ] **Step 4: Render it unconditionally** on the settings page and add responsive AccountPulse-themed styling.
- [ ] **Step 5: Run** `pnpm vitest run apps/web/tests/voice-settings-view.test.tsx`; expected PASS.
- [ ] **Step 6: Run** `pnpm --filter @bc5000/web typecheck`; expected PASS.
- [ ] **Step 7: Run** `pnpm --filter @bc5000/web build`; expected PASS.
- [ ] **Step 8: Commit** with message `feat: add browser voice flow preview`.
