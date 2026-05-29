#!/usr/bin/env node
/**
 * Job Search Email Sync
 * ---------------------
 * Reads Apple Mail for job-related emails, classifies them with Claude,
 * and updates your Google Sheets tracker via the Apps Script API.
 *
 * Run manually:   node scripts/sync-emails.js
 * Auto-sync:      install the LaunchAgent (see setup.sh)
 *
 * Required env:   ANTHROPIC_API_KEY
 * Config file:    scripts/config.json  (copy from config.example.json)
 */

'use strict';

const { execSync } = require('child_process');
const { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = require('fs');
const { join } = require('path');
const { homedir, tmpdir } = require('os');
const Anthropic = require('@anthropic-ai/sdk');

// ── Paths ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_DIR   = join(homedir(), '.job-search-sync');
const STATE_PATH  = join(STATE_DIR, 'state.json');

// ── Config / state ────────────────────────────────────────────────────────────
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('[sync] Missing scripts/config.json — copy config.example.json and fill in your values.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function loadState() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_PATH)) return { processedIds: [], lastSync: null };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch (_) { return { processedIds: [], lastSync: null }; }
}

function saveState(state) {
  // Cap processed IDs so the state file doesn't grow without bound
  if (state.processedIds.length > 5000) {
    state.processedIds = state.processedIds.slice(-2000);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── AppleScript helpers ───────────────────────────────────────────────────────
function runScript(appleScript) {
  const tmp = join(tmpdir(), `sync-mail-${Date.now()}.scpt`);
  writeFileSync(tmp, appleScript, 'utf8');
  try {
    return execSync(`osascript ${tmp}`, { encoding: 'utf8', timeout: 60000 }).trim();
  } finally {
    try { unlinkSync(tmp); } catch (_) {}
  }
}

function getRecentEmails(mailbox, daysBack) {
  const mb = mailbox.replace(/"/g, '\\"');
  const raw = runScript(`
tell application "Mail"
  set cutoff to (current date) - ${daysBack} * days
  try
    set mb to mailbox "${mb}"
  on error
    set mb to mailbox "INBOX"
  end try
  set out to ""
  repeat with msg in (messages of mb)
    if date received of msg >= cutoff then
      set out to out & (message id of msg) & "|||" & (subject of msg) & "|||" & (sender of msg) & "|||" & ((date received of msg) as string) & "\n"
    end if
  end repeat
  return out
end tell`);

  if (!raw || raw.startsWith('ERROR') || raw.startsWith('(')) return [];
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [id, subject, sender, date] = line.split('|||');
    return { id: id?.trim(), subject: subject?.trim(), sender: sender?.trim(), date: date?.trim() };
  }).filter(e => e.id);
}

function getEmailBody(messageId, mailbox) {
  const mb  = mailbox.replace(/"/g, '\\"');
  const mid = messageId.replace(/"/g, '\\"');
  const result = runScript(`
tell application "Mail"
  try
    set mb to mailbox "${mb}"
  on error
    set mb to mailbox "INBOX"
  end try
  repeat with msg in (messages of mb)
    if (message id of msg) is "${mid}" then
      return content of msg
    end if
  end repeat
  return ""
end tell`);
  return result || '';
}

// ── Google Sheets / Apps Script API ──────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  return resp;
}

async function fetchJobRecords(apiUrl) {
  const resp = await apiFetch(apiUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'GET failed');
  // Filter out the internal sync-status row from the real records
  return (data.rows || []).filter(r => r.id !== '__email_sync_status__');
}

async function postRecord(apiUrl, action, payload) {
  await apiFetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
}

async function upsertSyncStatus(apiUrl, summary) {
  // We keep one special row with id="__email_sync_status__" for the UI to read.
  // Try update first; if it fails (row doesn't exist) fall back to add.
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD only
  const record = { id: '__email_sync_status__', status: 'sync', position: today, company: summary };
  try {
    await postRecord(apiUrl, 'update', { record });
  } catch (_) {
    await postRecord(apiUrl, 'add', { record });
  }
}

// ── Claude email analysis ─────────────────────────────────────────────────────
async function analyzeEmail(client, email, jobRecords) {
  const jobList = jobRecords.length
    ? jobRecords.map(j => `  [${j.id}] ${j.company || '?'} | ${j.position || '?'} | ${j.status}`).join('\n')
    : '  (none yet)';

  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You help maintain a job application tracker. Respond ONLY with valid JSON — no prose.

Current job applications:
${jobList}

Email to analyze:
Subject: ${email.subject}
From: ${email.sender}
Date: ${email.date}
Body:
${email.body.slice(0, 3000)}

Rules:
- If this email is about a specific job application (interview invite, rejection, offer, follow-up from HR/recruiter), set is_job_related: true.
- Newsletters, job-alert digests, LinkedIn notifications, and marketing emails → is_job_related: false.
- For "update": find the best-matching existing record by company + position and return its id as matched_id.
- For "create": this is a new application not yet in the tracker.
- "status" must be one of: pending | sent | interview | offer | rejected | dropped

Respond with exactly this shape:
{
  "is_job_related": true or false,
  "action": "update" | "create" | "ignore",
  "matched_id": "<id string or null>",
  "status": "<status string or null>",
  "company": "<company name — required for create>",
  "position": "<job title — required for create>",
  "notes": "<one sentence: what did this email say?>"
}`
    }]
  });

  try {
    const text = msg.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (_) {
    return { is_job_related: false };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const state  = loadState();

  const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
  if (!apiKey) {
    console.error('[sync] Set ANTHROPIC_API_KEY env var or anthropicApiKey in config.json.');
    process.exit(1);
  }
  if (!config.apiUrl || config.apiUrl.includes('YOUR_SCRIPT_ID')) {
    console.error('[sync] Set apiUrl in scripts/config.json to your Google Apps Script URL.');
    process.exit(1);
  }

  const client   = new Anthropic({ apiKey });
  const mailbox  = config.mailbox  || 'INBOX';
  const daysBack = config.daysBack || 14;

  console.log('[sync] Fetching existing job records from Google Sheets…');
  const jobRecords = await fetchJobRecords(config.apiUrl);
  console.log(`[sync] ${jobRecords.length} existing records.`);

  console.log(`[sync] Reading Apple Mail — "${mailbox}", last ${daysBack} days…`);
  const emails    = getRecentEmails(mailbox, daysBack);
  const newEmails = emails.filter(e => !state.processedIds.includes(e.id));
  console.log(`[sync] ${emails.length} emails found, ${newEmails.length} not yet processed.`);

  let updated = 0, created = 0, skipped = 0, errors = 0;

  for (const email of newEmails) {
    console.log(`[sync] → "${email.subject}" — ${email.sender}`);
    try {
      email.body = getEmailBody(email.id, mailbox);
      const analysis = await analyzeEmail(client, email, jobRecords);

      if (!analysis.is_job_related) {
        skipped++;
      } else if (analysis.action === 'update' && analysis.matched_id) {
        const existing = jobRecords.find(j => j.id === analysis.matched_id);
        if (existing && analysis.status) {
          await postRecord(config.apiUrl, 'update', {
            record: { ...existing, status: analysis.status }
          });
          console.log(`     Updated [${existing.id}] ${existing.company} | ${existing.position} → ${analysis.status}`);
          // Refresh local cache so later emails see the updated status
          existing.status = analysis.status;
          updated++;
        } else {
          skipped++;
        }
      } else if (analysis.action === 'create' && analysis.company) {
        await postRecord(config.apiUrl, 'add', {
          record: {
            company:  analysis.company,
            position: analysis.position || '',
            status:   analysis.status || 'sent',
            applied:  new Date().toISOString().split('T')[0]
          }
        });
        console.log(`     Created: ${analysis.company} | ${analysis.position} (${analysis.status})`);
        created++;
      } else {
        skipped++;
      }

      state.processedIds.push(email.id);
    } catch (err) {
      console.error(`     Error: ${err.message}`);
      errors++;
    }
  }

  state.lastSync = new Date().toISOString();
  saveState(state);

  const summary = `Updated:${updated} Created:${created} Skipped:${skipped} Errors:${errors}`;
  console.log(`\n[sync] ${summary}`);
  console.log(`[sync] State saved to ${STATE_PATH}`);

  // Write sync status back to Google Sheets so the web UI can show it
  try {
    await upsertSyncStatus(config.apiUrl, summary);
  } catch (_) { /* non-fatal */ }
}

main().catch(err => {
  console.error('[sync] Fatal:', err.message);
  process.exit(1);
});
