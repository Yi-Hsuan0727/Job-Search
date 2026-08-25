#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { execSync } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function runScript(appleScript) {
  const tmp = join(tmpdir(), `mail-mcp-${Date.now()}.scpt`);
  writeFileSync(tmp, appleScript, 'utf8');
  try {
    return execSync(`osascript ${tmp}`, { encoding: 'utf8', timeout: 30000 }).trim();
  } finally {
    try { unlinkSync(tmp); } catch (_) {}
  }
}

const server = new Server(
  { name: 'apple-mail-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_mailboxes',
      description: 'List all mailboxes / folders in Apple Mail',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'list_emails',
      description: 'List emails from a mailbox with id, subject, sender, date, and read status.',
      inputSchema: {
        type: 'object',
        properties: {
          mailbox:    { type: 'string',  description: 'Mailbox name (default: INBOX)' },
          count:      { type: 'number',  description: 'Maximum emails to return (default: 40)' },
          days_back:  { type: 'number',  description: 'Look back N days from today (default: 7)' },
          unread_only:{ type: 'boolean', description: 'If true, return only unread messages' }
        }
      }
    },
    {
      name: 'get_email_content',
      description: 'Fetch the full body of a specific email by its message ID.',
      inputSchema: {
        type: 'object',
        required: ['message_id'],
        properties: {
          message_id: { type: 'string', description: 'The message ID returned by list_emails' },
          mailbox:    { type: 'string', description: 'Mailbox containing the email (default: INBOX)' }
        }
      }
    },
    {
      name: 'search_emails',
      description: 'Search Apple Mail for emails whose subject or sender contains a keyword.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query:     { type: 'string', description: 'Keyword to search in subject and sender' },
          mailbox:   { type: 'string', description: 'Mailbox to search (default: INBOX)' },
          days_back: { type: 'number', description: 'Limit search to last N days (default: 30)' }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === 'list_mailboxes') {
      const result = runScript(`
tell application "Mail"
  set out to ""
  repeat with mb in mailboxes
    set out to out & name of mb & "\n"
  end repeat
  return out
end tell`);
      return { content: [{ type: 'text', text: result || '(no mailboxes found)' }] };
    }

    if (name === 'list_emails') {
      const mailbox  = (args.mailbox || 'INBOX').replace(/"/g, '\\"');
      const count    = Math.min(Number(args.count || 40), 200);
      const daysBack = Math.min(Number(args.days_back || 7), 90);
      const unreadFilter = args.unread_only ? 'if read status of msg is false then\n' : '';
      const unreadEnd    = args.unread_only ? 'end if\n' : '';

      const result = runScript(`
tell application "Mail"
  set cutoff to (current date) - ${daysBack} * days
  try
    set mb to mailbox "${mailbox}"
  on error
    return "ERROR: mailbox not found"
  end try
  set out to ""
  set n to 0
  repeat with msg in (messages of mb)
    if n >= ${count} then exit repeat
    if date received of msg >= cutoff then
      ${unreadFilter}set out to out & (message id of msg) & "|||" & (subject of msg) & "|||" & (sender of msg) & "|||" & ((date received of msg) as string) & "|||" & ((read status of msg) as string) & "\n"
      set n to n + 1
      ${unreadEnd}end if
  end repeat
  if n = 0 then return "(no emails found in the last ${daysBack} day(s))"
  return out
end tell`);
      return { content: [{ type: 'text', text: result }] };
    }

    if (name === 'get_email_content') {
      const msgId   = (args.message_id || '').replace(/"/g, '\\"');
      const mailbox = (args.mailbox || 'INBOX').replace(/"/g, '\\"');

      const result = runScript(`
tell application "Mail"
  try
    set mb to mailbox "${mailbox}"
  on error
    return "ERROR: mailbox not found"
  end try
  repeat with msg in (messages of mb)
    if (message id of msg) is "${msgId}" then
      return "Subject: " & (subject of msg) & "\nFrom: " & (sender of msg) & "\nDate: " & ((date received of msg) as string) & "\n\n" & (content of msg)
    end if
  end repeat
  return "ERROR: message not found"
end tell`);
      return { content: [{ type: 'text', text: result }] };
    }

    if (name === 'search_emails') {
      const query    = (args.query || '').replace(/"/g, '\\"');
      const mailbox  = (args.mailbox || 'INBOX').replace(/"/g, '\\"');
      const daysBack = Math.min(Number(args.days_back || 30), 90);

      const result = runScript(`
tell application "Mail"
  set cutoff to (current date) - ${daysBack} * days
  try
    set mb to mailbox "${mailbox}"
  on error
    return "ERROR: mailbox not found"
  end try
  set out to ""
  set n to 0
  repeat with msg in (messages of mb)
    if date received of msg >= cutoff then
      if (subject of msg) contains "${query}" or (sender of msg) contains "${query}" then
        set out to out & (message id of msg) & "|||" & (subject of msg) & "|||" & (sender of msg) & "|||" & ((date received of msg) as string) & "|||" & ((read status of msg) as string) & "\n"
        set n to n + 1
      end if
    end if
  end repeat
  if n = 0 then return "(no matching emails found)"
  return out
end tell`);
      return { content: [{ type: 'text', text: result }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[apple-mail-mcp] Server running\n');
}

main().catch((err) => {
  process.stderr.write(`[apple-mail-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
