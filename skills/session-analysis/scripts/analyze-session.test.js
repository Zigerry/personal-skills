const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const analyzerPath = path.join(__dirname, 'analyze-session.js');

function analyzer() {
  return require(analyzerPath);
}

function jsonl(records) {
  return records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n');
}

test('parses Claude Code messages and tools without exposing thinking', () => {
  const input = jsonl([
    { type: 'system', timestamp: '2026-07-10T01:59:59Z', message: { content: 'injected' } },
    {
      type: 'user', sessionId: 'claude-1', cwd: '/repo', timestamp: '2026-07-10T02:00:00Z',
      promptSource: 'typed', message: { content: 'Fix the failing test' },
    },
    {
      type: 'assistant', sessionId: 'claude-1', cwd: '/repo', timestamp: '2026-07-10T02:00:01Z',
      message: { model: 'claude-sonnet', content: [
        { type: 'thinking', thinking: 'private reasoning must stay private' },
        { type: 'text', text: 'I will inspect the failure.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      ] },
    },
    {
      type: 'user', sessionId: 'claude-1', cwd: '/repo', timestamp: '2026-07-10T02:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '1 passing', is_error: false }] },
    },
    { type: 'future-event', payload: { anything: true } },
    '{not json',
  ]);

  const session = analyzer().parseTranscript(input, 'claude-code', '/tmp/claude.jsonl');

  assert.equal(session.meta.provider, 'claude-code');
  assert.equal(session.meta.id, 'claude-1');
  assert.equal(session.meta.cwd, '/repo');
  assert.deepEqual(session.events.map((event) => event.kind), [
    'user', 'assistant', 'tool_call', 'tool_result',
  ]);
  assert.equal(session.coverage.omittedReasoning, 1);
  assert.equal(session.coverage.omittedSystem, 1);
  assert.equal(session.coverage.unknownRecords, 1);
  assert.equal(session.coverage.malformedLines, 1);
  assert.doesNotMatch(JSON.stringify(session), /private reasoning must stay private/);
});

test('filters Claude system reminders carried in user text blocks', () => {
  const input = jsonl([{
    type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'claude-reminder', cwd: '/repo',
    message: { content: [
      { type: 'text', text: '<system-reminder>private injected context</system-reminder>' },
      { type: 'text', text: 'Actual request' },
    ] },
  }]);

  const session = analyzer().parseTranscript(input, 'claude-code', '/tmp/reminder.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Actual request/);
  assert.doesNotMatch(rendered, /private injected context|system-reminder/);
  assert.equal(session.coverage.omittedSystem, 1);
});

test('keeps only Claude Code active branch and counts abandoned side branches', () => {
  const input = jsonl([
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'branch-1', cwd: '/repo', message: { content: 'Start' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'branch-1', cwd: '/repo', message: { content: [{ type: 'text', text: 'First answer' }] } },
    { type: 'user', uuid: 'u-old', parentUuid: 'a1', sessionId: 'branch-1', cwd: '/repo', message: { content: 'Abandoned request' } },
    { type: 'assistant', uuid: 'a-old', parentUuid: 'u-old', sessionId: 'branch-1', cwd: '/repo', message: { content: [{ type: 'text', text: 'Abandoned answer' }] } },
    { type: 'user', uuid: 'u-new', parentUuid: 'a1', sessionId: 'branch-1', cwd: '/repo', message: { content: 'Replacement request' } },
    { type: 'assistant', uuid: 'a-new', parentUuid: 'u-new', sessionId: 'branch-1', cwd: '/repo', message: { content: [{ type: 'text', text: 'Final answer' }] } },
    { type: 'last-prompt', leafUuid: 'a-new' },
  ]);

  const session = analyzer().parseTranscript(input, 'claude-code', '/tmp/branch.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Start|First answer|Replacement request|Final answer/);
  assert.doesNotMatch(rendered, /Abandoned/);
  assert.equal(session.coverage.sideBranchRecords, 2);
});

test('keeps parallel Claude tool results attached to active tool calls', () => {
  const input = jsonl([
    { type: 'user', uuid: 'U0', parentUuid: null, sessionId: 'parallel-1', message: { content: 'start' } },
    { type: 'assistant', uuid: 'A1', parentUuid: 'U0', sessionId: 'parallel-1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'assistant', uuid: 'A2', parentUuid: 'A1', sessionId: 'parallel-1', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } },
    { type: 'assistant', uuid: 'A3', parentUuid: 'A2', sessionId: 'parallel-1', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'R1', parentUuid: 'A1', sessionId: 'parallel-1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok1' }] } },
    { type: 'user', uuid: 'R2', parentUuid: 'A2', sessionId: 'parallel-1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok2' }] } },
    { type: 'user', uuid: 'R3', parentUuid: 'A3', sessionId: 'parallel-1', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok3' }] } },
    { type: 'assistant', uuid: 'F', parentUuid: 'R3', sessionId: 'parallel-1', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'last-prompt', leafUuid: 'F' },
  ]);

  const session = analyzer().parseTranscript(input, 'claude-code', '/tmp/parallel.jsonl');
  const paired = analyzer().pairToolCalls(session.events);

  assert.equal(paired.calls.length, 3);
  assert.equal(paired.calls.filter((call) => !call.result).length, 0);
  assert.equal(session.coverage.sideBranchRecords, 0);
});

test('parses Codex response items once and identifies a failed tool result', () => {
  const input = jsonl([
    {
      timestamp: '2026-07-10T03:00:00Z', type: 'session_meta',
      payload: { id: 'codex-1', cwd: '/repo', cli_version: '0.144.1', source: 'cli' },
    },
    {
      timestamp: '2026-07-10T03:00:00Z', type: 'turn_context',
      payload: { model: 'gpt-5', cwd: '/repo' },
    },
    {
      timestamp: '2026-07-10T03:00:01Z', type: 'event_msg',
      payload: { type: 'user_message', message: 'Run the tests' },
    },
    {
      timestamp: '2026-07-10T03:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'INJECTED CONTEXT' }] },
    },
    {
      timestamp: '2026-07-10T03:00:02Z', type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden summary' }] },
    },
    {
      timestamp: '2026-07-10T03:00:03Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running them now.' }] },
    },
    {
      timestamp: '2026-07-10T03:00:03Z', type: 'event_msg',
      payload: { type: 'agent_message', message: 'Running them now.' },
    },
    {
      timestamp: '2026-07-10T03:00:04Z', type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
    },
    {
      timestamp: '2026-07-10T03:00:05Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: '{"exit_code":1,"output":"failed"}' },
    },
    {
      timestamp: '2026-07-10T03:00:05Z', type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-2', name: 'exec', input: 'run' },
    },
    {
      timestamp: '2026-07-10T03:00:05Z', type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: [{ type: 'input_text', text: '{"exit_code":2,"output":"failed too"}' }] },
    },
    {
      timestamp: '2026-07-10T03:00:06Z', type: 'response_item',
      payload: { type: 'web_search_call', id: 'search-1', status: 'completed', action: { query: 'docs' } },
    },
    {
      timestamp: '2026-07-10T03:00:07Z', type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-3', name: 'apply_patch', input: 'patch' },
    },
    {
      timestamp: '2026-07-10T03:00:08Z', type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-3', output: 'apply_patch verification failed: Failed to find expected lines' },
    },
    {
      timestamp: '2026-07-10T03:00:09Z', type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-4', name: 'mcp_tool', input: '{}' },
    },
    {
      timestamp: '2026-07-10T03:00:10Z', type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-4', output: 'Error: permission denied' },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex.jsonl');
  const results = session.events.filter((event) => event.kind === 'tool_result');

  assert.equal(session.meta.id, 'codex-1');
  assert.equal(session.meta.model, 'gpt-5');
  assert.deepEqual(session.events.map((event) => event.kind), [
    'user', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
    'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
  ]);
  assert.deepEqual(results.map((result) => result.isError), [true, true, false, true, true]);
  assert.equal(analyzer().pairToolCalls(session.events).calls.filter((call) => !call.result).length, 0);
  assert.equal(session.coverage.omittedReasoning, 1);
  assert.match(JSON.stringify(session.events), /Run the tests/);
  assert.doesNotMatch(JSON.stringify(session.events), /INJECTED CONTEXT/);
  assert.doesNotMatch(JSON.stringify(session), /hidden summary/);
});

test('reports Codex duration, context usage, and deduplicated compactions', () => {
  const input = jsonl([
    {
      timestamp: '2026-07-10T03:00:00.000Z', type: 'session_meta',
      payload: { id: 'codex-metrics', cwd: '/repo' },
    },
    {
      timestamp: '2026-07-10T03:00:01.000Z', type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 400, output_tokens: 20, total_tokens: 420 },
        last_token_usage: { input_tokens: 400, output_tokens: 20, total_tokens: 420 },
        model_context_window: 1000,
      } },
    },
    {
      timestamp: '2026-07-10T03:00:10.000Z', type: 'compacted',
      payload: { window_number: 2, message: 'private summary', replacement_history: [] },
    },
    {
      timestamp: '2026-07-10T03:00:10.002Z', type: 'event_msg',
      payload: { type: 'context_compacted' },
    },
    {
      timestamp: '2026-07-10T03:00:15.000Z', type: 'compacted',
      payload: { window_number: 3, message: 'another private summary', replacement_history: [] },
    },
    {
      timestamp: '2026-07-10T03:00:15.003Z', type: 'event_msg',
      payload: { type: 'context_compacted' },
    },
    {
      timestamp: '2026-07-10T03:00:20.000Z', type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 1200, output_tokens: 50, total_tokens: 1250 },
        last_token_usage: { input_tokens: 800, cached_input_tokens: 300, output_tokens: 30, total_tokens: 830 },
        model_context_window: 1000,
      } },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex-metrics.jsonl');
  const report = analyzer().renderReport(session);

  assert.equal(session.metrics.durationMs, 20_000);
  assert.equal(session.metrics.context.sampleCount, 2);
  assert.equal(session.metrics.context.last.inputTokens, 800);
  assert.equal(session.metrics.context.last.occupancyPercent, 80);
  assert.equal(session.metrics.context.cumulative.totalTokens, 1250);
  assert.equal(session.metrics.compactions.length, 2);
  assert.equal(session.metrics.compactions[0].windowNumber, 2);
  assert.equal(session.metrics.compactions[1].windowNumber, 3);
  assert.doesNotMatch(JSON.stringify(session), /private summary|another private summary/);
  assert.match(report, /\*\*Observed duration:\*\* 20s/);
  assert.match(report, /## Context and compaction/);
  assert.match(report, /80\.0%/);
  assert.match(report, /\| Compactions \| 2 \|/);
  assert.match(report, /2026-07-10T03:00:10\.000Z/);
  assert.match(report, /2026-07-10T03:00:15\.000Z/);
});

test('reports Claude Code usage and compaction without inventing a context window', () => {
  const input = jsonl([
    {
      type: 'user', sessionId: 'claude-metrics', cwd: '/repo', timestamp: '2026-07-10T04:00:00.000Z',
      message: { content: 'Start' },
    },
    {
      type: 'assistant', sessionId: 'claude-metrics', cwd: '/repo', timestamp: '2026-07-10T04:00:01.000Z',
      message: {
        id: 'message-1', model: 'claude-test',
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10 },
        content: [{ type: 'text', text: 'Working' }],
      },
    },
    {
      type: 'assistant', sessionId: 'claude-metrics', cwd: '/repo', timestamp: '2026-07-10T04:00:02.000Z',
      message: {
        id: 'message-1', model: 'claude-test',
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 25 },
        content: [],
      },
    },
    {
      type: 'system', subtype: 'compact_boundary', sessionId: 'claude-metrics',
      timestamp: '2026-07-10T04:00:03.000Z',
      compact_metadata: { trigger: 'auto', pre_tokens: 150 },
    },
    {
      type: 'user', sessionId: 'claude-metrics', cwd: '/repo', timestamp: '2026-07-10T04:00:03.100Z',
      isCompactSummary: true, message: { content: 'private compact summary' },
    },
    {
      type: 'assistant', sessionId: 'claude-metrics', cwd: '/repo', timestamp: '2026-07-10T04:00:05.000Z',
      message: {
        id: 'message-2', model: 'claude-test', usage: { input_tokens: 40, output_tokens: 5 },
        content: [{ type: 'text', text: 'Done' }],
      },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'claude-code', '/tmp/claude-metrics.jsonl');
  const report = analyzer().renderReport(session);

  assert.equal(session.metrics.durationMs, 5_000);
  assert.equal(session.metrics.context.sampleCount, 2);
  assert.equal(session.metrics.context.peak.inputTokens, 150);
  assert.equal(session.metrics.context.peak.occupancyPercent, null);
  assert.equal(session.metrics.context.cumulative.inputTokens, 190);
  assert.equal(session.metrics.context.cumulative.outputTokens, 30);
  assert.equal(session.metrics.compactions.length, 1);
  assert.equal(session.metrics.compactions[0].trigger, 'auto');
  assert.equal(session.metrics.compactions[0].preTokens, 150);
  assert.doesNotMatch(JSON.stringify(session), /private compact summary/);
  assert.match(report, /150 tokens \(window unavailable\)/);
});

test('prefers Codex event messages per role without leaking injected user context', () => {
  const input = jsonl([
    { timestamp: '2026-07-10T03:10:00Z', type: 'session_meta', payload: { id: 'codex-user-only', cwd: '/repo' } },
    { timestamp: '2026-07-10T03:10:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Actual request' } },
    {
      timestamp: '2026-07-10T03:10:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>INJECTED</environment_context>' }] },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex-user-only.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Actual request/);
  assert.doesNotMatch(rendered, /INJECTED|environment_context/);
  assert.equal(session.events.filter((event) => event.kind === 'user').length, 1);
});

test('does not fall back to injected response messages when any Codex event stream exists', () => {
  const input = jsonl([
    { timestamp: '2026-07-10T03:20:00Z', type: 'session_meta', payload: { id: 'codex-agent-only', cwd: '/repo' } },
    { timestamp: '2026-07-10T03:20:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Visible response' } },
    {
      timestamp: '2026-07-10T03:20:00Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>INJECTED</environment_context>' }] },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex-agent-only.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Visible response/);
  assert.doesNotMatch(rendered, /INJECTED|environment_context/);
});

test('uses a non-injected Codex response role when only the opposite event role exists', () => {
  const input = jsonl([
    { timestamp: '2026-07-10T03:25:00Z', type: 'session_meta', payload: { id: 'codex-mixed-stream', cwd: '/repo' } },
    { timestamp: '2026-07-10T03:25:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Visible response' } },
    {
      timestamp: '2026-07-10T03:25:00Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Actual user goal' }] },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex-mixed-stream.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Actual user goal/);
  assert.match(rendered, /Visible response/);
});

test('filters known Codex context wrappers when legacy response messages are the only source', () => {
  const input = jsonl([
    { timestamp: '2026-07-10T03:30:00Z', type: 'session_meta', payload: { id: 'codex-legacy', cwd: '/repo' } },
    {
      timestamp: '2026-07-10T03:30:00Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>INJECTED</environment_context>' }] },
    },
    {
      timestamp: '2026-07-10T03:30:00Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>INJECTED PLUGINS</recommended_plugins>' }] },
    },
    {
      timestamp: '2026-07-10T03:30:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Actual legacy request' }] },
    },
  ]);

  const session = analyzer().parseTranscript(input, 'codex', '/tmp/codex-legacy.jsonl');
  const rendered = JSON.stringify(session.events);

  assert.match(rendered, /Actual legacy request/);
  assert.doesNotMatch(rendered, /INJECTED|environment_context|recommended_plugins/);
  assert.equal(session.coverage.omittedSystem, 2);
});

test('detects providers from their JSONL envelopes', () => {
  assert.equal(analyzer().detectProvider('{"type":"session_meta","payload":{"id":"x"}}\n'), 'codex');
  assert.equal(analyzer().detectProvider('{"type":"user","message":{"content":"hi"}}\n'), 'claude-code');
  assert.throws(() => analyzer().detectProvider('{"type":"unknown"}\n'), /Could not detect/);
});

test('redacts sensitive keys, bearer tokens, credentials, and common secret formats', () => {
  const value = analyzer().redactValue({
    token: 'plain-token',
    openaiApiKey: 'camel-api-secret',
    githubToken: 'camel-token-secret',
    xApiKey: 'camel-header-secret',
    nested: {
      command: 'curl -H "Authorization: Bearer abc.def.ghi" https://user:pass@example.com',
      note: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
    },
  });

  assert.equal(value.token, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(value), /plain-token|camel-api-secret|camel-token-secret|camel-header-secret|abc\.def\.ghi|user:pass|sk-proj-/);
  assert.match(value.nested.command, /Bearer \[REDACTED\]/);

  const text = analyzer().redactValue([
    '{"api_key":"json-secret"}',
    'Cookie: sid=cookie-secret; theme=dark',
    'tool --token cli-secret',
    'API_KEY="quoted secret"',
    'X-API-Key: header-secret',
    'https://example.test/?access_token=query-secret&view=1',
    '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----',
    'curl -u basic-user:basic-pass https://example.test',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
  ].join('\n'));
  assert.doesNotMatch(text, /json-secret|cookie-secret|cli-secret|quoted secret|header-secret|query-secret|private-key-material|basic-pass|github_pat_/);
});

test('renders a bounded Markdown audit with coverage and no raw secrets', () => {
  const session = analyzer().parseTranscript(jsonl([
    {
      type: 'user', sessionId: 'claude-2', cwd: '/repo', timestamp: '2026-07-10T04:00:00Z',
      promptSource: 'typed', message: { content: 'Use sk-proj-abcdefghijklmnopqrstuvwxyz and keep ``` fenced' },
    },
    {
      type: 'assistant', sessionId: 'claude-2', cwd: '/repo', timestamp: '2026-07-10T04:00:01Z',
      message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { password: 'hunter2' } }] },
    },
    {
      type: 'user', sessionId: 'claude-2', cwd: '/repo', timestamp: '2026-07-10T04:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'permission denied', is_error: true }] },
    },
  ]), 'claude-code', '/tmp/claude-2.jsonl');
  session.meta.cwd = '<!--?access_token=meta-secret';
  session.meta.sourceFile = '/tmp/github_pat_abcdefghijklmnopqrstuvwxyz123456.jsonl';

  const report = analyzer().renderReport(session, { redact: true });

  assert.match(report, /^# Session analysis/m);
  assert.match(report, /## Findings/);
  assert.match(report, /1 failed tool call/);
  assert.match(report, /\*\*Observed duration:\*\* 2s/);
  assert.match(report, /## Agent sessions/);
  assert.match(report, /## Context and compaction/);
  assert.match(report, /\| Compactions \| 0 \|/);
  assert.match(report, /Context samples \| 0/);
  assert.match(report, /## Parser coverage/);
  assert.match(report, /\[REDACTED\]/);
  assert.match(report, /&lt;!--/);
  assert.doesNotMatch(report, /\*\*Project:\*\* <!--/);
  assert.doesNotMatch(report, /meta-secret|github_pat_/);
  assert.doesNotMatch(report, /sk-proj-|hunter2/);
  assert.ok(report.length < 30_000);
});

test('discovers project-matching sessions and selects the previous one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-discovery-'));
  const root = path.join(tmp, 'sessions');
  const day = path.join(root, '2026', '07', '10');
  fs.mkdirSync(day, { recursive: true });

  const older = path.join(day, 'rollout-old.jsonl');
  const newer = path.join(day, 'rollout-new.jsonl');
  const other = path.join(day, 'rollout-other.jsonl');
  fs.writeFileSync(older, jsonl([{ timestamp: '2026-07-10T01:00:00Z', type: 'session_meta', payload: { id: 'old', cwd: '/repo' } }]));
  fs.writeFileSync(newer, jsonl([{ timestamp: '2026-07-10T02:00:00Z', type: 'session_meta', payload: { id: 'new', cwd: '/repo' } }]));
  fs.writeFileSync(other, jsonl([{ timestamp: '2026-07-10T03:00:00Z', type: 'session_meta', payload: { id: 'other', cwd: '/elsewhere' } }]));

  const candidates = analyzer().discoverCandidates({ source: 'codex', project: '/repo', roots: { codex: root } });

  assert.deepEqual(candidates.map((candidate) => candidate.id), ['new', 'old']);
  assert.equal(analyzer().selectCandidate(candidates, 'latest').id, 'new');
  assert.equal(analyzer().selectCandidate(candidates, 'previous').id, 'old');
});

test('discovers and summarizes Codex child sessions without mixing their transcripts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-codex-agents-'));
  const root = path.join(tmp, 'sessions');
  const day = path.join(root, '2026', '07', '10');
  fs.mkdirSync(day, { recursive: true });
  const parentFile = path.join(day, 'rollout-parent.jsonl');
  const childFile = path.join(day, 'rollout-child.jsonl');
  fs.writeFileSync(parentFile, jsonl([
    { timestamp: '2026-07-10T01:00:00Z', type: 'session_meta', payload: { id: 'parent', cwd: '/repo' } },
    { timestamp: '2026-07-10T01:00:10Z', type: 'event_msg', payload: { type: 'agent_message', message: 'parent done' } },
  ]));
  fs.writeFileSync(childFile, jsonl([
    { timestamp: '2026-07-10T01:00:02Z', type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', cwd: '/repo' } },
    { timestamp: '2026-07-10T01:00:07Z', type: 'event_msg', payload: { type: 'agent_message', message: 'private child output' } },
  ]));

  const candidates = analyzer().discoverCandidates({
    source: 'codex', project: '/repo', includeAgents: true, roots: { codex: root },
  });
  const session = analyzer().analyzeFile(parentFile, 'codex');
  analyzer().attachAgentSessions(session, candidates);
  const report = analyzer().renderReport(session);

  assert.equal(session.agentSessions.length, 2);
  assert.deepEqual(session.agentSessions.map((agent) => agent.id), ['parent', 'child']);
  assert.equal(session.agentSessions[1].parentId, 'parent');
  assert.equal(session.agentSessions[1].durationMs, 5_000);
  assert.match(report, /\*\*Subagent sessions:\*\* 1/);
  assert.match(report, /## Agent sessions/);
  assert.match(report, /\| Subagent \| child \| parent \| 2026-07-10T01:00:02Z \| 2026-07-10T01:00:07Z \| 5s \|/);
  assert.doesNotMatch(report, /private child output/);
});

test('gives Claude Code subagents unique IDs and summarizes their duration', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-claude-agents-'));
  const root = path.join(tmp, 'projects');
  const projectDir = path.join(root, 'encoded-project');
  const parentFile = path.join(projectDir, 'claude-parent.jsonl');
  const childDir = path.join(projectDir, 'claude-parent', 'subagents');
  const childFile = path.join(childDir, 'agent-worker-1.jsonl');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(parentFile, jsonl([
    { type: 'user', sessionId: 'claude-parent', cwd: '/repo', timestamp: '2026-07-10T02:00:00Z', message: { content: 'start' } },
    { type: 'assistant', sessionId: 'claude-parent', cwd: '/repo', timestamp: '2026-07-10T02:00:10Z', message: { content: [{ type: 'text', text: 'done' }] } },
  ]));
  fs.writeFileSync(childFile, jsonl([
    { type: 'user', sessionId: 'claude-parent', agentId: 'worker-1', cwd: '/repo', timestamp: '2026-07-10T02:00:02Z', message: { content: 'private child request' } },
    { type: 'assistant', sessionId: 'claude-parent', agentId: 'worker-1', cwd: '/repo', timestamp: '2026-07-10T02:00:08Z', message: { content: [{ type: 'text', text: 'private child result' }] } },
  ]));

  const candidates = analyzer().discoverCandidates({
    source: 'claude-code', project: '/repo', includeAgents: true, roots: { 'claude-code': root },
  });
  const session = analyzer().analyzeFile(parentFile, 'claude-code');
  analyzer().attachAgentSessions(session, candidates);
  const report = analyzer().renderReport(session);

  assert.deepEqual(candidates.map((candidate) => candidate.id).sort(), ['claude-parent', 'worker-1']);
  assert.equal(candidates.find((candidate) => candidate.id === 'worker-1').parentThreadId, 'claude-parent');
  assert.equal(analyzer().selectCandidate(candidates, 'worker-1').file, childFile);
  assert.deepEqual(analyzer().discoverCandidates({
    source: 'claude-code', project: '/repo', roots: { 'claude-code': root },
  }).map((candidate) => candidate.id), ['claude-parent']);
  assert.equal(session.agentSessions.length, 2);
  assert.equal(session.agentSessions[1].durationMs, 6_000);
  assert.match(report, /\| Subagent \| worker-1 \| claude-parent \| 2026-07-10T02:00:02Z \| 2026-07-10T02:00:08Z \| 6s \|/);
  assert.doesNotMatch(report, /private child request|private child result/);
});

test('Codex current and previous selectors honor the active thread marker', () => {
  const candidates = [
    { provider: 'codex', id: 'newer-other', active: false },
    { provider: 'codex', id: 'current', active: true },
    { provider: 'codex', id: 'older-other', active: false },
  ];

  assert.equal(analyzer().selectCandidate(candidates, 'current').id, 'current');
  assert.equal(analyzer().selectCandidate(candidates, 'previous').id, 'newer-other');
  assert.throws(
    () => analyzer().selectCandidate(candidates.map((candidate) => ({ ...candidate, active: false })), 'current'),
    /could not be identified/i,
  );
});

test('marks Claude current session from the project state file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-claude-current-'));
  const root = path.join(tmp, 'projects');
  const projectDir = path.join(root, 'encoded-project');
  const stateFile = path.join(tmp, '.claude.json');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'claude-current.jsonl'), jsonl([{
    type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'claude-current', cwd: '/repo',
    timestamp: '2026-07-10T07:00:00Z', message: { content: 'current' },
  }]));
  fs.writeFileSync(stateFile, JSON.stringify({ projects: { '/repo': { lastSessionId: 'claude-current' } } }));

  const candidates = analyzer().discoverCandidates({
    source: 'claude-code', project: '/repo', roots: { 'claude-code': root }, claudeStateFile: stateFile,
  });

  assert.equal(candidates[0].active, true);
  assert.equal(analyzer().selectCandidate(candidates, 'current').id, 'claude-current');
});

test('CLI options reject missing values and extra positional selectors', () => {
  assert.throws(() => analyzer().parseArgs(['--output']), /Missing value for --output/);
  assert.throws(() => analyzer().parseArgs(['--output', '--no-redact']), /Missing value for --output/);
  assert.throws(() => analyzer().parseArgs(['--session', 'latest', 'extra-id']), /Unexpected argument/);
  assert.equal(analyzer().parseArgs(['--output', '-']).output, '-');
});

test('CLI analyzes an explicit transcript and writes a redacted report', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analysis-cli-'));
  const input = path.join(tmp, 'session.jsonl');
  const output = path.join(tmp, 'report.md');
  fs.writeFileSync(input, jsonl([{
    type: 'user', sessionId: 'cli-1', cwd: '/repo', timestamp: '2026-07-10T05:00:00Z',
    promptSource: 'typed', message: { content: 'PASSWORD=very-secret-value' },
  }]));
  fs.writeFileSync(output, 'old report', { mode: 0o644 });
  fs.chmodSync(output, 0o644);

  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    analyzer().main(['--source', 'claude-code', '--session', input, '--output', output]);
  } finally {
    console.log = originalLog;
  }

  assert.match(logs.join('\n'), /Wrote .*report\.md/);
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /very-secret-value/);
});
