import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.GOOGLE_CALENDAR_SYNC_ENABLED = 'true';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'calendar-test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'calendar-test-secret';
process.env.GOOGLE_OAUTH_CALLBACK_URL = 'https://calendar.example/integrations/google-calendar/callback';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;

const {
    authorizationURL,
    decryptGoogleRefreshToken,
    encryptGoogleRefreshToken,
    googleCalendarConfigured,
    googleErrorDetails
} = await import('../vendor/google-calendar.mjs');
const { googleSyncEligibility, nextGoogleSyncAt } = await import('../app.js');

test('Google OAuth URL requests offline access, PKCE and only the managed-calendar scope', () => {
    const url = new URL(authorizationURL({ state: 'state-value', codeVerifier: 'v'.repeat(64) }));
    assert.equal(url.searchParams.get('state'), 'state-value');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('scope').includes('calendar.app.created'));
    assert.equal(googleCalendarConfigured(), true);
});

test('Google refresh tokens are encrypted and reject tampering', () => {
    const encrypted = encryptGoogleRefreshToken('refresh-token-value');
    assert.notEqual(encrypted.refresh_token_ciphertext, 'refresh-token-value');
    assert.equal(decryptGoogleRefreshToken(encrypted), 'refresh-token-value');
    assert.throws(() => decryptGoogleRefreshToken({ ...encrypted, refresh_token_tag: Buffer.alloc(16).toString('base64') }), /cannot be decrypted/);
});

test('Google eligibility uses audience for ordinary events and registration for opt-in events', () => {
    const student = { id: 11, type: 1, name: 'Ученик', kaf: 7, kaf_name: '7А' };
    const classEvent = { target_audience_type: 'class', target_audience_id: '7', responsible_ids: '', is_registration_enabled: 0, is_admin_event: 0 };
    assert.deepEqual(googleSyncEligibility(classEvent, student, [student]), { subjectNames: ['Ученик'] });

    const registrationEvent = { ...classEvent, is_registration_enabled: 1 };
    assert.equal(googleSyncEligibility(registrationEvent, student, [student]), null);
    assert.deepEqual(googleSyncEligibility(registrationEvent, student, [student], [11]), { subjectNames: ['Ученик'] });

    const draftEvent = { ...classEvent, status: 'WAITING_ADMIN' };
    assert.equal(googleSyncEligibility(draftEvent, student, [student]), null);

    const creatorWithoutParticipation = { ...classEvent, target_audience_id: '8', responsible_ids: '11' };
    assert.equal(googleSyncEligibility(creatorWithoutParticipation, student, [student]), null);
});

test('parent sync uses only selected children while administrative events stay with administrators', () => {
    const parent = { id: 80, type: 6, name: 'Родитель' };
    const child = { id: 11, type: 1, name: 'Ребёнок', kaf: 7, kaf_name: '7А' };
    const specific = { target_audience_type: 'specific_users', target_audience_id: '11', responsible_ids: '', is_registration_enabled: 0, is_admin_event: 0 };
    assert.deepEqual(googleSyncEligibility(specific, parent, [child]), { subjectNames: ['Ребёнок'] });
    assert.equal(googleSyncEligibility(specific, parent, []), null);
    const adminEvent = { ...specific, is_admin_event: 1, responsible_ids: '5' };
    assert.equal(googleSyncEligibility(adminEvent, parent, [child]), null);
    assert.deepEqual(googleSyncEligibility(adminEvent, { id: 5, type: 5, name: 'Админ' }, [{ id: 5, name: 'Админ' }]), { subjectNames: ['Админ'] });
    assert.equal(googleSyncEligibility(adminEvent, { id: 6, type: 5, name: 'Другой админ' }, [{ id: 6, name: 'Другой админ' }]), null);
});

test('daily Google synchronization chooses the next Moscow wall-clock occurrence', () => {
    const next = nextGoogleSyncAt(1440, '09:00', new Date('2026-08-24T08:30:00+03:00'));
    assert.equal(next, '2026-08-24 09:00:00');
    const tomorrow = nextGoogleSyncAt(1440, '09:00', new Date('2026-08-24T10:30:00+03:00'));
    assert.equal(tomorrow, '2026-08-25 09:00:00');
});

test('Google errors never expose provider response text to the user-facing status', () => {
    const details = googleErrorDetails({ code: 429, message: 'secret provider response' });
    assert.equal(details.retryable, true);
    assert.equal(details.message, 'Google временно ограничил запросы');
    assert.equal(details.message.includes('secret'), false);
});
