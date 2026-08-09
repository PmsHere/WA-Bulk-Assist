# WA Bulk Assist (Manual Send)

Chrome extension (Manifest V3) that queues WhatsApp Web chats one at a time,
auto-opens each contact's info panel for verification, and waits on a
countdown before moving to the next chat. **Message sending is always
manual** — the extension never types or clicks Send for you.

## Install (unpacked, for development)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension, open `web.whatsapp.com`, log in, then open the popup

## How it works

- **popup.js** parses your number list, sends `START_QUEUE` to the background
  worker, which creates the tab and initializes state in
  `chrome.storage.local`.
- **content.js** is *self-driving*: it reads and writes
  `chrome.storage.local` directly (no message round-trip needed — content
  scripts have the same storage access as the background worker) and decides
  what to do on **every** page load, including ones it didn't cause itself
  (Brave discarding the tab, a crash, a manual refresh). It always persists
  the advanced queue index to storage *before* attempting any navigation, so
  a crash mid-navigation still leaves storage pointing at the right place.
  Each chat gets exactly one 30-second readiness window (via
  `MutationObserver`, with a short poll as a fallback) — on success or
  timeout it records a result and moves on. There is no retry loop.
- **background.js** is a supervisor, not a courier. It no longer tries to
  actively push "open the next chat" to the content script — that was the
  fragile link, since a message to a discarded/suspended tab can silently
  fail to arrive. Instead a periodic watchdog alarm (`chrome.alarms`, every
  ~1 minute) checks timestamps in storage and force-recovers via a real
  reload *only if* the content script hasn't made progress within a grace
  window. This is what guarantees the run can never permanently stall.
  Pause/Resume/Stop/Skip are still handled here via normal messaging from
  the popup, since popup → background messaging is always reliable (the
  service worker wakes for any registered listener) — it was specifically
  background → content-script-in-a-possibly-dead-tab messaging that caused
  the earlier stalling bug.

## Selector maintenance

WhatsApp Web's DOM/class names rotate often. Every DOM-specific selector is
centralized in the `SELECTORS` object at the top of `content.js`, using
role/aria/data-testid based strategies with fallbacks rather than hashed
class names where possible. If WhatsApp changes their markup and the
contact-info auto-click or load-detection stops working, that's the only
place you should need to edit — check the browser console on
`web.whatsapp.com` for a `[WA Bulk Assist]` warning when it fails.

## Known limitations

- **Chrome's alarm API has a ~1 minute minimum.** This is now only used for
  the watchdog safety net (recovery detection latency, worst case), not for
  the normal per-chat timer, which is driven by a local `setTimeout` in
  content.js while the tab is alive.
- **One 30-second attempt per number, no retries.** If a chat doesn't
  become ready within 30 seconds, it's marked failed and the queue moves on
  immediately — this is intentional (see your issue report) rather than a
  multi-attempt retry loop that could itself stall.
- A **±15% random jitter** is applied to every delay automatically so the
  interval isn't a robotic fixed pattern.
- A **daily/run cap** (default 40, editable) stops the run automatically —
  keep this conservative, especially on non-Business or newer numbers.
- The in-page SPA chat-switch is best-effort (relies on WhatsApp
  intercepting a same-origin link click, which isn't a documented API). If
  it doesn't work on a given WhatsApp Web version, the browser just
  performs its normal navigation instead — content.js's auto-resume logic
  picks that up cleanly on the resulting page load, so this degrades
  gracefully rather than breaking the run.

## A note on account risk

This tool automates *navigation and profile verification only* — every
message is still typed and sent by a human. That said, WhatsApp's Terms of
Service prohibit unauthorized bulk/automated messaging tools generally, and
sequential automated chat-opening at volume is a pattern WhatsApp can flag
even without an automated Send. Practical mitigations already built in:
jitter on delays, a run cap, and always-visible pause/skip/abort controls.
Beyond that: use a secondary/Business number rather than your primary
personal number, and keep run sizes modest.
