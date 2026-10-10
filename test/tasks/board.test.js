// Approved WhatsApp tasks land on the board. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb } from '../../src/landing/store.js';
import { addWhatsAppTask, getTask, taskHistory, saveTask, seedTaskRefs, nextTaskRef } from '../../src/tasks/board.js';

const candidate = { ref: 'a24', chat_label: 'Supplier group', title: 'Send the carton photos', assignee: 'Atif', due_date: '2026-10-20', priority: 'high', notes: 'before loading', quote: 'pls send carton pics' };

test('an approved WhatsApp task lands in New with its ref, chat and quote', () => {
  const db = openLandingDb(':memory:');
  const t = addWhatsAppTask(db, candidate);
  assert.deepEqual(
    { ref: t.ref, status: t.status, assignee: t.assignee, due: t.due, priority: t.priority, source: t.source, chat: t.sourceChat, quote: t.sourceQuote, by: t.createdBy },
    { ref: 'A24', status: 'new', assignee: 'Atif', due: '2026-10-20', priority: 'high', source: 'whatsapp', chat: 'Supplier group', quote: 'pls send carton pics', by: 'Ashar' }
  );
  assert.equal(taskHistory(db, 'A24')[0].action, 'create');
});

test('only Ashar and Atif are kept as assignees, and odd dates and priorities are dropped', () => {
  const db = openLandingDb(':memory:');
  const t = addWhatsAppTask(db, { ...candidate, assignee: 'Rafay', due_date: 'next Friday', priority: 'urgent' });
  assert.equal(t.assignee, null);
  assert.equal(t.due, null);
  assert.equal(t.priority, null);
});

test('approving the same ref again updates the task and keeps its status', () => {
  const db = openLandingDb(':memory:');
  const t = addWhatsAppTask(db, candidate);
  saveTask(db, { ...t, status: 'in_progress' }, { actor: 'Atif' });
  addWhatsAppTask(db, { ...candidate, title: 'Send the carton photos today' });
  const again = getTask(db, 'A24');
  assert.equal(again.title, 'Send the carton photos today');
  assert.equal(again.status, 'in_progress');
});

test('board and WhatsApp share one counter, and it never goes backwards', () => {
  const db = openLandingDb(':memory:');
  seedTaskRefs(db, 30);
  assert.equal(nextTaskRef(db), 'A31');
  seedTaskRefs(db, 5); // an older counter can't pull it back
  assert.equal(nextTaskRef(db), 'A32');
  addWhatsAppTask(db, { ...candidate, ref: 'A40' }); // a ref handed out elsewhere
  assert.equal(nextTaskRef(db), 'A41');
});
