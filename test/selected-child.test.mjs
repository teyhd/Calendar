import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { app } = await import('../app.js');
const { calendarPool, ssoPool } = await import('../vendor/db.mjs');

test('family landing survives login and revalidates the selected child for lists and details', async t => {
    const children = [21, 22].map(id => ({id, name: 'Child ' + id, type: 1}));
    const parent = {id: 10, name: 'Parent', type: 2};
    const events = children.map(({id}) => ({
        id, title: 'Event ' + id, status: 'APPROVED', target_audience_type: 'specific_users', target_audience_id: String(id)
    }));
    t.mock.method(ssoPool, 'query', async (sql, params) => {
        if (sql.includes('AS granted_role')) return [[2, 6].map(granted_role => ({...parent, granted_role}))];
        if (sql.includes('FROM parents_kids')) {
            assert.equal(params[0], parent.id);
            return [children];
        }
        return [[]];
    });
    t.mock.method(calendarPool, 'query', async (sql, params) => {
        if (sql.includes('WHERE e.id = ?')) return [events.filter(event => event.id === Number(params[0]))];
        if (sql.includes('FROM events e')) {
            assert.match(sql, /e.status = 'APPROVED'/);
            assert.match(sql, /is_admin_event/);
            return [events];
        }
        return [[]];
    });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    process.env.SSO_SERVICE_ID = '15';
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.AUTH_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.SSO_CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.SSO_REQUIRE_REVOCABLE = '0';
    process.env.SSO_BASE_URL = base + '/fixture';
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    app.post('/fixture/token', (_req, res) => {
        const payload = [encode({alg: 'HS256'}), encode({aud: 'calendar', sub: parent.id, exp: Math.floor(Date.now()/1000) + 600, right: [2,6]})].join('.');
        const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
        res.json({access_token: payload + '.' + signature});
    });
    const get = (path, cookie = '') => fetch(base + path, {redirect: 'manual', headers: {cookie}});
    const landing = await get('/?child_id=22');
    assert.equal(landing.headers.get('location'), '/api/auth/login?child_id=22');
    assert.equal((await get('/?child_id=22&child_id=21')).status, 400);
    const login = await get(landing.headers.get('location'));
    const nonce = new URL(login.headers.get('location')).searchParams.get('state');
    const lastCookie = (res, name) => res.headers.getSetCookie().findLast(value => value.startsWith(name + '=') && !value.startsWith(name + '=;')).split(';')[0];
    const cb = await get('/api/cb?code=fixture&state=' + nonce, lastCookie(login, 'calendar.auth.state'));
    assert.equal(cb.headers.get('location'), '/?child_id=22');
    const cookie = lastCookie(cb, 'calendar.sid');
    const workspace = await (await get('/api/workspace?child_id=22', cookie)).json();
    assert.equal(workspace.user.id, parent.id);
    assert.equal(workspace.user.type, 2);
    assert.deepEqual(workspace.selected_child, {id: 22, name: 'Child 22'});
    assert.deepEqual(workspace.children.map(child => child.id), [22]);
    assert.equal(workspace.counts.all, 1);
    const list = await (await get('/api/workspace/events?view=children&child_id=22', cookie)).json();
    assert.deepEqual(list.items.map(event => event.id), [22]);
    assert.equal((await get('/api/events/21?child_id=22', cookie)).status, 404);
    assert.equal((await get('/api/events/22?child_id=22', cookie)).status, 200);
    children.pop();
    for (const path of ['/', '/api/workspace', '/api/workspace/events', '/api/events/22']) {
        assert.equal((await get(path + '?child_id=22', cookie)).status, 403);
    }
});
