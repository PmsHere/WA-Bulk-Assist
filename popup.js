// popup.js — collects settings, kicks off the queue, and mirrors live state
// from chrome.storage.local so the popup stays in sync even if it was closed
// mid-run (the background service worker is the actual source of truth).

const els = {
  numbers: document.getElementById("numbers"),
  country: document.getElementById("country"),
  customCode: document.getElementById("customCode"),
  timer: document.getElementById("timer"),
  timerLabel: document.getElementById("timerLabel"),
  dailyCapEnabled: document.getElementById("dailyCapEnabled"),
  dailyCap: document.getElementById("dailyCap"),
  startBtn: document.getElementById("startBtn"),
  statusBox: document.getElementById("statusBox"),
  statusTitle: document.getElementById("statusTitle"),
  progressFill: document.getElementById("progressFill"),
  currentNumber: document.getElementById("currentNumber"),
  statAttempted: document.getElementById("statAttempted"),
  statSuccess: document.getElementById("statSuccess"),
  statFailed: document.getElementById("statFailed"),
  pauseBtn: document.getElementById("pauseBtn"),
  stopBtn: document.getElementById("stopBtn"),
  summaryBox: document.getElementById("summaryBox"),
  summaryHeadline: document.getElementById("summaryHeadline"),
  summaryDetail: document.getElementById("summaryDetail"),
};

function fmtMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

els.timer.addEventListener("input", () => {
  els.timerLabel.textContent = fmtMMSS(Number(els.timer.value));
});

els.country.addEventListener("change", () => {
  els.customCode.disabled = els.country.value !== "custom";
});

// ---------- Number parsing ----------
function parseNumbers(raw, countryMode, customCode) {
  const parts = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const dialCode =
    countryMode === "multi" ? null : countryMode === "custom" ? customCode.trim() : countryMode;

  const seen = new Set();
  const out = [];

  for (const part of parts) {
    // Strip everything except digits and a leading +
    let cleaned = part.replace(/[^\d+]/g, "");
    let hasPlus = cleaned.startsWith("+");
    let digits = cleaned.replace(/\+/g, "");

    if (!digits) continue;

    if (dialCode) {
      // If it doesn't already start with the selected country's dial code, prepend it.
      if (!digits.startsWith(dialCode)) {
        digits = dialCode + digits;
      }
    }
    // In "multi" mode we trust the user typed the full international number.

    if (digits.length < 8) continue; // too short to be a real international number

    if (!seen.has(digits)) {
      seen.add(digits);
      out.push(digits);
    }
  }
  return out;
}

// ---------- Start ----------
els.startBtn.addEventListener("click", () => {
  const countryMode = els.country.value;
  if (countryMode === "custom" && !els.customCode.value.trim()) {
    alert("Enter a custom country code, or pick a listed country.");
    return;
  }

  const numbers = parseNumbers(els.numbers.value, countryMode, els.customCode.value);
  if (numbers.length === 0) {
    alert("No valid numbers found. Check your input.");
    return;
  }

  const delaySeconds = Number(els.timer.value);
  const dailyCap = els.dailyCapEnabled.checked ? Math.max(1, Number(els.dailyCap.value) || 40) : null;

  chrome.runtime.sendMessage(
    {
      type: "START_QUEUE",
      payload: { numbers, delaySeconds, dailyCap },
    },
    (resp) => {
      if (resp && resp.ok) {
        renderState(resp.state);
      } else if (resp && resp.error) {
        alert(resp.error);
      }
    }
  );
});

els.pauseBtn.addEventListener("click", () => {
  const action = els.pauseBtn.dataset.paused === "1" ? "RESUME_QUEUE" : "PAUSE_QUEUE";
  chrome.runtime.sendMessage({ type: action }, (resp) => resp && resp.state && renderState(resp.state));
});

els.stopBtn.addEventListener("click", () => {
  if (!confirm("Stop the automation now? Progress so far will be kept in the summary.")) return;
  chrome.runtime.sendMessage({ type: "STOP_QUEUE" }, (resp) => resp && resp.state && renderState(resp.state));
});

// ---------- Live status rendering ----------
function renderState(state) {
  if (!state || !state.isRunning) {
    els.statusBox.classList.remove("show");
    els.startBtn.disabled = false;
    if (state && state.finishedAt) {
      renderSummary(state);
    }
    return;
  }

  els.startBtn.disabled = true;
  els.statusBox.classList.add("show");
  els.summaryBox.classList.remove("show");

  els.pauseBtn.dataset.paused = state.isPaused ? "1" : "0";
  els.pauseBtn.textContent = state.isPaused ? "Resume" : "Pause";
  els.statusTitle.textContent = state.isPaused ? "Paused" : "Running…";

  const { queue, index, stats } = state;
  const pct = queue.length ? Math.min(100, Math.round((index / queue.length) * 100)) : 0;
  els.progressFill.style.width = pct + "%";
  const cur = queue[index];
  els.currentNumber.textContent = cur
    ? `Current: +${cur.number} (${index + 1} of ${queue.length})`
    : "";

  els.statAttempted.textContent = stats.totalAttempted;
  els.statSuccess.textContent = stats.successfulOpens;
  els.statFailed.textContent = stats.failedOpens;
}

function renderSummary(state) {
  els.summaryBox.classList.add("show");
  const { stats, queue, stoppedEarly } = state;
  els.summaryHeadline.textContent = stoppedEarly
    ? "Automation stopped early"
    : "Automation finished";
  els.summaryDetail.textContent =
    `Processed ${stats.totalAttempted} of ${queue.length} numbers — ` +
    `${stats.successfulOpens} opened successfully, ${stats.failedOpens} failed.`;
}

// Pull current state on popup open, then poll while visible so numbers stay live.
function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
    if (resp && resp.state) renderState(resp.state);
  });
}
refresh();
const pollId = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(pollId));
