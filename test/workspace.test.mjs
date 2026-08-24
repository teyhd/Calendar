import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const {
    normalizedEventStatus,
    shouldPublishAfterApproval,
    workspaceURL,
    workspaceDefaultView,
    workspaceNavigation,
    workspaceScopeForView,
    normalizeWorkspaceView,
    eventVisibleTo
} = await import('../app.js');

test('workspace status filter uses the database WAITING_ADMIN value and accepts the old alias', () => {
    assert.equal(normalizedEventStatus('WAITING'), 'WAITING_ADMIN');
    assert.equal(normalizedEventStatus('waiting_admin'), 'WAITING_ADMIN');
    assert.equal(normalizedEventStatus('unknown'), 'all');
});

test('workspace links normalize legacy scopes into canonical views', () => {
    assert.equal(workspaceURL({ scope: 'all' }), '/');
    assert.equal(workspaceURL({ scope: 'moderation', event: 42 }), '/?event=42&view=moderation');
    assert.equal(workspaceURL({ panel: 'analytics' }), '/?view=analytics');
    assert.equal(workspaceScopeForView('history'), 'archive');
});

test('workspace default and visible navigation are role-adaptive', () => {
    const student = { type: 1, permissions: { create_event: false } };
    const teacher = { type: 2, permissions: { create_event: true } };
    const parent = { type: 6, permissions: { view_children: true } };
    const admin = { type: 5, permissions: { create_event: true, moderate_event: true, manage_settings: true, view_analytics: true } };
    assert.equal(workspaceDefaultView(student), 'calendar');
    assert.equal(workspaceDefaultView(teacher), 'mine');
    assert.equal(workspaceDefaultView(parent), 'children');
    assert.equal(workspaceDefaultView(admin, 2), 'moderation');
    assert.equal(normalizeWorkspaceView('moderation', teacher), 'calendar');
    assert.ok(workspaceNavigation(parent).some((item) => item.view === 'children'));
    assert.ok(workspaceNavigation(admin, { pendingCount: 2 }).some((item) => item.view === 'moderation' && item.count === 2));
});

test('administrator calendar visibility includes every event status', async () => {
    const admin = { id: 5, type: 5, permissions: { moderate_event: true } };
    for (const status of ['DRAFT', 'WAITING_ADMIN', 'APPROVED', 'REJECTED', 'CANCELED', 'COMPLETED']) {
        assert.equal(await eventVisibleTo({ created_by: 99, status, is_admin_event: 0 }, admin), true, status);
    }
});

test('an event is published only when no assigned administrator is still pending', () => {
    assert.equal(shouldPublishAfterApproval(2), false);
    assert.equal(shouldPublishAfterApproval(1), false);
    assert.equal(shouldPublishAfterApproval(0), true);
});
