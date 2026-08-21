import crypto from 'crypto';

const stateCookieName = 'calendar.auth.state';
const allowedRoles = new Set([1, 2, 3, 4, 5, 6]);

function env(name, fallback = '') {
    const value = process.env[name];
    return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

function parseDuration(value, fallbackMs) {
    const match = String(value || '').trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
    if (!match) return fallbackMs;
    const unit = (match[2] || 'ms').toLowerCase();
    const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Number(match[1]) * (multipliers[unit] || 1);
}

export function getAuthConfig() {
    return {
        ssoBaseURL: env('SSO_BASE_URL', 'https://platoniks.ru/sso').replace(/\/+$/, ''),
        clientID: env('SSO_CLIENT_ID', 'calendar'),
        clientSecret: env('SSO_CLIENT_SECRET'),
        callbackURL: env('SSO_CALLBACK_URL', 'https://event.platoniks.ru/api/cb'),
        serviceID: Number(env('SSO_SERVICE_ID')),
        jwtSecret: env('JWT_SECRET'),
        sessionSecret: env('AUTH_SESSION_SECRET'),
        sessionCookieName: env('AUTH_SESSION_COOKIE_NAME', 'calendar.sid'),
        sessionTTL: parseDuration(env('AUTH_SESSION_TTL', '8h'), 8 * 60 * 60 * 1_000),
        appEnv: env('NODE_ENV', 'production')
    };
}

export function authConfigured() {
    const cfg = getAuthConfig();
    return Boolean(cfg.clientSecret && cfg.serviceID && cfg.jwtSecret && cfg.sessionSecret);
}

export function setupAuthRoutes(app) {
    app.get('/api/auth/login', authLoginHandler);
    app.get('/api/cb', authCallbackHandler);
    app.get('/api/auth/logout', authLogoutHandler);
    app.post('/api/auth/logout', authLogoutHandler);
    app.get('/api/me', currentUserHandler);
}

export async function loadAuthUser(req) {
    const cfg = getAuthConfig();
    const raw = req.cookies?.[cfg.sessionCookieName];
    if (!raw || !cfg.sessionSecret) return null;
    const payload = verifySignedValue(raw, cfg.sessionSecret);
    if (!payload || Number(payload.exp || 0) <= Math.floor(Date.now() / 1_000)) return null;
    const roleId = Number(payload.role_id);
    if (!allowedRoles.has(roleId)) return null;
    const { getActiveUserById } = await import('./sso.mjs');
    const directoryUser = await getActiveUserById(payload.uid);
    if (!directoryUser || directoryUser.type !== roleId) return null;
    return { ...directoryUser, permissions: calendarPermissions(roleId), raw_role_id: roleId };
}

export async function attachAuthUser(req, res, next) {
    try {
        req.authUser = await loadAuthUser(req);
        next();
    } catch (error) {
        next(error);
    }
}

export function requirePageAuth(req, res, next) {
    if (req.authUser?.permissions?.use_calendar) return next();
    if (req.authUser) return res.status(403).send('Нет доступа к календарю');
    if (!authConfigured()) return res.status(503).send('SSO не настроен');
    return res.redirect('/api/auth/login');
}

export function requireApiAuth(req, res, next) {
    if (req.authUser?.permissions?.use_calendar) return next();
    if (!authConfigured()) return res.status(503).json({ error: 'auth_not_configured' });
    return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
}

export function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.authUser) return req.path.startsWith('/api/') ? res.status(401).json({ authenticated: false, login_url: '/api/auth/login' }) : res.redirect('/api/auth/login');
        if (!req.authUser.permissions?.[permission]) return res.status(403).send('Нет прав на это действие');
        next();
    };
}

async function authLoginHandler(req, res) {
    if (!authConfigured()) return res.status(503).json({ error: 'auth_not_configured' });
    const cfg = getAuthConfig();
    const state = crypto.randomBytes(24).toString('hex');
    clearAuthCookies(req, res);
    res.cookie(stateCookieName, state, cookieOptions(req, { maxAge: 10 * 60 * 1_000 }));
    const url = new URL(`${cfg.ssoBaseURL}/authorize`);
    url.searchParams.set('client_id', cfg.clientID);
    url.searchParams.set('redirect_uri', cfg.callbackURL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('audience', cfg.clientID);
    res.redirect(url.toString());
}

async function authCallbackHandler(req, res) {
    if (!authConfigured()) return res.status(503).json({ error: 'auth_not_configured' });
    const cfg = getAuthConfig();
    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    const storedState = String(req.cookies?.[stateCookieName] || '').trim();
    if (!code || !stateMatches(state, storedState)) {
        clearAuthCookies(req, res);
        return res.status(400).json({ error: 'state_mismatch' });
    }
    try {
        const token = await exchangeCodeForToken(code, cfg);
        const session = buildSessionFromToken(token, cfg);
        clearAuthCookies(req, res);
        res.cookie(cfg.sessionCookieName, session, cookieOptions(req, { maxAge: cfg.sessionTTL }));
        res.clearCookie(stateCookieName, cookieOptions(req));
        res.redirect('/');
    } catch (error) {
        clearAuthCookies(req, res);
        return res.status(401).json({ error: 'auth_failed', detail: error.message || 'unknown' });
    }
}

function authLogoutHandler(req, res) {
    const cfg = getAuthConfig();
    clearAuthCookies(req, res);
    res.redirect(buildLogoutURL(cfg));
}

async function currentUserHandler(req, res) {
    const user = req.authUser || await loadAuthUser(req);
    if (!user) return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
    res.json({ authenticated: true, user: { id: user.id, name: user.name, role_id: user.type, role: roleLabel(user.type) }, permissions: user.permissions });
}

async function exchangeCodeForToken(code, cfg) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: cfg.clientID, client_secret: cfg.clientSecret, redirect_uri: cfg.callbackURL });
    const response = await fetch(`${cfg.ssoBaseURL}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error(`token endpoint status=${response.status}`);
    const parsed = await response.json();
    if (!parsed.access_token) throw new Error('empty access_token');
    return parsed.access_token;
}

export function calendarPermissions(roleId) {
    const role = Number(roleId);
    return {
        use_calendar: allowedRoles.has(role),
        create_event: [2, 3, 4, 5].includes(role),
        moderate_event: role === 5,
        cancel_event: role === 5,
        manage_settings: role === 5,
        view_children: role === 6,
        view_analytics: [2, 3, 4, 5].includes(role)
    };
}

export function extractServiceRoleID(rightClaim, serviceID) {
    if (!Array.isArray(rightClaim)) return 0;
    return rightClaim.reduce((maxRole, row) => {
        const roleId = Number(row?.role_id || 0);
        const hasServiceID = Object.prototype.hasOwnProperty.call(row || {}, 'srv_id');
        const belongsToService = !hasServiceID || Number(row.srv_id) === Number(serviceID);
        return belongsToService && roleId > maxRole ? roleId : maxRole;
    }, 0);
}

export function verifyHS256JWT(token, secret) {
    const [headerPart, payloadPart, signaturePart, ...extra] = String(token || '').split('.');
    if (!headerPart || !payloadPart || !signaturePart || extra.length) throw new Error('invalid jwt format');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') throw new Error('unsupported jwt alg');
    const expected = crypto.createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest('base64url');
    if (!safeEqual(signaturePart, expected)) throw new Error('jwt signature mismatch');
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (!claims.exp || Number(claims.exp) <= Math.floor(Date.now() / 1_000)) throw new Error('jwt expired');
    return claims;
}

export function buildSessionFromToken(token, cfg = getAuthConfig()) {
    const claims = verifyHS256JWT(token, cfg.jwtSecret);
    if (String(claims.aud || '') !== cfg.clientID) throw new Error('jwt audience mismatch');
    const roleId = extractServiceRoleID(claims.right, cfg.serviceID);
    if (!allowedRoles.has(roleId) || !Number(claims.sub)) throw new Error('no calendar role');
    return signValue({ uid: Number(claims.sub), role_id: roleId, exp: Math.floor((Date.now() + cfg.sessionTTL) / 1_000) }, cfg.sessionSecret);
}

export function readSignedSession(value, secret) {
    const payload = verifySignedValue(value, secret);
    return payload && Number(payload.exp || 0) > Math.floor(Date.now() / 1_000) ? payload : null;
}

export function buildLogoutURL(cfg = getAuthConfig()) {
    const url = new URL(`${cfg.ssoBaseURL}/logout`);
    url.searchParams.set('client_id', cfg.clientID);
    url.searchParams.set('post_logout_redirect_uri', appBaseURL(cfg.callbackURL) || 'https://event.platoniks.ru');
    return url.toString();
}

export function stateMatches(state, storedState) {
    return Boolean(state && storedState && safeEqual(String(state), String(storedState)));
}

function signValue(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function signSessionForTest(payload, secret) {
    return signValue(payload, secret);
}

function verifySignedValue(value, secret) {
    const [body, signature, ...extra] = String(value || '').split('.');
    if (!body || !signature || extra.length) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieOptions(req, extra = {}) {
    const cfg = getAuthConfig();
    return { path: '/', httpOnly: true, secure: cfg.appEnv !== 'development', sameSite: 'lax', ...extra };
}

function clearAuthCookies(req, res) {
    const cfg = getAuthConfig();
    res.clearCookie(cfg.sessionCookieName, cookieOptions(req));
    res.clearCookie(stateCookieName, cookieOptions(req));
}

function appBaseURL(callbackURL) {
    try {
        const url = new URL(callbackURL);
        return `${url.protocol}//${url.host}`;
    } catch { return ''; }
}

function roleLabel(roleId) {
    return ({ 1: 'Ученик', 2: 'Учитель', 3: 'Наставник', 4: 'Тьютор', 5: 'Админ', 6: 'Родитель' })[Number(roleId)] || 'Пользователь';
}
