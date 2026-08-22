import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { normalizedEventStatus, shouldPublishAfterApproval, workspaceURL } = await import('../app.js');

test('workspace status filter uses the database WAITING_ADMIN value and accepts the old alias', () => {
    assert.equal(normalizedEventStatus('WAITING'), 'WAITING_ADMIN');
    assert.equal(normalizedEventStatus('waiting_admin'), 'WAITING_ADMIN');
    assert.equal(normalizedEventStatus('unknown'), 'all');
});

test('workspace legacy links resolve to the single calendar route', () => {
    assert.equal(workspaceURL({ scope: 'all' }), '/');
    assert.equal(workspaceURL({ scope: 'moderation', event: 42 }), '/?scope=moderation&event=42');
    assert.equal(workspaceURL({ panel: 'analytics' }), '/?panel=analytics');
});

test('an event is published only when no assigned administrator is still pending', () => {
    assert.equal(shouldPublishAfterApproval(2), false);
    assert.equal(shouldPublishAfterApproval(1), false);
    assert.equal(shouldPublishAfterApproval(0), true);
});
