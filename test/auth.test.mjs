import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
    buildLogoutURL,
    buildSessionFromToken,
    calendarPermissions,
    extractServiceRoleID,
    readSignedSession,
    signSessionForTest,
    stateMatches,
    verifyHS256JWT
} from '../vendor/auth.mjs';

const jwtSecret = 'test-jwt-secret';
const sessionSecret = 'test-session-secret';
const cfg = {
    ssoBaseURL: 'https://portal.example/sso',
    clientID: 'calendar',
    clientSecret: 'not-used-by-unit-tests',
    callbackURL: 'https://event.example/api/cb',
    serviceID: 42,
    jwtSecret,
    sessionSecret,
    sessionCookieName: 'calendar.sid',
    sessionTTL: 3_600_000
};

function token(claims, secret = jwtSecret) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
}

function claims(overrides = {}) {
    return {
        sub: 100,
        aud: 'calendar',
        exp: Math.floor(Date.now() / 1_000) + 300,
        right: [
            { srv_id: 9, role_id: 6 },
            { srv_id: 42, role_id: 2 },
            { srv_id: 42, role_id: 5 }
        ],
        ...overrides
    };
}

test('successful code-flow token produces a Calendar session with the maximum service role', () => {
    const session = buildSessionFromToken(token(claims()), cfg);
    assert.deepEqual(readSignedSession(session, sessionSecret), { uid: 100, role_id: 5, exp: readSignedSession(session, sessionSecret).exp });
    assert.equal(extractServiceRoleID(claims().right, 42), 5);
});

test('accepts roles scoped by the Calendar JWT audience while rejecting another service scope', () => {
    const session = buildSessionFromToken(token(claims({ right: [{ role_id: 5 }] })), cfg);
    assert.equal(readSignedSession(session, sessionSecret)?.role_id, 5);
    assert.equal(extractServiceRoleID([{ srv_id: 9, role_id: 5 }], 42), 0);
    assert.throws(() => buildSessionFromToken(token(claims({ right: [{ srv_id: 9, role_id: 5 }] })), cfg), /no calendar role/);
});

test('state check rejects missing and mismatched callback state', () => {
    assert.equal(stateMatches('same', 'same'), true);
    assert.equal(stateMatches('same', 'other'), false);
    assert.equal(stateMatches('', 'same'), false);
});

test('JWT signature, audience and expiry are enforced', () => {
    assert.throws(() => verifyHS256JWT(token(claims(), 'wrong-secret'), jwtSecret), /signature/);
    assert.throws(() => buildSessionFromToken(token(claims({ aud: 'other' })), cfg), /audience/);
    assert.throws(() => verifyHS256JWT(token(claims({ exp: Math.floor(Date.now() / 1_000) - 1 })), jwtSecret), /expired/);
});

test('expired local cookie is rejected before any directory lookup', () => {
    const expired = signSessionForTest({ uid: 100, role_id: 5, exp: Math.floor(Date.now() / 1_000) - 1 }, sessionSecret);
    assert.equal(readSignedSession(expired, sessionSecret), null);
});

test('logout points to SSO and all supported roles have the intended permissions', () => {
    const logoutURL = new URL(buildLogoutURL(cfg));
    assert.equal(logoutURL.pathname, '/sso/logout');
    assert.equal(logoutURL.searchParams.get('client_id'), 'calendar');
    for (const role of [1, 2, 3, 4, 5, 6]) assert.equal(calendarPermissions(role).use_calendar, true);
    assert.equal(calendarPermissions(0).use_calendar, false);
    assert.equal(calendarPermissions(-1).use_calendar, false);
    assert.equal(calendarPermissions(6).view_children, true);
    assert.equal(calendarPermissions(5).moderate_event, true);
});
