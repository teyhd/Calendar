import crypto from 'node:crypto';
import { google } from 'googleapis';

export const GOOGLE_CALENDAR_SCOPES = Object.freeze([
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.app.created'
]);

export const GOOGLE_SYNC_INTERVALS = Object.freeze([15, 60, 180, 480, 1440]);

function env(name, fallback = '') {
    const value = process.env[name];
    return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

function readEncryptionKeys() {
    const configured = env('GOOGLE_TOKEN_ENCRYPTION_KEYS');
    const entries = configured
        ? configured.split(',').map((value) => value.trim()).filter(Boolean)
        : (env('GOOGLE_TOKEN_ENCRYPTION_KEY') ? [`v1:${env('GOOGLE_TOKEN_ENCRYPTION_KEY')}`] : []);
    const keys = new Map();
    for (const entry of entries) {
        const separator = entry.indexOf(':');
        if (separator <= 0) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEYS is invalid');
        const version = entry.slice(0, separator).trim();
        const key = Buffer.from(entry.slice(separator + 1).trim(), 'base64');
        if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version) || key.length !== 32) {
            throw new Error('Google token encryption key must be 32 bytes in base64');
        }
        keys.set(version, key);
    }
    return keys;
}

export function getGoogleCalendarConfig() {
    const encryptionKeys = readEncryptionKeys();
    return {
        enabled: env('GOOGLE_CALENDAR_SYNC_ENABLED', 'false').toLowerCase() === 'true',
        clientId: env('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
        callbackURL: env('GOOGLE_OAUTH_CALLBACK_URL'),
        encryptionKeys,
        defaultIntervalMinutes: GOOGLE_SYNC_INTERVALS.includes(Number(env('GOOGLE_SYNC_DEFAULT_INTERVAL_MINUTES', '60')))
            ? Number(env('GOOGLE_SYNC_DEFAULT_INTERVAL_MINUTES', '60'))
            : 60
    };
}

export function googleCalendarConfigured() {
    try {
        const cfg = getGoogleCalendarConfig();
        return Boolean(cfg.enabled && cfg.clientId && cfg.clientSecret && cfg.callbackURL && cfg.encryptionKeys.size);
    } catch {
        return false;
    }
}

function requireConfig() {
    const cfg = getGoogleCalendarConfig();
    if (!cfg.enabled) throw new Error('Интеграция Google Calendar временно выключена');
    if (!cfg.clientId || !cfg.clientSecret || !cfg.callbackURL || !cfg.encryptionKeys.size) {
        throw new Error('Интеграция Google Calendar не настроена');
    }
    return cfg;
}

export function createGoogleOAuthClient() {
    const cfg = requireConfig();
    return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.callbackURL);
}

export function authorizationURL({ state, codeVerifier, loginHint = '' }) {
    if (!state || !codeVerifier) throw new Error('OAuth state is required');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return createGoogleOAuthClient().generateAuthUrl({
        access_type: 'offline',
        include_granted_scopes: true,
        prompt: 'consent',
        scope: GOOGLE_CALENDAR_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {})
    });
}

export async function exchangeGoogleAuthorizationCode(code, codeVerifier) {
    if (!code || !codeVerifier) throw new Error('OAuth code is required');
    const client = createGoogleOAuthClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token || !tokens.access_token) throw new Error('Google did not return a refresh token');
    const identity = await getGoogleIdentity(tokens.access_token);
    return { tokens, identity };
}

export async function getGoogleIdentity(accessToken) {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Google profile endpoint status=${response.status}`);
    const profile = await response.json();
    if (!profile?.sub || !profile?.email) throw new Error('Google account identity is incomplete');
    return { subject: String(profile.sub), email: String(profile.email) };
}

function activeEncryptionKey() {
    const keys = requireConfig().encryptionKeys;
    const entry = keys.entries().next().value;
    if (!entry) throw new Error('Google token encryption key is not configured');
    return { version: entry[0], key: entry[1] };
}

export function encryptGoogleRefreshToken(refreshToken) {
    if (!refreshToken) throw new Error('Refresh token is required');
    const { version, key } = activeEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(refreshToken), 'utf8'), cipher.final()]);
    return {
        token_key_version: version,
        refresh_token_ciphertext: encrypted.toString('base64'),
        refresh_token_iv: iv.toString('base64'),
        refresh_token_tag: cipher.getAuthTag().toString('base64')
    };
}

export function decryptGoogleRefreshToken(connection) {
    const cfg = requireConfig();
    const key = cfg.encryptionKeys.get(String(connection?.token_key_version || ''));
    if (!key) throw new Error('Google token encryption key version is unavailable');
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(connection.refresh_token_iv, 'base64'));
        decipher.setAuthTag(Buffer.from(connection.refresh_token_tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(connection.refresh_token_ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        throw new Error('Google refresh token cannot be decrypted');
    }
}

export function googleCalendarClient(refreshToken) {
    const client = createGoogleOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return google.calendar({ version: 'v3', auth: client });
}

export async function createManagedCalendar(refreshToken, summary = 'Школьные мероприятия — Calendar') {
    const calendar = googleCalendarClient(refreshToken);
    const { data } = await calendar.calendars.insert({
        requestBody: { summary, timeZone: 'Europe/Moscow' }
    });
    if (!data.id) throw new Error('Google Calendar did not create a calendar');
    return { id: data.id, summary: data.summary || summary, timeZone: data.timeZone || 'Europe/Moscow' };
}

export async function revokeGoogleRefreshToken(refreshToken) {
    if (!refreshToken) return;
    const body = new URLSearchParams({ token: refreshToken });
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    if (!response.ok) throw new Error(`Google revoke endpoint status=${response.status}`);
}

export function googleErrorDetails(error) {
    const status = Number(error?.code || error?.response?.status || 0);
    const reason = String(error?.response?.data?.error || error?.response?.data?.error_description || error?.message || 'unknown_error');
    const normalized = reason.toLowerCase();
    return {
        status,
        needsReauth: status === 401 || normalized.includes('invalid_grant') || normalized.includes('invalid credentials'),
        retryable: status === 429 || status >= 500,
        message: status === 429 ? 'Google временно ограничил запросы' : status >= 500 ? 'Google Calendar временно недоступен' : 'Не удалось синхронизировать с Google Calendar'
    };
}
