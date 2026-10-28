// Phase 2 exit gate: receipts (1), secret scrubbing (4), workspace snapshots + undo (5).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { checkClaims, type Receipt } from '../src/receipts.ts';
import { Redactor, vaultSecretValues } from '../src/redact.ts';
import { createSaraServer } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshots.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }): { app: TestApp; dir: string } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    toolPermissions: { shell: 'auto' },
  });
  return { app, dir };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const shellReceipt = (command: string, exit: number, status: Receipt['status'] = 'ok'): Receipt => ({ name: 'shell', status, args: { command }, output: `[exit code ${exit}, 0.1s]\nout` });

// ---------- 1. Receipts ----------

test('receipts: claimed write with no receipt is flagged; Sara must correct herself in the same turn', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push(text("Done! I've created notes.txt with your shopping list."), text("Sorry, I got ahead of myself: I didn't actually create notes.txt."));
  const evs = await drain(runTurn(app, conv.id, 'make me a notes file'));
  const check = evs.find((e) => e.type === 'claim_check');
  assert.ok(check && check.type === 'claim_check', 'the turn is flagged');
  assert.equal(check.correcting, true);
  assert.deepEqual(check.claims.map((c) => [c.kind, c.problem]), [['write', 'missing']]);
  // The correction request carried the receipt note; the final reply is the correction.
  assert.match(app.requests[1].messages.at(-1)!.content as string, /Receipt check failed[\s\S]*no tool did this/);
  assert.equal(evs.at(-1)?.type, 'done');
  const msgs = app.store.messages(conv.id).filter((m) => m.role === 'assistant');
  assert.ok(msgs[0].meta?.unverified, 'the false claim stays marked in the transcript');
  assert.match(msgs[1].content, /didn't actually/);
  assert.equal(app.store.safetyEventCounts().unverified_claim, 1);
  assert.ok(!existsSync(join(app.dataDir, 'workspaces', 'main', 'notes.txt')), 'and nothing pretends it happened');
});

test('receipts: a claim backed by a receipt passes; a repeated false claim is flagged again but does not loop', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('w', 'write_file', { path: 'notes.txt', content: 'milk' })], text("I've created notes.txt for you."));
  const ok = await drain(runTurn(app, conv.id, 'make notes'));
  assert.ok(!ok.some((e) => e.type === 'claim_check'));

  app.script.push(text('All tests pass now and I committed the fix.'), text('Yep, I committed the fix and the tests pass.'));
  const bad = await drain(runTurn(app, conv.id, 'status?'));
  const checks = bad.filter((e) => e.type === 'claim_check');
  assert.equal(checks.length, 2);
  assert.equal(checks[1].type === 'claim_check' && checks[1].correcting, false);
  assert.equal(app.requests.length, 4, 'one correction round only');
});

test('receipts: claim checker rules', () => {
  // Tests "pass" but the last test run failed: contradicted.
  assert.deepEqual(
    checkClaims('I ran the tests and all tests pass.', [shellReceipt('npm test', 1)]).map((c) => [c.kind, c.problem]),
    [['tests_pass', 'contradicted']],
  );
  assert.deepEqual(checkClaims('I ran the tests and all tests pass.', [shellReceipt('npm test', 0)]), []);
  // Commit claim needs a successful git commit.
  assert.equal(checkClaims('I committed the changes.', [shellReceipt('npm test', 0)])[0]?.kind, 'commit');
  assert.deepEqual(checkClaims('I committed the changes.', [shellReceipt('git add -A && git commit -m x', 0)]), []);
  // Denied/failed tools are not receipts.
  assert.equal(checkClaims("I've updated config.json.", [{ name: 'write_file', status: 'denied', args: {}, output: '' }])[0]?.kind, 'write');
  // Web claims need a web receipt.
  assert.equal(checkClaims('I searched for that and found three options for your project.', [])[0]?.kind, 'web');
  // Recaps of earlier work are fine when an earlier receipt names the same file, not otherwise.
  const prior: Receipt[] = [{ name: 'write_file', status: 'ok', args: { path: 'eval-note.txt' }, output: 'Wrote' }];
  assert.deepEqual(checkClaims('Tonight I created eval-note.txt for you.', [], prior), []);
  assert.equal(checkClaims('Tonight I created todo.txt for you.', [], prior)[0]?.kind, 'write');
  assert.equal(checkClaims("I've updated the config file.", [], prior)[0]?.kind, 'write', 'vague claims need a receipt this turn');
  // Not flagged: conversation, negations, questions, earlier turns, code blocks.
  for (const s of [
    'I wrote you a little poem tonight.',
    'I fixed my bike this afternoon.',
    "I didn't change any files.",
    'Should I update the README?',
    'Earlier I created the folder for you.',
    'Here you go:\n```\nI created file.txt\n```',
  ]) {
    assert.deepEqual(checkClaims(s, []), [], s);
  }
});

// ---------- 4. Secret scrubbing ----------

test('scrubbing: vault secrets and key-shaped strings never reach the transcript, the UI or the model', async (t) => {
  const { app } = setup(t);
  app.vault.set('provider:openai', 'sk-proj-REALVAULTKEY1234567890abcdef');
  app.vault.set('mcp:gh', JSON.stringify({ env: { GITHUB_TOKEN: 'super-secret-mcp-value-77' } }));
  const conv = app.store.createConversation();
  const leak = [
    'OPENAI_API_KEY=sk-proj-REALVAULTKEY1234567890abcdef',
    'token: super-secret-mcp-value-77',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature123',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----',
    'db_password = "hunter2hunter2"',
  ].join('\n');
  app.script.push([call('w', 'write_file', { path: '.env', content: leak })], [call('r', 'read_file', { path: '.env' })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'show me the env file'));

  const secrets = ['REALVAULTKEY', 'super-secret-mcp-value-77', 'ghp_abcdefghij', 'eyJhbGciOiJIUzI1NiJ9', 'AAAAB3NzaC1yc2E', 'hunter2hunter2'];
  const surfaces = {
    events: JSON.stringify(evs),
    transcript: JSON.stringify(app.store.messages(conv.id)),
    model: JSON.stringify(app.requests.at(-1)!.messages),
  };
  for (const [where, blob] of Object.entries(surfaces)) for (const s of secrets) assert.ok(!blob.includes(s), `${s} leaked into ${where}`);
  assert.match(surfaces.transcript, /OPENAI_API_KEY=\[REDACTED\]/);
  // The real file on disk is untouched: only what Sara/the UI/the log see is scrubbed.
  assert.match(readFileSync(join(app.dataDir, 'workspaces', 'main', '.env'), 'utf8'), /REALVAULTKEY/);
});

test('scrubbing: redactor unit rules', () => {
  const r = new Redactor(() => vaultSecretValues(['short', JSON.stringify({ headers: { Authorization: 'Bearer abcdefghijklmnop12345' } })]));
  assert.equal(r.redact('short stays (too short to be a vault secret)'), 'short stays (too short to be a vault secret)');
  assert.equal(r.redact('x Bearer abcdefghijklmnop12345 y'), 'x [REDACTED] y');
  assert.equal(r.redact('xai-ABCDEFGHIJKLMNOPQRSTUVWX'), '[REDACTED]');
  assert.equal(r.redact('AKIAABCDEFGHIJKLMNOP'), '[REDACTED]');
  assert.deepEqual(r.redactValue({ a: ['sk-ant-api03-abcdefghijklmnopqrstuv'], n: 3 }), { a: ['[REDACTED]'], n: 3 });
  assert.equal(r.redact('the tokens are spent'), 'the tokens are spent');
});

// ---------- 5. Snapshots + undo ----------

test('snapshots: write/shell outside coding mode are undoable; coding mode relies on its branch', async (t) => {
  const { app } = setup(t);
  const ws = workspaceDir(app.dataDir, 'main');
  writeFileSync(join(ws, 'keep.txt'), 'original');
  mkdirSync(join(ws, 'proj', '.git'), { recursive: true });
  writeFileSync(join(ws, 'proj', '.git', 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(ws, 'proj', 'a.js'), 'v1');
  const conv = app.store.createConversation();
  app.script.push(
    [call('e', 'edit_file', { path: 'keep.txt', old_string: 'original', new_string: 'CHANGED' })],
    [call('w', 'write_file', { path: 'proj/a.js', content: 'v2' })],
    [call('n', 'write_file', { path: 'new.txt', content: 'new' })],
    text('done'),
  );
  const evs = await drain(runTurn(app, conv.id, 'change things'));
  const results = evs.filter((e) => e.type === 'tool_result');
  assert.equal(results.length, 3);
  const firstSnap = results[0].type === 'tool_result' ? results[0].snapshotId : undefined;
  assert.ok(firstSnap, 'tool results carry the snapshot taken before them');
  assert.equal(readFileSync(join(ws, 'keep.txt'), 'utf8'), 'CHANGED');

  const r = app.snapshots.restore('main', ws, firstSnap!);
  assert.equal(readFileSync(join(ws, 'keep.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(ws, 'proj', 'a.js'), 'utf8'), 'v1', 'nested git repos are captured as files');
  assert.ok(!existsSync(join(ws, 'new.txt')), 'files created later are removed');
  assert.equal(r.restored, 2);
  assert.equal(r.removed, 1);
  // The restore itself is undoable.
  app.snapshots.restore('main', ws, r.safety.id);
  assert.equal(readFileSync(join(ws, 'keep.txt'), 'utf8'), 'CHANGED');
  assert.ok(existsSync(join(ws, 'new.txt')));

  const coding = app.store.createConversation({ mode: 'coding' });
  const before = app.snapshots.list('main').length;
  app.script.push([call('c', 'write_file', { path: 'c.txt', content: 'x' })], text('ok'));
  await drain(runTurn(app, coding.id, 'go'));
  assert.equal(app.snapshots.list('main').length, before, 'no snapshots in coding mode');
});

test('snapshots: store dedupes unchanged files, skips node_modules, rejects bad ids', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new SnapshotStore(dir);
  const ws = workspaceDir(dir, 'w');
  writeFileSync(join(ws, 'a.txt'), 'same');
  mkdirSync(join(ws, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'x', 'big.js'), 'ignored');
  const one = s.take('w', ws, 'one');
  const two = s.take('w', ws, 'two');
  assert.equal(one.files, 1);
  assert.equal(two.files, 1);
  assert.deepEqual(s.list('w').map((x) => x.label), ['two', 'one']);
  assert.throws(() => s.restore('w', ws, '../../etc'), /Invalid snapshot id/);
  s.restore('w', ws, one.id);
  assert.ok(existsSync(join(ws, 'node_modules', 'x', 'big.js')), 'skipped folders are left alone');
});

// Contributed by Guilherme Costa (farena-ai/sara#17).
test('snapshots: detects same-size changes when modification time is unchanged', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new SnapshotStore(dir);
  const ws = workspaceDir(dir, 'w');
  const file = join(ws, 'edit.txt');
  writeFileSync(file, 'a');
  const when = new Date('2026-01-01T00:00:00Z');
  utimesSync(file, when, when);
  const before = s.take('w', ws, 'before').id;
  writeFileSync(file, 'b');
  utimesSync(file, when, when);
  const after = s.take('w', ws, 'after').id;
  assert.deepEqual(s.compare('w', before, after).changed, ['edit.txt']);
});

test('snapshots: two quick same-size edits are both seen; settled files still reuse their hash', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new SnapshotStore(dir);
  const ws = workspaceDir(dir, 'w');
  writeFileSync(join(ws, 'quick.txt'), 'one');
  writeFileSync(join(ws, 'old.txt'), 'stable');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(ws, 'old.txt'), past, past);
  const a = s.take('w', ws, 'a').id;
  writeFileSync(join(ws, 'quick.txt'), 'two'); // same size, same second
  const b = s.take('w', ws, 'b').id;
  assert.deepEqual(s.compare('w', a, b).changed, ['quick.txt']);
  // A file untouched for a minute keeps its entry (no re-read needed): same hash in both snapshots.
  const c = s.take('w', ws, 'c').id;
  assert.deepEqual(s.compare('w', b, c).changed, []);
});

test('snapshots API: undo via HTTP adds a note Sara sees; refused while she works there', async (t) => {
  const { app } = setup(t);
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const conv = app.store.createConversation();
  app.script.push([call('w', 'write_file', { path: 'f.txt', content: 'new' })], text('wrote it'));
  const evs = await drain(runTurn(app, conv.id, 'write'));
  const snap = evs.find((e) => e.type === 'tool_result');
  const id = snap?.type === 'tool_result' ? snap.snapshotId : '';
  const list = await (await fetch(`${base}/workspaces/main/snapshots`, { headers: H })).json();
  assert.equal(list[0].id, id);
  const res = await fetch(`${base}/workspaces/main/snapshots/${id}/restore`, { method: 'POST', headers: H, body: JSON.stringify({ conversationId: conv.id }) });
  assert.equal(res.status, 200);
  assert.ok(!existsSync(join(app.dataDir, 'workspaces', 'main', 'f.txt')));
  app.script.push(text('noted'));
  await drain(runTurn(app, conv.id, 'what happened?'));
  const seen = JSON.stringify(app.requests.at(-1)!.messages);
  assert.match(seen, /owner restored workspace \\"main\\" to before: write f\.txt/);
});
