import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readMainportalRequest, loadMainportalContext, mainportalEventAccess } from '../vendor/mainportal-context.mjs';

const now = new Date('2026-11-17T09:00:00Z');
const input = { schema: 1, actorId: 10, date: '2026-11-17', context: 'personal', childId: 20, lessonRefs: [] };
function signed(body = input) {
    const raw = Buffer.from(JSON.stringify(body));
    const timestamp = String(+now);
    return { raw, headers: { 'x-service-name': 'mainportal', 'x-service-timestamp': timestamp,
        'x-service-signature': crypto.createHmac('sha256', 'test-key').update(timestamp+'\n').update(raw).digest('hex') } };
}
test('signature binds exact bytes, time and service', () => {
    const {raw, headers} = signed();
    assert.deepEqual(readMainportalRequest(raw, headers, 'test-key', now), input);
    assert.throws(() => readMainportalRequest(Buffer.concat([raw, Buffer.from(' ')]), headers, 'test-key', now), /invalid_service/);
    assert.throws(() => readMainportalRequest(raw, headers, 'test-key', new Date(+now+300001)), /invalid_service/);
    assert.throws(() => readMainportalRequest(raw, {...headers, 'x-service-name':'other'}, 'test-key', now), /invalid_service/);
    assert.throws(() => readMainportalRequest(raw, headers, '', now), /disabled/);
});
test('invalid scope and actor are rejected before querying', () => {
    for (const body of [{...input, actorId:'10'}, {...input, context:'any'}, {...input, date:'2026-11-18'}]) {
        const {raw, headers} = signed(body);
        assert.throws(() => readMainportalRequest(raw, headers, 'test-key', now), /invalid_context/);
    }
});
test('teacher-parent gets selected child participation and own responsibilities once', async () => {
    const directory = { query: async sql => [sql.includes('parents_kids') ? [{id:20},{id:21}] : [{role_id:2},{role_id:6}]] };
    const calendar = { query: async (sql,args) => {
        if (sql.includes('LEFT JOIN event_participants')) {
            assert.deepEqual(args.slice(0,2), [10,20]);
            assert.ok(!args.includes(21));
            return [[{id:7,title:'Event',responsible_ids:'10',participant_id:20,starts:'2026-11-17 12:00:00',ends:'2026-11-17 13:00:00'}]];
        }
        return [[]];
    } };
    const result = await loadMainportalContext(calendar, directory, input, {serviceId:9});
    assert.deepEqual(result.events.map(e=>[e.relation,e.studentId]), [['responsible',null],['participant',20]]);
    assert.equal(result.events[0].start,'2026-11-17T12:00:00+03:00');
});
test('foreign child, missing role, school privilege fail before domain reads', async () => {
    const calendar = {query:async()=>assert.fail('no domain query allowed')};
    const directory = {query:async sql=>[sql.includes('parents_kids') ? [{id:20}] : [{role_id:6}]]};
    await assert.rejects(loadMainportalContext(calendar,directory,{...input,childId:99},{serviceId:9}), /child_forbidden/);
    await assert.rejects(loadMainportalContext(calendar,directory,{...input,context:'school'},{serviceId:9}), /context_forbidden/);
    await assert.rejects(loadMainportalContext(calendar,{query:async()=>[[]]},input,{serviceId:9}), /context_forbidden/);
});
test('single-event link resolves a staff-parent child without broadening list or mutation permissions',async()=>{
    const directory={query:async sql=>[sql.includes('parents_kids')?[{id:20}]:[{role_id:2},{role_id:6}]]};
    const calendar={query:async()=>[[{user_id:20}]]};
    const event={id:7,status:'APPROVED',created_by:40,responsible_ids:'40',is_admin_event:0};
    assert.deepEqual(await mainportalEventAccess(calendar,directory,10,event,9),{read:true,approve:false});
    assert.deepEqual(await mainportalEventAccess({query:async()=>[[{user_id:99}]]},directory,10,event,9),{read:false,approve:false});
    assert.deepEqual(await mainportalEventAccess(calendar,directory,10,{...event,is_admin_event:1},9),{read:false,approve:false});
    assert.deepEqual(await mainportalEventAccess(calendar,{query:async()=>[[]]},10,event,9),{read:false,approve:false});
});
test('approval requires both current admin service role and this event assignment',async()=>{
    const directory={query:async()=>[[{role_id:2},{role_id:5}]]};
    const event={id:7,status:'WAITING_ADMIN',created_by:40};
    assert.deepEqual(await mainportalEventAccess({query:async()=>[[{id:1}]]},directory,10,event,9),{read:true,approve:true});
    assert.deepEqual(await mainportalEventAccess({query:async()=>[[]]},directory,10,event,9),{read:false,approve:false});
});
