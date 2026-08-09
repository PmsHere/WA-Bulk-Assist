// content.js — runs on web.whatsapp.com. This script is now "self-driving":
// it reads/writes chrome.storage.local directly (content scripts have the
// same storage access as background.js — no message round-trip needed) and
// decides what to do on EVERY page load, including ones it didn't cause
// itself (Brave discarding the tab, a crash, a manual refresh). That's what
// makes the queue resume correctly no matter what interrupted it.
//
// STATE MACHINE (stored in chrome.storage.local under "waState")
// ─────────────────────────────────────────────────────────────────────────
// phase: "loading" → we're waiting (max 30s) for queue[index]'s chat to
//         become ready. On success or on 30s timeout, we record a result
//         and move to phase "waiting". There is no retry loop — one number
//         gets exactly one 30-second window, then it's marked and we move on.
// phase: "waiting" → chat already processed; currentEndTime says when to
//         open the next number. A local setTimeout drives this while the
//         page is alive; if the page dies, background.js's watchdog alarm
//         notices (via timestamps in storage) and forces recovery.
//
// Every "index" advance is written to storage BEFORE any navigation is
// attempted, per the resilience requirement — so even if the tab dies mid-
// navigation, storage already reflects the correct next step.
//
// NAVIGATION: the very first chat of a run is a real navigation (background
// creates the tab with a /send?phone= URL — unavoidable bootstrap). Every
// later switch is attempted via a hidden in-page link's native .click()
// (a trusted activation — see dispatchInternalChatLink()'s own comment for
// why that specific detail matters) that WhatsApp's own SPA router may
// intercept without a reload (best-effort, not a documented API). If it
// isn't intercepted, the browser just performs its normal navigation to
// that same URL — this script re-runs fresh on the resulting page load and
// picks up exactly where storage says to, so nothing breaks either way.
// ─────────────────────────────────────────────────────────────────────────
//
// SELECTOR MAINTENANCE: WhatsApp Web's class names rotate often and are NOT
// stable. Everything DOM-specific lives in SELECTORS below. Each entry is
// an ordered list of strategies tried in sequence.
// ─────────────────────────────────────────────────────────────────────────
const SELECTORS = {
  chatLoadedIndicators: [
    '[data-testid="conversation-panel-wrapper"]',
    '[data-testid="conversation-compose-box-input"]',
    "footer [contenteditable='true']",
    "#main header",
  ],
  chatTitleIndicators: [
    '[data-testid="conversation-info-header-chat-title"]',
    "#main header span[title]",
    "#main header span[dir='auto']",
  ],
  headerClickTargets: [
    '[data-testid="conversation-header"] [role="button"]',
    "#main header [role='button']",
    "#main header span[dir='auto']",
    "#main header img",
  ],
  contactInfoPanelIndicators: [
    '[data-testid="drawer-right"]',
    'div[aria-label="Contact info"]',
    'section[data-testid="contact-info-drawer"]',
  ],
  invalidNumberIndicators: {
    dialogSelectors: ['[role="dialog"]', '[data-animate-modal-popup="true"]', ".popup-contents"],
    textNeedles: ["phone number shared via url is invalid", "invalid", "not on whatsapp"],
  },
  invalidDialogOkButton: ['[role="dialog"] button', ".popup-contents button", "button"],
};

const STATE_KEY = "waState";
const LOAD_TIMEOUT_MS = 30000; // hard cap — one attempt, then mark & move on
const CONTACT_PANEL_TIMEOUT_MS = 4000;
const OBSERVER_POLL_FALLBACK_MS = 500; // belt-and-suspenders alongside MutationObserver
const SUCCESS_GRACE_MS = 2000; // accept "ready" even without a title change after this long

// ---------- storage helpers (direct access, no messaging) ----------
async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || null;
}
async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}
async function updateState(mutator) {
  const s = await getState();
  if (!s) return null;
  mutator(s);
  await setState(s);
  return s;
}

function buildUrl(number) {
  return `https://web.whatsapp.com/send?phone=${number}`;
}
function withJitterSeconds(seconds) {
  const jitter = seconds * 0.15;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(20, Math.round(seconds + delta));
}
function isUrlForNumber(number) {
  return location.href.includes(`phone=${number}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- DOM helpers ----------
function qs(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (e) {
      /* selector unsupported on this WA version — skip */
    }
  }
  return null;
}
function getChatTitleText() {
  const el = qs(SELECTORS.chatTitleIndicators);
  return el ? (el.textContent || "").trim() : null;
}
function findInvalidNumberDialog() {
  const { dialogSelectors, textNeedles } = SELECTORS.invalidNumberIndicators;
  for (const sel of dialogSelectors) {
    for (const node of document.querySelectorAll(sel)) {
      const text = (node.textContent || "").toLowerCase();
      if (textNeedles.some((needle) => text.includes(needle))) return node;
    }
  }
  return null;
}
function dismissInvalidDialog(dialogEl) {
  const btn = qs(SELECTORS.invalidDialogOkButton, dialogEl) || qs(SELECTORS.invalidDialogOkButton);
  if (btn) btn.click();
}
function tryClickContactInfo() {
  const target = qs(SELECTORS.headerClickTargets);
  if (target) {
    target.click();
    return true;
  }
  return false;
}
async function waitForContactInfoPanel() {
  const start = Date.now();
  while (Date.now() - start < CONTACT_PANEL_TIMEOUT_MS) {
    if (qs(SELECTORS.contactInfoPanelIndicators)) return true;
    await sleep(OBSERVER_POLL_FALLBACK_MS);
  }
  return false;
}
async function finalizeSuccessfulLoad() {
  const clicked = tryClickContactInfo();
  if (!clicked) {
    console.warn(
      "[WA Bulk Assist] Could not find the contact-info click target. " +
        "Update SELECTORS.headerClickTargets in content.js if WhatsApp's DOM changed."
    );
    return;
  }
  const opened = await waitForContactInfoPanel();
  if (!opened) {
    console.warn(
      "[WA Bulk Assist] Contact info panel didn't confirm open within " +
        CONTACT_PANEL_TIMEOUT_MS +
        "ms — proceeding anyway. Update SELECTORS.contactInfoPanelIndicators if this persists."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DOM-ready guard: MutationObserver-based, single 30s window, no retries.
// Resolves { success: true }, { success: false, reason }, or
// { success: null, reason: "handoff" } if a real navigation started mid-wait
// (in which case the caller must NOT record a result — the fresh page
// instance that loads next will do that).
// ─────────────────────────────────────────────────────────────────────────
function waitForChatReady(prevTitle, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();
    let observer = null;
    let poller = null;
    let hardTimer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (observer) observer.disconnect();
      if (poller) clearInterval(poller);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    }

    function check() {
      if (settled) return;

      if (document.readyState === "loading") {
        finish({ success: null, reason: "handoff" });
        return;
      }

      const invalidDialog = findInvalidNumberDialog();
      if (invalidDialog) {
        dismissInvalidDialog(invalidDialog);
        finish({ success: false, reason: "invalid_number" });
        return;
      }

      const loaded = qs(SELECTORS.chatLoadedIndicators);
      if (!loaded) return;

      const titleNow = getChatTitleText();
      const titleChanged = !prevTitle || (titleNow && titleNow !== prevTitle);
      const graceElapsed = Date.now() - start > SUCCESS_GRACE_MS;

      if (titleChanged || graceElapsed) {
        finish({ success: true });
      }
      // else: chat area is present but still shows the previous title and
      // we're within the grace window — keep waiting a little longer rather
      // than declaring success against the wrong contact.
    }

    check();
    if (settled) return;

    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    poller = setInterval(check, OBSERVER_POLL_FALLBACK_MS); // catches cases MutationObserver misses
    hardTimer = setTimeout(() => finish({ success: false, reason: "timeout" }), timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Core driver — called on every page load AND after every in-page SPA
// switch attempt. Fully derives what to do from storage, so it's safe to
// call redundantly (e.g. from a storage.onChanged reaction).
// ─────────────────────────────────────────────────────────────────────────
async function processCurrentEntry({ inPageAttempt = false, prevTitle = null } = {}) {
  const state = await getState();
  if (!state || !state.isRunning) return;

  mountOverlay();

  if (state.isPaused) {
    refreshOverlayDisplay(state);
    return;
  }

  if (state.phase === "waiting") {
    armLocalAdvanceTimer(state);
    return;
  }

  if (state.phase !== "loading") return;

  const entry = state.queue[state.index];
  if (!entry) return;

  // If this is a fresh/auto-resumed page load (not something we just
  // triggered ourselves in this same script instance) and the URL doesn't
  // match the number we're supposed to be on, force a corrective real
  // navigation. This is what makes "auto-resume" work after a Brave
  // discard, crash, or manual refresh landed on a stale URL.
  if (!inPageAttempt && !isUrlForNumber(entry.number)) {
    location.href = buildUrl(entry.number);
    return;
  }

  const result = await waitForChatReady(prevTitle, LOAD_TIMEOUT_MS);

  if (result.success === null) {
    // A real navigation started mid-wait — let the next page-load instance
    // of this script pick up reporting. Nothing to record here.
    return;
  }

  if (result.success) await finalizeSuccessfulLoad();

  const updated = await updateState((s) => {
    // Race guard: only record if this is still the entry we were waiting on.
    if (s.phase !== "loading" || s.index !== state.index) return;
    const e = s.queue[s.index];
    if (e) e.status = result.success ? "success" : "failed";
    s.stats.totalAttempted += 1;
    if (result.success) s.stats.successfulOpens += 1;
    else s.stats.failedOpens += 1;
    s.phase = "waiting";
    s.currentEndTime = Date.now() + withJitterSeconds(s.delaySeconds) * 1000;
  });

  if (updated) armLocalAdvanceTimer(updated);
}

// ─────────────────────────────────────────────────────────────────────────
// Local advance timer — fires moveToNext() at currentEndTime. Re-armed
// whenever we (re)enter the "waiting" phase or storage changes (e.g. resume
// after pause).
// ─────────────────────────────────────────────────────────────────────────
let advanceTimerId = null;

function clearLocalAdvanceTimer() {
  if (advanceTimerId) {
    clearTimeout(advanceTimerId);
    advanceTimerId = null;
  }
}

function armLocalAdvanceTimer(state) {
  clearLocalAdvanceTimer();
  if (!state.currentEndTime) return;
  const remaining = Math.max(0, state.currentEndTime - Date.now());
  advanceTimerId = setTimeout(moveToNext, remaining);
  refreshOverlayDisplay(state);
}

async function moveToNext(force = false) {
  clearLocalAdvanceTimer();

  const state = await getState();
  if (!state || !state.isRunning || state.isPaused) return;
  if (state.phase !== "waiting") return; // someone else already advanced (e.g. watchdog)
  if (!force && state.currentEndTime && Date.now() < state.currentEndTime - 250) {
    // Called early by something OTHER than an explicit skip — re-arm rather
    // than advancing prematurely. (force=true intentionally bypasses this:
    // that's the whole point of a "Skip now" button — jumping ahead of the
    // countdown, not waiting it out.)
    armLocalAdvanceTimer(state);
    return;
  }

  const nextIndex = state.index + 1;
  const capHit = state.dailyCap && state.stats.totalAttempted >= state.dailyCap;
  const queueDone = nextIndex >= state.queue.length;

  if (queueDone || capHit) {
    await updateState((s) => {
      s.isRunning = false;
      s.finishedAt = Date.now();
      s.stoppedEarly = capHit && !queueDone;
    });
    teardownOverlay();
    return;
  }

  const nextNumber = state.queue[nextIndex].number;

  // Persist the advance BEFORE attempting any navigation — this is the
  // "save currentIndex and queue before every single navigation" guarantee.
  const updated = await updateState((s) => {
    s.index = nextIndex;
    s.phase = "loading";
    s.loadDeadline = Date.now() + LOAD_TIMEOUT_MS;
  });
  if (!updated) return;

  const prevTitle = getChatTitleText();
  dispatchInternalChatLink(nextNumber);

  // Give WhatsApp's router a brief window to intercept the click. Whether
  // it did or not, processCurrentEntry() figures out the right next step —
  // if a real navigation is underway, waitForChatReady will detect that via
  // document.readyState and hand off cleanly to the fresh script instance.
  setTimeout(() => processCurrentEntry({ inPageAttempt: true, prevTitle }), 400);
}

function dispatchInternalChatLink(number) {
  const a = document.createElement("a");
  a.href = buildUrl(number);
  a.setAttribute("data-wba-internal-nav", "1");
  a.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
  document.body.appendChild(a);

  // IMPORTANT: use the native .click() method, NOT dispatchEvent(new
  // MouseEvent(...)). A dispatchEvent-created click is untrusted
  // (isTrusted: false) — untrusted clicks still fire any JS listeners bound
  // to the element/document, but browsers do NOT run the native "follow
  // this link" activation behavior for them. That means if WhatsApp doesn't
  // happen to intercept it via a JS click handler, NOTHING happens at all —
  // no interception AND no fallback navigation — which silently breaks
  // every chat switch after the first. .click() is a trusted activation and
  // is guaranteed to trigger real navigation as a fallback if not
  // intercepted.
  a.click();

  setTimeout(() => a.remove(), 0);
}


// ─────────────────────────────────────────────────────────────────────────
// Floating overlay: countdown + manual controls
// ─────────────────────────────────────────────────────────────────────────
let overlayEl = null;
let tickInterval = null;

function mountOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement("div");
  overlayEl.id = "wa-bulk-assist-overlay";
  overlayEl.innerHTML = `
    <div class="wba-row">
      <span class="wba-dot"></span>
      <span class="wba-label">Next chat in <span id="wba-countdown">--:--</span></span>
    </div>
    <div class="wba-buttons">
      <button id="wba-pause">Pause</button>
      <button id="wba-skip">Skip now</button>
      <button id="wba-abort">Abort</button>
    </div>
  `;
  document.body.appendChild(overlayEl);

  document.getElementById("wba-pause").addEventListener("click", () => {
    const isPaused = overlayEl.dataset.paused === "1";
    chrome.runtime.sendMessage({ type: isPaused ? "RESUME_QUEUE" : "PAUSE_QUEUE" });
  });
  document.getElementById("wba-skip").addEventListener("click", () => {
    // Handled in-page directly — no need to round-trip through background
    // since this script is, by definition, alive right now. force=true
    // bypasses the "called too early" guard, since jumping the countdown
    // early is exactly what this button is for.
    moveToNext(true);
  });
  document.getElementById("wba-abort").addEventListener("click", () => {
    if (confirm("Abort the automation? You can review the summary in the extension popup.")) {
      chrome.runtime.sendMessage({ type: "ABORT_FROM_OVERLAY" }, () => teardownOverlay());
    }
  });

  tickInterval = setInterval(async () => {
    const state = await getState();
    if (state) refreshOverlayDisplay(state);
  }, 1000);
}

function teardownOverlay() {
  clearLocalAdvanceTimer();
  if (tickInterval) clearInterval(tickInterval);
  if (overlayEl) overlayEl.remove();
  overlayEl = null;
}

function refreshOverlayDisplay(state) {
  if (!overlayEl || !state) return;
  if (!state.isRunning) {
    teardownOverlay();
    return;
  }

  const pauseBtn = document.getElementById("wba-pause");
  const countdownEl = document.getElementById("wba-countdown");
  overlayEl.dataset.paused = state.isPaused ? "1" : "0";
  if (pauseBtn) pauseBtn.textContent = state.isPaused ? "Resume" : "Pause";

  if (!countdownEl) return;

  if (state.isPaused) {
    countdownEl.textContent = "paused";
    return;
  }
  if (state.phase === "loading") {
    countdownEl.textContent = "opening…";
    return;
  }
  if (state.currentEndTime) {
    const remainingMs = Math.max(0, state.currentEndTime - Date.now());
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    countdownEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// React to state changes made elsewhere (popup pause/resume, background
// watchdog recovery, etc.) without needing a message round-trip.
// ─────────────────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STATE_KEY]) return;
  const newState = changes[STATE_KEY].newValue;
  if (!newState || !newState.isRunning) {
    teardownOverlay();
    return;
  }
  if (newState.isPaused) {
    clearLocalAdvanceTimer();
  } else if (newState.phase === "waiting") {
    armLocalAdvanceTimer(newState);
  }
  refreshOverlayDisplay(newState);
});

// FORCE_SKIP is the one message this script still listens for — sent by
// background.js only when the user hits "Skip" from the popup (a context
// where messaging is fine since the user is actively interacting).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FORCE_SKIP") {
    moveToNext(true);
    sendResponse({ ok: true });
    return true;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Entry point — runs on every page load, no exceptions. This single call is
// what makes auto-resume work: it doesn't matter whether this load is the
// original navigation, a watchdog-forced recovery reload, a Brave discard-
// and-reload, or a manual refresh — processCurrentEntry() figures out the
// correct action purely from what's in storage.
// ─────────────────────────────────────────────────────────────────────────
processCurrentEntry();
