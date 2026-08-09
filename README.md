# WA Bulk Assist

A Chrome extension (Manifest V3) that assists with **manual, human-in-the-loop** bulk messaging workflows on WhatsApp Web — built to reduce the repetitive clicking of sending the same message to many chats one by one.

> ⚠️ **Disclaimer:** This tool automates UI interactions on WhatsApp Web on your own logged-in browser session — it does **not** use any private/undocumented WhatsApp API. WhatsApp's Terms of Service restrict automated or bulk messaging, and use of tools like this may put your account at risk of being flagged or banned. This project is provided for **educational and personal productivity purposes only**. You are solely responsible for how you use it and for complying with WhatsApp's Terms of Service and applicable spam/messaging laws (e.g. TRAI/DND regulations in India, GDPR/CAN-SPAM elsewhere) in your jurisdiction. The author(s) accept no liability for account bans, data loss, or misuse.

## Features

- Sends a message to a list of chats/contacts sequentially, with configurable delays between sends
- "Skip" logic to move past chats that fail to load or match
- Watchdog (`background.js`) that monitors the content script and recovers from stuck/discarded tabs
- Manual-send mode — you stay in control and can pause/stop at any time (this is not a fire-and-forget spam bot)

## How it works

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 config — permissions, content scripts, background service worker |
| `content.js` | Injected into WhatsApp Web; drives navigation between chats and message sending |
| `background.js` | Service worker; watchdog that keeps the automation alive and recovers from tab-discard/navigation failures |
| `popup.html` / `popup.js` | Extension popup UI — start/stop controls, contact list input, delay settings |
| `overlay.css` | Styling for the on-page status overlay shown while the automation runs |

## Installation (unpacked / developer mode)

1. Clone or download this repository.
2. Open Chrome (or any Chromium-based browser) and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this repository's folder.
5. Open [web.whatsapp.com](https://web.whatsapp.com), log in, and open the extension popup to configure your run.

> Note: on Brave, some tab-discard behavior differs from stock Chrome — see `background.js` for the watchdog logic that handles this.

## Usage

1. Open WhatsApp Web and make sure it's fully loaded.
2. Click the extension icon and enter your recipient list and message.
3. Set a delay between sends (recommended: several seconds, to mimic natural usage and reduce risk to your account).
4. Start the run and monitor the on-page overlay. You can stop at any time.

## Known limitations

- Relies on WhatsApp Web's DOM structure, so UI changes on WhatsApp's end can break selectors — this is inherent to any unofficial browser-automation tool, not just this one.
- Not a headless/background spam tool — it needs an active, logged-in WhatsApp Web tab.

## Contributing

Issues and pull requests are welcome. Please open an issue first to discuss significant changes.

## License

This project is licensed under the [MIT License](LICENSE).
