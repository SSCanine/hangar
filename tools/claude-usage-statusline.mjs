#!/usr/bin/env node
// Claude Code status line: shows plan usage and saves it for Hangar's title-bar meter.
// Source: the documented status line stdin JSON (rate_limits.five_hour / seven_day:
// used_percentage 0-100, resets_at epoch seconds; present for Pro/Max after the first reply).
// Writes %APPDATA%\app.hangar.desktop\claude-usage.json atomically; never reads credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'app.hangar.desktop');
const OUT = path.join(OUT_DIR, 'claude-usage.json');

function windowOf(rl, key) {
  const w = rl && rl[key];
  if (!w || typeof w.used_percentage !== 'number') return null;
  return { pct: Math.round(w.used_percentage * 10) / 10, resets_at: w.resets_at ?? null };
}

function resetLabel(epoch) {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${day} ${h}${m ? ':' + String(m).padStart(2, '0') : ''}${ampm}`;
}

function save(five, week, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
  } catch {}
  const keep = (w) => (w && (!w.resets_at || w.resets_at > now) ? w : null);
  const data = {
    five_hour: five || keep(prev.five_hour),
    seven_day: week || keep(prev.seven_day),
    updated_at: now,
    session_id: sessionId || null,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  // Every Claude session runs this status line, so on Windows the rename often hits a moment
  // when another session has claude-usage.json open (EPERM/EBUSY). It used to throw and leave
  // the temp file behind: they piled up. Retry briefly, then always clean up.
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, OUT);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {}
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let j = {};
  try {
    j = JSON.parse(raw);
  } catch {}
  const five = windowOf(j.rate_limits, 'five_hour');
  const week = windowOf(j.rate_limits, 'seven_day');
  if (five || week) {
    try {
      save(five, week, j.session_id);
    } catch {}
  }
  const parts = [];
  if (j.model && j.model.display_name) parts.push(j.model.display_name);
  if (five) parts.push(`5h ${Math.round(five.pct)}%`);
  if (week) parts.push(`week ${Math.round(week.pct)}%${week.resets_at ? ` (resets ${resetLabel(week.resets_at)})` : ''}`);
  process.stdout.write(parts.join(' · '));
});
