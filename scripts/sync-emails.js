#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = require('fs');
const { join } = require('path');
const { homedir, tmpdir } = require('os');
const Anthropic = require('@anthropic-ai/sdk');

const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_DIR   = join(homedir(), '.job-search-sync');
const STATE_PATH  = join(STATE_DIR, 'state.json');

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
  if (state.processedIds.length > 5000) state.processedIds = state.processedIds.slice(-2000);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

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

async function fetchJobRecords(apiUrl) {
  const resp = await fetch(apiUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'GET failed');
  return (data.rows || []).filter(r => r.id !== '__email_sync_status__');
}

async function postRecord(apiUrl, action, payload) {
  await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
}

async function upsertSyncStatus(apiUrl, summary) {
  const today = new Date().toISOString().split('T')[0];
  const record = { id: '__email_sync_status__', status: 'sync', position: today, company: summary };
  try {
    await postRecord(apiUrl, 'update', { record });
  } catch (_) {
    await postRecord(apiUrl, 'add', { record });
  }
}

async function analyzeEmail(client, email, jobRecords) {
  const jobList = jobRecords.length
    ? jobRecords.map(j => `  [${j.id}] ${j.company || '?'} | ${j.position || '?'} | ${j.status}`).join('\n')
    : '  (none yet)';

  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You help maintain a job application tracker. Respond ONLY with valid JSON.\n\nCurrent job applications:\n${jobList}\n\nEmail:\nSubject: ${email.subject}\nFrom: ${email.sender}\nDate: ${email.date}\nBody:\n${email.body.slice(0, 3000)}\n\nRespond with:\n{\n  "is_job_related": true/false,\n  "action": "update"|"create"|"ignore",\n  "matched_id": "<id or null>",\n  "status": "pending|sent|interview|offer|rejected|dropped or null",\n  "company": "<name>",\n  "position": "<title>",\n  "notes": "<one sentence summary>"\n}\n\nOnly true for interview invites, rejections, offers, HR follow-ups. Not newsletters or job alerts.`
    }]
  });

  try {
    const text = msg.content[0].text.trim();
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  } catch (_) {
    return { is_job_related: false };
  }
}

async function main() {
  const config = loadConfig();
  const state  = loadState();

  const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
  if (!apiKey) { console.error('[sync] Set ANTHROPIC_API_KEY env var or anthropicApiKey in config.json.'); process.exit(1); }
  if (!config.apiUrl || config.apiUrl.includes('YOUR_SCRIPT_ID')) { console.error('[sync] Set apiUrl in scripts/config.json.'); process.exit(1); }

  const client   = new Anthropic({ apiKey });
  const mailbox  = config.mailbox  || 'INBOX';
  const daysBack = config.daysBack || 14;

  console.log('[sync] Fetching job records from Google Sheets…');
  const jobRecords = await fetchJobRecords(config.apiUrl);
  console.log(`[sync] ${jobRecords.length} existing records.`);

  console.log(`[sync] Reading Apple Mail — "${mailbox}", last ${daysBack} days…`);
  const emails    = getRecentEmails(mailbox, daysBack);
  const newEmails = emails.filter(e => !state.processedIds.includes(e.id));
  console.log(`[sync] ${emails.length} emails, ${newEmails.length} unprocessed.`);

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
          await postRecord(config.apiUrl, 'update', { record: { ...existing, status: analysis.status } });
          console.log(`     Updated [${existing.id}] ${existing.company} | ${existing.position} → ${analysis.status}`);
          existing.status = analysis.status;
          updated++;
        } else { skipped++; }
      } else if (analysis.action === 'create' && analysis.company) {
        await postRecord(config.apiUrl, 'add', {
          record: { company: analysis.company, position: analysis.position || '', status: analysis.status || 'sent', applied: new Date().toISOString().split('T')[0] }
        });
        console.log(`     Created: ${analysis.company} | ${analysis.position}`);
        created++;
      } else { skipped++; }

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

  try { await upsertSyncStatus(config.apiUrl, summary); } catch (_) {}
}

main().catch(err => { console.error('[sync] Fatal:', err.message); process.exit(1); });
