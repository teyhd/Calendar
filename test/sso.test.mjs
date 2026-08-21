import assert from 'node:assert/strict';
import test from 'node:test';
import { ssoPool } from '../vendor/db.mjs';
import { assertActiveUsers, getActiveUserById } from '../vendor/sso.mjs';

function withMockedSsoQuery(t, handler) {
    const originalQuery = ssoPool.query;
    const originalServiceId = process.env.SSO_SERVICE_ID;
    process.env.SSO_SERVICE_ID = '15';
    ssoPool.query = handler;
    t.after(() => {
        ssoPool.query = originalQuery;
        if (originalServiceId == null) delete process.env.SSO_SERVICE_ID;
        else process.env.SSO_SERVICE_ID = originalServiceId;
    });
}

test('directory reads the SSO role name and requires a matching Calendar service right', async (t) => {
    withMockedSsoQuery(t, async (sql, params) => {
        assert.match(sql, /LEFT JOIN role_name rn ON rn.id = u.type/);
        assert.match(sql, /FROM rights calendar_right/);
        assert.match(sql, /JOIN srvs calendar_service/);
        assert.match(sql, /JOIN srvs_roles calendar_service_role/);
        assert.deepEqual(params, [100, 15]);
        return [[{ id: 100, name: 'Test person', type: 5, kaf: 2, kaf_name: 'Administration', role_name: 'Администратор' }]];
    });

    assert.deepEqual(await getActiveUserById(100), {
        id: 100,
        name: 'Test person',
        type: 5,
        kaf: 2,
        kaf_name: 'Administration',
        role_name: 'Администратор'
    });
});

test('directory rejects an active person without a current Calendar right', async (t) => {
    withMockedSsoQuery(t, async () => [[]]);
    assert.equal(await getActiveUserById(100), null);
});

test('event participant validation uses the same SSO service-policy filter', async (t) => {
    withMockedSsoQuery(t, async (sql, params) => {
        assert.match(sql, /calendar_right.role_id = u.type/);
        assert.match(sql, /calendar_service.name = 'calendar'/);
        assert.deepEqual(params, [101, 1, 15]);
        return [[{ id: 101, name: 'Student', type: 1, kaf: 3, kaf_name: '7A', role_name: 'Ученик' }]];
    });

    const people = await assertActiveUsers([101], [1]);
    assert.equal(people[0].role_name, 'Ученик');
});
