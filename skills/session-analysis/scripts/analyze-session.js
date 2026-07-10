#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MAX_TEXT_CHARS = 6_000;
const MAX_TEXT_LINES = 80;
const CANDIDATE_HEAD_BYTES = 256 * 1024;
const CANDIDATE_TAIL_BYTES = 64 * 1024;

function canonicalProvider(provider) {
  if (!provider || provider === 'auto') return 'auto';
  if (provider === 'claude' || provider === 'claude-code') return 'claude-code';
  if (provider === 'codex') return 'codex';
  throw new Error(`Unknown source "${provider}". Use auto, codex, or claude-code.`);
}

function detectProvider(text) {
  for (const line of String(text).split(/\r?\n/).slice(0, 100)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted'].includes(record.type)) {
      return 'codex';
    }
    if (record.message && ['user', 'assistant', 'system'].includes(record.type)) {
      return 'claude-code';
    }
  }
  throw new Error('Could not detect transcript source. Pass --source codex or --source claude-code.');
}

function coverageTemplate() {
  return {
    totalLines: 0,
    parsedRecords: 0,
    malformedLines: 0,
    unknownRecords: 0,
    unknownBlocks: 0,
    omittedReasoning: 0,
    omittedSystem: 0,
    sideBranchRecords: 0,
    recordsByType: {},
  };
}

function updateMeta(meta, record, payload = {}) {
  if (!meta.id) meta.id = payload.id || payload.session_id || record.sessionId;
  if (!meta.cwd) meta.cwd = payload.cwd || record.cwd;
  if (!meta.version) meta.version = payload.cli_version || record.version;
  if (!meta.model) meta.model = payload.model || (record.message && record.message.model);
  const timestamp = record.timestamp || payload.timestamp;
  if (!timestamp) return;
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) return;
  if (meta._startedMs == null || millis < meta._startedMs) {
    meta._startedMs = millis;
    meta.startedAt = timestamp;
  }
  if (meta._endedMs == null || millis > meta._endedMs) {
    meta._endedMs = millis;
    meta.endedAt = timestamp;
  }
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object')
      .map((block) => block.text || block.content || '')
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function resultIsError(value, explicit, depth = 0) {
  if (explicit === true) return true;
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((item) => resultIsError(item, false, depth + 1));
  if (typeof value === 'string' && /^(?:apply_patch verification failed:|invalid patch text\b|error:|failed:)/i.test(value.trimStart())) {
    return true;
  }
  const parsed = parseMaybeJson(value);
  if (parsed !== value) return resultIsError(parsed, false, depth + 1);
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.is_error === true || parsed.isError === true || parsed.success === false) return true;
  if (typeof parsed.exit_code === 'number' && parsed.exit_code !== 0) return true;
  if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) return true;
  if (['error', 'failed', 'failure'].includes(String(parsed.status || '').toLowerCase())) return true;
  return ['output', 'result', 'content', 'text', 'data']
    .some((key) => key in parsed && resultIsError(parsed[key], false, depth + 1));
}

function commandText(content) {
  const name = (content.match(/<command-name>([^<]+)<\/command-name>/) || [])[1];
  if (!name) return null;
  const args = (content.match(/<command-args>([^<]*)<\/command-args>/) || [])[1];
  return `${name}${args ? ` ${args}` : ''}`.trim();
}

function claudeInjectedText(text) {
  return /<(?:system-reminder|local-command-(?:stdout|stderr)|task-notification)>/i.test(String(text));
}

function claudeActiveNodes(records) {
  const nodes = new Map();
  let leaf;
  let lastNode;
  for (const { record } of records) {
    if (record && record.uuid) {
      nodes.set(record.uuid, record.parentUuid || null);
      lastNode = record.uuid;
    }
    if (record && record.type === 'last-prompt' && record.leafUuid) leaf = record.leafUuid;
  }
  let cursor = nodes.has(leaf) ? leaf : lastNode;
  if (!cursor) return { active: null, sideBranches: 0 };
  const active = new Set();
  while (cursor && nodes.has(cursor) && !active.has(cursor)) {
    active.add(cursor);
    cursor = nodes.get(cursor);
  }

  const activeToolIds = new Set();
  for (const { record } of records) {
    if (!record.uuid || !active.has(record.uuid)) continue;
    const content = record.message && record.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.id) activeToolIds.add(block.id);
    }
  }
  for (const { record } of records) {
    if (!record.uuid || active.has(record.uuid)) continue;
    const content = record.message && record.message.content;
    if (!Array.isArray(content)) continue;
    const isParallelResult = content.some((block) => block && block.type === 'tool_result'
      && activeToolIds.has(block.tool_use_id));
    if (isParallelResult) active.add(record.uuid);
  }
  return { active, sideBranches: Math.max(0, nodes.size - active.size) };
}

function addTextEvent(events, kind, text, record, line) {
  if (typeof text !== 'string' || !text.trim()) return;
  events.push({ kind, text, timestamp: record.timestamp, line });
}

function parseClaudeRecord(record, line, session) {
  const { events, coverage, meta } = session;
  updateMeta(meta, record);

  if (record.type === 'system') {
    coverage.omittedSystem += 1;
    return true;
  }
  if (['attachment', 'last-prompt', 'ai-title', 'mode', 'permission-mode', 'queue-operation', 'file-history-snapshot', 'agent-name'].includes(record.type)) {
    return true;
  }
  if (record.type !== 'user' && record.type !== 'assistant') return false;

  const content = record.message && record.message.content;
  if (typeof content === 'string') {
    if (record.type === 'assistant') {
      addTextEvent(events, 'assistant', content, record, line);
    } else {
      const command = commandText(content);
      if (command) addTextEvent(events, 'user', command, record, line);
      else if (claudeInjectedText(content)) coverage.omittedSystem += 1;
      else addTextEvent(events, 'user', content, record, line);
    }
    return true;
  }
  if (!Array.isArray(content)) return true;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') {
      coverage.omittedReasoning += 1;
    } else if (block.type === 'text') {
      if (record.type === 'user' && claudeInjectedText(block.text)) coverage.omittedSystem += 1;
      else addTextEvent(events, record.type, block.text, record, line);
    } else if (block.type === 'tool_use') {
      events.push({
        kind: 'tool_call', id: block.id, name: block.name || 'unknown-tool',
        input: block.input, timestamp: record.timestamp, line,
      });
    } else if (block.type === 'tool_result') {
      const output = stringifyResult(block.content);
      events.push({
        kind: 'tool_result', id: block.tool_use_id, output,
        isError: resultIsError(output, block.is_error), timestamp: record.timestamp, line,
      });
    } else {
      coverage.unknownBlocks += 1;
    }
  }
  return true;
}

function codexMessageText(payload) {
  const content = payload && payload.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && ['input_text', 'output_text', 'text'].includes(block.type))
    .map((block) => block.text)
    .filter((text) => typeof text === 'string' && text.trim());
}

function codexInjectedUserText(text) {
  return /^(?:<environment_context>|<system-reminder>|<skills_instructions>|<collaboration_mode>|<recommended_plugins>|<apps_instructions>|<plugins_instructions>|<permissions instructions>|<INSTRUCTIONS>|# AGENTS\.md instructions\b)/i
    .test(String(text).trimStart());
}

function parseCodexRecord(record, line, session, eventMessageRoles) {
  const { events, coverage, meta } = session;
  const payload = record.payload || {};
  updateMeta(meta, record, payload);

  if (record.type === 'session_meta') {
    if (!meta.id || payload.id === meta.fileId) {
      meta.id = payload.id || payload.session_id || meta.id;
      meta.cwd = payload.cwd || meta.cwd;
      meta.version = payload.cli_version || meta.version;
      meta.parentThreadId = payload.parent_thread_id || meta.parentThreadId;
    }
    return true;
  }
  if (record.type === 'turn_context') {
    meta.cwd = meta.cwd || payload.cwd;
    meta.model = meta.model || payload.model;
    coverage.omittedSystem += 1;
    return true;
  }
  if (record.type === 'response_item') {
    const type = payload.type;
    if (type === 'reasoning') {
      coverage.omittedReasoning += 1;
      return true;
    }
    if (type === 'message') {
      if (payload.role === 'system' || payload.role === 'developer') {
        coverage.omittedSystem += 1;
        return true;
      }
      if (payload.role === 'user' || payload.role === 'assistant') {
        const eventType = payload.role === 'user' ? 'user_message' : 'agent_message';
        if (eventMessageRoles.has(eventType)) return true;
        for (const text of codexMessageText(payload)) {
          if (payload.role === 'user' && codexInjectedUserText(text)) {
            coverage.omittedSystem += 1;
          } else {
            addTextEvent(events, payload.role, text, record, line);
          }
        }
        return true;
      }
      return false;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call' || type === 'web_search_call') {
      const id = payload.call_id || payload.id || `${type}:${line}`;
      events.push({
        kind: 'tool_call', id,
        name: payload.name || type.replace(/_call$/, ''),
        input: parseMaybeJson(payload.arguments != null ? payload.arguments : (payload.input != null ? payload.input : payload.action)),
        timestamp: record.timestamp, line,
      });
      if (type === 'web_search_call' && ['completed', 'success', 'failed', 'error'].includes(String(payload.status).toLowerCase())) {
        events.push({
          kind: 'tool_result', id, output: { status: payload.status },
          isError: resultIsError({ status: payload.status }), timestamp: record.timestamp, line,
        });
      }
      return true;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
      const output = payload.output != null ? payload.output : payload.result;
      events.push({
        kind: 'tool_result', id: payload.call_id || payload.id,
        output: stringifyResult(output), isError: resultIsError(output, payload.is_error),
        timestamp: record.timestamp, line,
      });
      return true;
    }
    if (type === 'agent_message') return true;
    return false;
  }
  if (record.type === 'event_msg') {
    const type = payload.type;
    if (type === 'user_message' || type === 'agent_message') {
      const role = type === 'user_message' ? 'user' : 'assistant';
      const text = payload.message || payload.text;
      addTextEvent(events, role, typeof text === 'string' ? text : stringifyResult(text), record, line);
      return true;
    }
    if (['user_message', 'agent_message', 'agent_reasoning', 'token_count', 'task_started', 'task_complete', 'patch_apply_end', 'sub_agent_activity', 'web_search_end'].includes(type)) {
      if (type === 'agent_reasoning') coverage.omittedReasoning += 1;
      return true;
    }
    if (['turn_aborted', 'context_compacted', 'thread_rolled_back'].includes(type)) {
      events.push({ kind: 'status', text: type.replaceAll('_', ' '), detail: payload, timestamp: record.timestamp, line });
      return true;
    }
    return false;
  }
  if (record.type === 'compacted') {
    events.push({ kind: 'status', text: 'context compacted', timestamp: record.timestamp, line });
    return true;
  }
  if (record.type === 'world_state' || record.type === 'inter_agent_communication_metadata') return true;
  return false;
}

function parseTranscript(text, provider = 'auto', sourceFile = '') {
  const resolvedProvider = canonicalProvider(provider) === 'auto' ? detectProvider(text) : canonicalProvider(provider);
  const coverage = coverageTemplate();
  const records = [];

  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    coverage.totalLines += 1;
    let record;
    try { record = JSON.parse(rawLine); } catch {
      coverage.malformedLines += 1;
      continue;
    }
    const type = record.type || '(missing)';
    coverage.recordsByType[type] = (coverage.recordsByType[type] || 0) + 1;
    records.push({ record, line: index + 1 });
  }

  const meta = { provider: resolvedProvider, sourceFile };
  const fileMatch = path.basename(sourceFile || '').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  if (fileMatch) meta.fileId = fileMatch[0];
  const session = { meta, events: [], coverage };

  let activeNodes = null;
  if (resolvedProvider === 'claude-code') {
    const branch = claudeActiveNodes(records);
    activeNodes = branch.active;
    coverage.sideBranchRecords = branch.sideBranches;
  }
  const eventRoles = new Set(records
    .filter(({ record }) => record.type === 'event_msg' && record.payload
      && (record.payload.type === 'user_message' || record.payload.type === 'agent_message'))
    .map(({ record }) => record.payload.type));
  for (const { record, line } of records) {
    if (activeNodes && record.uuid && !activeNodes.has(record.uuid)) continue;
    const recognized = resolvedProvider === 'claude-code'
      ? parseClaudeRecord(record, line, session)
      : parseCodexRecord(record, line, session, eventRoles);
    if (recognized) coverage.parsedRecords += 1;
    else coverage.unknownRecords += 1;
  }

  delete meta._startedMs;
  delete meta._endedMs;
  delete meta.fileId;
  return session;
}

function redactString(value) {
  return String(value)
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi,
      '-----BEGIN $1-----\n[REDACTED]\n-----END $1-----')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|cookie)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(Authorization\s*[:=]\s*)([^"\r\n]+)/gi,
      (match, prefix, secret) => /^Bearer\s+\[REDACTED\]/i.test(secret) ? match : `${prefix}[REDACTED]`)
    .replace(/\b((?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\b((?:X-)?API[-_]Key\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/(--(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|cookie|client[-_]?secret)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/(\bcurl(?:\.exe)?\b[^\r\n]*?\s(?:-u|--user)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE))\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&]+)/gi, '$1=[REDACTED]')
    .replace(/((?:"|')(?:x[-_])?(?:api[-_]?key|access[-_]?token|authorization|auth|token|secret|password|passwd|cookie|private[-_]?key|client[-_]?secret)(?:"|')\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\]\s]+)/gi, '$1"[REDACTED]"')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function sensitiveKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(?:^|[_-])(?:api[_-]?key|access[_-]?token|authorization|auth|bearer|token|secret|password|passwd|cookie|private[_-]?key|client[_-]?secret)(?:$|[_-])/i.test(normalized);
}

function redactValue(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = sensitiveKey(key) ? '[REDACTED]' : redactValue(item);
  }
  return copy;
}

function boundedText(value, redact) {
  const safe = redact ? redactValue(value) : value;
  let text = typeof safe === 'string' ? safe : JSON.stringify(safe == null ? '' : safe, null, 2);
  text = text.replace(ANSI_RE, '').replace(/\0/g, '');
  const lines = text.split('\n');
  if (lines.length > MAX_TEXT_LINES) {
    text = `${lines.slice(0, MAX_TEXT_LINES).join('\n')}\n… [${lines.length - MAX_TEXT_LINES} more lines]`;
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n… [${text.length - MAX_TEXT_CHARS} more characters]`;
  }
  return text;
}

function fence(text, language = 'text') {
  const matches = String(text).match(/`+/g) || [];
  const length = Math.max(3, ...matches.map((match) => match.length + 1));
  const marker = '`'.repeat(length);
  return `${marker}${language}\n${text}\n${marker}`;
}

function pairToolCalls(events) {
  const calls = [];
  const unmatchedResults = [];
  for (const event of events) {
    if (event.kind === 'tool_call') {
      calls.push({ ...event, result: null });
    } else if (event.kind === 'tool_result') {
      const call = [...calls].reverse().find((item) => item.id === event.id && !item.result && item.line <= event.line);
      if (call) call.result = event;
      else unmatchedResults.push(event);
    }
  }
  return { calls, unmatchedResults };
}

function inline(value) {
  return String(value == null ? '—' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;');
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function renderReport(session, options = {}) {
  const redact = options.redact !== false;
  const metaInline = (value) => inline(redact ? redactValue(String(value == null ? '—' : value)) : value);
  const { calls, unmatchedResults } = pairToolCalls(session.events);
  const failed = calls.filter((call) => call.result && call.result.isError);
  const missing = calls.filter((call) => !call.result);
  const statuses = session.events.filter((event) => event.kind === 'status');
  const conversation = session.events.filter((event) => event.kind === 'user' || event.kind === 'assistant');
  const parts = [
    '# Session analysis', '',
    `- **Provider:** ${metaInline(session.meta.provider)}`,
    `- **Session:** ${metaInline(session.meta.id)}`,
    `- **Project:** ${metaInline(session.meta.cwd)}`,
    `- **Time:** ${metaInline(session.meta.startedAt)} → ${metaInline(session.meta.endedAt)}`,
    `- **Model:** ${metaInline(session.meta.model)}`,
    `- **Version:** ${metaInline(session.meta.version)}`,
    `- **Source:** ${metaInline(session.meta.sourceFile)}`,
    `- **Redaction:** ${redact ? 'enabled' : 'disabled'}`,
    '', '## Findings', '',
    `- ${plural(failed.length, 'failed tool call')}.`,
    `- ${plural(missing.length, 'tool call')} without a recorded result.`,
    `- ${plural(unmatchedResults.length, 'tool result')} without a matching earlier call.`,
    `- ${plural(statuses.length, 'interruption, rollback, or compaction signal')}.`,
    `- ${plural(session.coverage.malformedLines, 'malformed JSONL line')} and ${plural(session.coverage.unknownRecords, 'unknown record')} skipped.`,
    `- ${plural(session.coverage.sideBranchRecords, 'Claude side-branch record')} excluded from the active branch.`,
    `- ${plural(session.coverage.omittedReasoning, 'reasoning block')} and ${plural(session.coverage.omittedSystem, 'system/context record')} intentionally omitted.`,
    '', '## Conversation', '',
  ];

  if (conversation.length === 0) parts.push('_No visible user or assistant messages were parsed._', '');
  for (const event of conversation) {
    const label = event.kind === 'user' ? 'User' : 'Assistant';
    parts.push(`### ${label} · ${inline(event.timestamp || `line ${event.line}`)}`, '', fence(boundedText(event.text, redact)), '');
  }

  parts.push('## Tool summary', '', '| Tool | Calls | Success | Failed | No result |', '| --- | ---: | ---: | ---: | ---: |');
  const stats = new Map();
  for (const call of calls) {
    const stat = stats.get(call.name) || { calls: 0, success: 0, failed: 0, missing: 0 };
    stat.calls += 1;
    if (!call.result) stat.missing += 1;
    else if (call.result.isError) stat.failed += 1;
    else stat.success += 1;
    stats.set(call.name, stat);
  }
  if (stats.size === 0) parts.push('| _(none)_ | 0 | 0 | 0 | 0 |');
  for (const [name, stat] of stats) {
    parts.push(`| ${inline(name)} | ${stat.calls} | ${stat.success} | ${stat.failed} | ${stat.missing} |`);
  }

  parts.push('', '## Tool calls', '');
  if (calls.length === 0) parts.push('_No tool calls were parsed._', '');
  for (const [index, call] of calls.entries()) {
    const marker = call.result && call.result.isError ? 'FAIL' : (call.result ? 'OK' : 'NO RESULT');
    parts.push(`### ${index + 1}. ${inline(call.name)} · ${marker}`, '', `**Call id:** ${inline(call.id)}`, '', '**Input**', '', fence(boundedText(call.input, redact), 'json'), '');
    if (call.result) parts.push('**Result**', '', fence(boundedText(call.result.output, redact)), '');
    else parts.push('**Result:** _not present in transcript_', '');
  }

  if (statuses.length) {
    parts.push('## Session signals', '');
    for (const status of statuses) parts.push(`- ${inline(status.timestamp || `line ${status.line}`)} — ${inline(status.text)}`);
    parts.push('');
  }

  parts.push(
    '## Parser coverage', '',
    '| Metric | Count |', '| --- | ---: |',
    `| Non-empty JSONL lines | ${session.coverage.totalLines} |`,
    `| Recognized records | ${session.coverage.parsedRecords} |`,
    `| Malformed lines | ${session.coverage.malformedLines} |`,
    `| Unknown records | ${session.coverage.unknownRecords} |`,
    `| Unknown content blocks | ${session.coverage.unknownBlocks} |`,
    `| Omitted reasoning blocks | ${session.coverage.omittedReasoning} |`,
    `| Omitted system/context records | ${session.coverage.omittedSystem} |`,
    `| Excluded Claude side-branch records | ${session.coverage.sideBranchRecords} |`,
    '',
    '> This deterministic report does not replay commands. Ask the invoking agent to infer goals, outcomes, root causes, and unfinished work from the evidence above.',
    '',
  );
  return parts.join('\n');
}

function walkJsonl(root) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

function candidateRecords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const headLength = Math.min(size, CANDIDATE_HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    fs.readSync(fd, head, 0, headLength, 0);
    if (size <= headLength) return head.toString('utf8').split(/\r?\n/);
    const tailLength = Math.min(size - headLength, CANDIDATE_TAIL_BYTES);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    const tailLines = tail.toString('utf8').split(/\r?\n/);
    tailLines.shift();
    return head.toString('utf8').split(/\r?\n/).concat(tailLines);
  } finally {
    fs.closeSync(fd);
  }
}

function inspectCandidate(file, provider) {
  const stat = fs.statSync(file);
  const filenameId = (path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i) || [])[0];
  let identity;
  let fallbackIdentity;
  let id;
  let cwd;
  let version;
  let transcriptUpdatedMs;
  for (const line of candidateRecords(file)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const millis = Date.parse(record.timestamp || (record.payload && record.payload.timestamp));
    if (Number.isFinite(millis)) transcriptUpdatedMs = Math.max(transcriptUpdatedMs || millis, millis);
    if (provider === 'codex' && record.type === 'session_meta') {
      const payload = record.payload || {};
      fallbackIdentity ||= payload;
      if (filenameId && (payload.id === filenameId || payload.session_id === filenameId)) identity = payload;
    } else if (provider === 'claude-code' && (record.type === 'user' || record.type === 'assistant')) {
      id ||= record.sessionId;
      cwd ||= record.cwd;
      version ||= record.version;
    }
  }
  if (provider === 'codex') {
    identity ||= fallbackIdentity || {};
    id = identity.id || identity.session_id || filenameId;
    cwd = identity.cwd;
    version = identity.cli_version;
  } else {
    id ||= filenameId || path.basename(file, '.jsonl');
  }
  return {
    provider, id, cwd, version, file, updatedMs: transcriptUpdatedMs || stat.mtimeMs,
    updatedAt: new Date(transcriptUpdatedMs || stat.mtimeMs).toISOString(),
    parentThreadId: identity && identity.parent_thread_id,
    active: provider === 'codex' && !!process.env.CODEX_THREAD_ID && id === process.env.CODEX_THREAD_ID,
  };
}

function defaultRoots() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    codex: path.join(codexHome, 'sessions'),
    'claude-code': path.join(claudeHome, 'projects'),
  };
}

function sameProject(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function claudeCurrentSessionId(project, stateFile) {
  const file = stateFile || process.env.CLAUDE_STATE_FILE || path.join(os.homedir(), '.claude.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  for (const [cwd, details] of Object.entries(state.projects || {})) {
    if (sameProject(cwd, project) && details && details.lastSessionId) return details.lastSessionId;
  }
  return null;
}

function discoverCandidates(options = {}) {
  const source = canonicalProvider(options.source || 'auto');
  const roots = { ...defaultRoots(), ...(options.roots || {}) };
  const providers = source === 'auto' ? ['codex', 'claude-code'] : [source];
  const candidates = [];
  for (const provider of providers) {
    for (const file of walkJsonl(roots[provider])) {
      if (provider === 'claude-code' && !options.includeAgents && file.split(path.sep).includes('subagents')) continue;
      let candidate;
      try { candidate = inspectCandidate(file, provider); } catch { continue; }
      if (!options.includeAgents && candidate.parentThreadId) continue;
      if (options.project && !sameProject(candidate.cwd, options.project)) continue;
      candidates.push(candidate);
    }
  }
  if (providers.includes('claude-code') && options.project) {
    const currentId = claudeCurrentSessionId(options.project, options.claudeStateFile);
    const current = candidates.find((candidate) => candidate.provider === 'claude-code' && candidate.id === currentId);
    if (current) current.active = true;
  }
  return candidates.sort((a, b) => b.updatedMs - a.updatedMs || String(b.id).localeCompare(String(a.id)));
}

function selectCandidate(candidates, selector = 'latest') {
  if (!candidates.length) throw new Error('No matching sessions found. Check --source and --project, or pass a JSONL path.');
  if (selector === 'latest' || selector === 'current' || selector === 'previous') {
    const providers = new Set(candidates.map((candidate) => candidate.provider));
    if (providers.size > 1) throw new Error('Both Codex and Claude Code sessions match. Pass --source codex or --source claude-code.');
    const active = candidates.find((candidate) => candidate.active);
    if (selector === 'current') {
      if (active) return active;
      throw new Error('Current session could not be identified. Use --list, --session latest, or an explicit ID.');
    }
    if (selector === 'latest') return candidates[0];
    const previous = active
      ? candidates.find((candidate) => !candidate.active)
      : candidates[1];
    if (!previous) throw new Error('No previous session is available for this project.');
    return previous;
  }
  const matches = candidates.filter((candidate) => candidate.id === selector || path.basename(candidate.file).includes(selector));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Session selector "${selector}" matches multiple files. Pass an absolute JSONL path.`);
  throw new Error(`Session "${selector}" was not found.`);
}

function readSnapshot(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytes = fs.readSync(fd, buffer, offset, size - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return { text: buffer.subarray(0, offset).toString('utf8'), bytes: offset };
  } finally {
    fs.closeSync(fd);
  }
}

function analyzeFile(file, provider = 'auto') {
  const snapshot = readSnapshot(file);
  const session = parseTranscript(snapshot.text, provider, file);
  session.meta.snapshotBytes = snapshot.bytes;
  session.meta.active = session.meta.provider === 'codex'
    && !!process.env.CODEX_THREAD_ID
    && session.meta.id === process.env.CODEX_THREAD_ID;
  return session;
}

function helpText() {
  return `Usage: node analyze-session.js [options]\n\n` +
    `  --source <auto|codex|claude-code>  Transcript provider (default: auto)\n` +
    `  --session <current|latest|previous|ID|PATH> Session selector (default: latest)\n` +
    `  --project, --cwd <PATH>             Project scope (default: current directory)\n` +
    `  --list                              List matching sessions without reading content\n` +
    `  --include-agents                    Include sub-agent sessions\n` +
    `  --output <PATH|->                   Report path; '-' writes Markdown to stdout\n` +
    `  --no-redact                         Disable default secret redaction\n` +
    `  --help                              Show this help\n`;
}

function parseArgs(argv) {
  const options = {
    source: 'auto', session: 'latest', project: process.cwd(), output: null,
    list: false, includeAgents: false, redact: true,
  };
  let sessionSpecified = false;
  function takeValue(index, option, allowDash = false) {
    const value = argv[index + 1];
    if (value == null || (value.startsWith('-') && !(allowDash && value === '-'))) {
      throw new Error(`Missing value for ${option}.`);
    }
    return value;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      options.source = takeValue(index, '--source');
      index += 1;
    } else if (arg === '--session' || arg === '--input') {
      if (sessionSpecified) throw new Error('Session selector was specified more than once.');
      options.session = takeValue(index, arg);
      index += 1;
      sessionSpecified = true;
    } else if (arg === '--project' || arg === '--cwd') {
      options.project = takeValue(index, arg);
      index += 1;
    } else if (arg === '--output' || arg === '-o') {
      options.output = takeValue(index, arg, true);
      index += 1;
    } else if (arg === '--list') options.list = true;
    else if (arg === '--include-agents') options.includeAgents = true;
    else if (arg === '--no-redact') options.redact = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!sessionSpecified) {
      options.session = arg;
      sessionSpecified = true;
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  for (const key of ['source', 'session', 'project']) {
    if (options[key] == null) throw new Error(`Missing value for --${key}.`);
  }
  options.source = canonicalProvider(options.source);
  return options;
}

function printCandidates(candidates) {
  if (!candidates.length) return 'No matching sessions found.';
  return candidates.map((candidate, index) => [
    `${index + 1}.`, candidate.provider, candidate.active ? '[CURRENT]' : '',
    candidate.updatedAt, candidate.id || '(unknown-id)', candidate.cwd || '(unknown-cwd)', candidate.file,
  ].filter(Boolean).join(' ')).join('\n');
}

function outputPathFor(session) {
  const id = String(session.meta.id || path.basename(session.meta.sourceFile, '.jsonl') || 'session')
    .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'session';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-'));
  fs.chmodSync(directory, 0o700);
  return path.join(directory, `${session.meta.provider}-${id}.md`);
}

function writePrivateFile(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  if (options.list) {
    const candidates = discoverCandidates(options);
    console.log(printCandidates(candidates));
    return;
  }

  let inputFile;
  let provider = options.source;
  const possiblePath = path.resolve(options.session);
  if (fs.existsSync(possiblePath) && fs.statSync(possiblePath).isFile()) {
    inputFile = possiblePath;
  } else {
    const isNamedSelector = ['latest', 'current', 'previous'].includes(options.session);
    const candidates = discoverCandidates({
      ...options,
      project: isNamedSelector ? options.project : null,
    });
    const selected = selectCandidate(candidates, options.session);
    inputFile = selected.file;
    provider = selected.provider;
    if (selected.active) console.warn('Warning: selected the current Codex session; the report uses a fixed-size snapshot while the file may still be growing.');
  }

  const session = analyzeFile(inputFile, provider);
  if (session.meta.active) console.warn('Warning: this is the current Codex session and may be incomplete.');
  const report = renderReport(session, { redact: options.redact });
  const output = options.output || outputPathFor(session);
  if (output === '-') {
    process.stdout.write(`${report}\n`);
    return;
  }
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput === path.resolve(inputFile)) throw new Error('Output path must not overwrite the source transcript.');
  writePrivateFile(resolvedOutput, report);
  const { calls } = pairToolCalls(session.events);
  const failed = calls.filter((call) => call.result && call.result.isError).length;
  console.log(`Wrote ${resolvedOutput} — ${session.meta.provider}, ${session.events.length} events, ${calls.length} tool calls (${failed} failed).`);
}

module.exports = {
  analyzeFile,
  detectProvider,
  discoverCandidates,
  main,
  pairToolCalls,
  parseArgs,
  parseTranscript,
  redactValue,
  renderReport,
  selectCandidate,
};

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`session-analysis: ${error.message || error}`);
    process.exitCode = 1;
  }
}
