// background.js — supervises the queue via chrome.storage.local as the sole
// source of truth. It no longer tries to actively push each "open the next
// chat" step to the content script over chrome.tabs.sendMessage — that was
// the fragile link: if Brave discards/suspends the WhatsApp tab, a message
// to it can silently fail to arrive, and the whole run would stall.
//
// New model:
//  - content.js is self-driving: on every page load (including reloads it
//    didn't cause itself — Brave discards, crashes, manual refresh) it reads
//    storage directly and figures out what to do. See content.js's top
//    comment for the full state machine.
//  - background.js's job is now just: (1) bootstrap the very first chat,
//    (2) run a periodic "watchdog" alarm that checks timestamps in storage
//    and force-recovers via a real chrome.tabs.update() ONLY if the content
//    script hasn't made progress within a grace window. This is the
//    guarantee that the run can never permanently stall — worst case, the
//    watchdog notices within ~1 minute and forces things forward.
//  - PAUSE/RESUME/STOP/ABORT/SKIP are still handled here since popup->
//    background messaging is always reliable (the service worker wakes for
//    any registered listener); it's only background->content messaging to a
//    possibly-dead tab that was the weak link, and we've removed the
//    dependency on that for the automatic per-number advance.

const STATE_KEY = "waState";
const WATCHDOG_ALARM = "wa_watchdog";
const WATCHDOG_PERIOD_MIN = 1; // chrome.alarms enforces a ~1 minute floor
const LOAD_TIMEOUT_MS = 30000; // must match content.js's own per-chat timeout
const WATCHDOG_GRACE_MS = 5000; // extra buffer so we don't race content.js's own timely action

function emptyStats() {
  return { totalAttempted: 0, successfulOpens: 0, failedOpens: 0 };
}

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || null;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

function buildUrl(number) {
  return `https://web.whatsapp.com/send?phone=${number}`;
}

function withJitter(seconds) {
  const jitter = seconds * 0.15;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(20, Math.round(seconds + delta));
}

function isQueueDone(state) {
  return state.index >= state.queue.length;
}

function isCapHit(state) {
  return state.dailyCap && state.stats.totalAttempted >= state.dailyCap;
}

async function markFinished(state, stoppedEarly) {
  state.isRunning = false;
  state.finishedAt = Date.now();
  state.stoppedEarly = stoppedEarly;
  await setState(state);
  chrome.alarms.clear(WATCHDOG_ALARM);
}

// ─────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────
async function startQueue(payload, sendResponse) {
  const existing = await getState();
  if (existing && existing.isRunning) {
    sendResponse({ ok: false, error: "A queue is already running. Stop it first." });
    return;
  }

  const { numbers, delaySeconds, dailyCap } = payload;
  const queue = numbers.map((n) => ({ number: n, status: "pending" }));

  const tab = await chrome.tabs.create({ url: buildUrl(queue[0].number) });

  const state = {
    queue,
    index: 0,
    delaySeconds,
    dailyCap,
    tabId: tab.id,
    isRunning: true,
    isPaused: false,
    stats: emptyStats(),
    // "loading": we're waiting (up to LOAD_TIMEOUT_MS) for queue[index]'s chat
    // to become ready. "waiting": chat was processed, counting down to the
    // next number.
    phase: "loading",
    loadDeadline: Date.now() + LOAD_TIMEOUT_MS,
    currentEndTime: null,
    pausedRemainingMs: null,
    startedAt: Date.now(),
    finishedAt: null,
    stoppedEarly: false,
  };
  await setState(state);
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  sendResponse({ ok: true, state });
}

// ─────────────────────────────────────────────────────────────────────────
// Recovery: force-advance the queue via a real navigation. Used by the
// watchdog when content.js appears to have stalled, and as a fallback for
// SKIP_NOW if the tab is unreachable.
// ─────────────────────────────────────────────────────────────────────────
async function forceAdvance(state, { markCurrentFailed }) {
  if (markCurrentFailed) {
    const cur = state.queue[state.index];
    if (cur && cur.status === "pending") {
      cur.status = "failed";
      state.stats.totalAttempted += 1;
      state.stats.failedOpens += 1;
    }
  }

  state.index += 1;

  // Persist the advanced index/queue BEFORE navigating, so a crash or
  // discard mid-navigation still leaves storage pointing at the right place.
  if (isQueueDone(state) || isCapHit(state)) {
    await markFinished(state, isCapHit(state) && !isQueueDone(state));
    return;
  }

  const nextNumber = state.queue[state.index].number;
  state.phase = "loading";
  state.loadDeadline = Date.now() + LOAD_TIMEOUT_MS;
  await setState(state);

  try {
    await chrome.tabs.update(state.tabId, { url: buildUrl(nextNumber) });
  } catch (e) {
    const tab = await chrome.tabs.create({ url: buildUrl(nextNumber) });
    state.tabId = tab.id;
    await setState(state);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Watchdog: the only thing guaranteeing forward progress if content.js's
// own self-driving logic can't run (tab discarded/crashed/closed and never
// reopened on its own).
// ─────────────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;

  const state = await getState();
  if (!state || !state.isRunning || state.isPaused) return;

  const now = Date.now();

  if (state.phase === "loading" && state.loadDeadline && now > state.loadDeadline + WATCHDOG_GRACE_MS) {
    // content.js never resolved this chat within its own 30s window (or
    // never ran at all — tab likely discarded). Mark it failed and push
    // forward via a guaranteed real navigation.
    await forceAdvance(state, { markCurrentFailed: true });
    return;
  }

  if (state.phase === "waiting" && state.currentEndTime && now > state.currentEndTime + WATCHDOG_GRACE_MS) {
    // The countdown finished but content.js didn't move on (tab presumably
    // dead) — advance without re-marking the current number, since it was
    // already recorded before entering the "waiting" phase.
    await forceAdvance(state, { markCurrentFailed: false });
  }
});

// If a run is somehow still marked active after a service worker restart
// (e.g. browser relaunch), make sure the watchdog is actually scheduled.
chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (state && state.isRunning) {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  }
});

// If the automation's tab gets closed manually, stop cleanly.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state && state.isRunning && state.tabId === tabId) {
    await markFinished(state, true);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Messages (all from popup.js or the overlay — both always-reachable
// contexts, so no reliability concerns here)
// ─────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "START_QUEUE":
        await startQueue(msg.payload, sendResponse);
        break;

      case "GET_STATE": {
        const state = await getState();
        sendResponse({ state });
        break;
      }

      case "PAUSE_QUEUE": {
        const state = await getState();
        if (state && state.isRunning && !state.isPaused) {
          const activeDeadline = state.phase === "loading" ? state.loadDeadline : state.currentEndTime;
          state.pausedRemainingMs = activeDeadline ? Math.max(1000, activeDeadline - Date.now()) : 60000;
          state.isPaused = true;
          await setState(state);
        }
        sendResponse({ state });
        break;
      }

      case "RESUME_QUEUE": {
        const state = await getState();
        if (state && state.isRunning && state.isPaused) {
          const remaining = state.pausedRemainingMs || 60000;
          if (state.phase === "loading") {
            state.loadDeadline = Date.now() + remaining;
          } else {
            state.currentEndTime = Date.now() + remaining;
          }
          state.isPaused = false;
          state.pausedRemainingMs = null;
          await setState(state);
        }
        sendResponse({ state });
        break;
      }

      case "STOP_QUEUE": {
        const state = await getState();
        if (state && state.isRunning) await markFinished(state, true);
        sendResponse({ state: await getState() });
        break;
      }

      case "ABORT_FROM_OVERLAY": {
        const state = await getState();
        if (state && state.isRunning) await markFinished(state, true);
        sendResponse({ ok: true });
        break;
      }

      case "SKIP_NOW": {
        // Best effort: ask the content script (definitely alive if the user
        // is looking at the overlay; likely alive if popup-triggered) to do
        // the fast in-page skip. If that fails, fall back to forcing it
        // from here so the button always works.
        const state = await getState();
        if (!state || !state.isRunning) {
          sendResponse({ ok: false });
          break;
        }
        try {
          await chrome.tabs.sendMessage(state.tabId, { type: "FORCE_SKIP" });
        } catch (e) {
          await forceAdvance(state, { markCurrentFailed: state.phase === "loading" });
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // keep the message channel open for the async response
});
