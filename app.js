import express from 'express';
import cookieParser from 'cookie-parser';
import { engine } from 'express-handlebars';
import handlebars from 'handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import cron from 'node-cron';
import pool from './vendor/db.mjs';
import { mlog } from './vendor/logs.js';
import { registerHelpers } from './vendor/hlp.mjs';
import {
    attachAuthUser,
    requireApiAuth,
    requirePageAuth,
    requirePermission,
    setupAuthRoutes
} from './vendor/auth.mjs';
import {
    assertActiveUsers,
    getActiveUsersByIds,
    getCalendarAdmins,
    getChildrenForParent,
    getKafById,
    listActiveUsers,
    listClasses,
    listDepartments,
    parseIdList,
    STAFF_ROLE_IDS
} from './vendor/sso.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const editableStatuses = new Set(['WAITING_ADMIN', 'REJECTED']);
const visibleStatuses = new Set(['APPROVED', 'COMPLETED', 'CANCELED']);
const audienceTypes = new Set(['class', 'parallel', 'department', 'specific_users', 'all', 'multiple_classes']);
const levels = new Set(['school', 'city', 'regional', 'national', 'international']);
const rewardTypes = new Set(['none', 'educational', 'competitive']);
const YEAR_PLAN_IMPORT = Object.freeze({
    sourceName: 'График года',
    sheetName: '26-27',
    startDate: '2026-08-22',
    expectedCreatorName: 'Юникова Марина Витальевна',
    defaultEventType: 'Досуговое',
    previewTtlSeconds: 15 * 60
});
const YEAR_PLAN_SOURCE_COLUMNS = Object.freeze([
    { index: 2, label: 'Начальная школа', grades: [1, 2, 3, 4] },
    { index: 3, label: '5-6 классы', grades: [5, 6] },
    { index: 4, label: '7-9 классы', grades: [7, 8, 9] },
    { index: 5, label: '10-11 классы', grades: [10, 11] }
]);
const YEAR_PLAN_HEADER = Object.freeze(['Уч. нед.', 'Дата', 'Начальная школа', '5-6 классы', '7-9 классы', '10-11 классы', 'комментарии']);

app.set('trust proxy', 1);
registerHelpers(handlebars);
app.engine('.hbs', engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/layouts'),
    partialsDir: path.join(__dirname, 'views/partials'),
    handlebars
}));
app.set('view engine', '.hbs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(attachAuthUser);
setupAuthRoutes(app);

// Legacy bookmark URLs are redirects only; they never process local credentials.
app.all('/auth/login', (req, res) => res.redirect(303, '/api/auth/login'));
app.all('/auth/logout', (req, res) => res.redirect(303, '/api/auth/logout'));

app.use(async (req, res, next) => {
    res.locals.user = req.authUser || null;
    res.locals.isAuthenticated = Boolean(req.authUser);
    res.locals.canImportYearPlan = canImportYearPlan(req.authUser);
    res.locals.notifications = [];
    res.locals.unreadCount = 0;
    if (!req.authUser) return next();
    try {
        const [notifications] = await pool.query(
            'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
            [req.authUser.id]
        );
        const [unread] = await pool.query(
            'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
            [req.authUser.id]
        );
        res.locals.notifications = notifications;
        res.locals.unreadCount = Number(unread[0]?.count || 0);
        if (req.authUser.type === 6) {
            const children = await getChildrenForParent(req.authUser.id);
            res.locals.user = { ...req.authUser, child_kaf_name: children.map((child) => child.kaf_name).filter(Boolean).join(', ') || 'Не указан' };
        }
        next();
    } catch (error) {
        mlog('[ERROR]', 'Не удалось загрузить пользовательский контекст', error.code || error.message);
        next();
    }
});

function user(req) {
    return req.authUser;
}

function pageError(res, status, message) {
    return res.status(status).send(message);
}

function apiError(res, status, message) {
    return res.status(status).json({ error: message });
}

function wantsJSON(req) {
    return req.path.startsWith('/api/') || String(req.get('accept') || '').includes('application/json');
}

function successResponse(req, res, payload = {}) {
    return wantsJSON(req) ? res.json({ success: true, ...payload }) : null;
}

const workspaceViews = new Set(['calendar', 'mine', 'children', 'moderation', 'history', 'reviews', 'analytics', 'import', 'settings', 'notifications']);
const workspaceViewAliases = Object.freeze({
    all: 'calendar',
    archive: 'history',
    calendar: 'calendar',
    mine: 'mine',
    children: 'children',
    moderation: 'moderation',
    history: 'history',
    reviews: 'reviews',
    analytics: 'analytics',
    import: 'import',
    settings: 'settings',
    notifications: 'notifications'
});

export function workspaceScopeForView(view) {
    return Object.freeze({ history: 'archive', calendar: 'all' })[view] || view || 'all';
}

export function normalizeWorkspaceView(value, actor = null) {
    const requested = workspaceViewAliases[String(value || '').toLowerCase()] || 'calendar';
    if (!workspaceViews.has(requested)) return 'calendar';
    if (!actor) return requested;
    if (requested === 'children' && !actor.permissions?.view_children) return 'calendar';
    if (requested === 'moderation' && !actor.permissions?.moderate_event) return 'calendar';
    if (requested === 'analytics' && !actor.permissions?.view_analytics) return 'calendar';
    if (requested === 'settings' && !actor.permissions?.manage_settings) return 'calendar';
    if (requested === 'import' && !canImportYearPlan(actor)) return 'calendar';
    return requested;
}

export function workspaceDefaultView(actor, pendingCount = 0) {
    if (actor?.permissions?.moderate_event && Number(pendingCount) > 0) return 'moderation';
    if (actor?.permissions?.view_children) return 'children';
    if (actor?.permissions?.create_event) return 'mine';
    return 'calendar';
}

export function workspaceNavigation(actor, { pendingCount = 0, unreadCount = 0 } = {}) {
    const item = (view, label, icon, count = 0) => ({
        view,
        label,
        icon,
        count: Number(count) || 0,
        href: workspaceURL({ view })
    });
    const navigation = [item('calendar', 'Календарь', 'calendar')];
    if (actor?.permissions?.view_children) navigation.push(item('children', 'Дети', 'users'));
    else if (actor?.permissions?.create_event) navigation.push(item('mine', 'Мои события', 'bookmark'));
    if (actor?.permissions?.moderate_event) navigation.push(item('moderation', 'Модерация', 'shield', pendingCount));
    navigation.push(item('history', 'История', 'archive'));
    navigation.push(item('reviews', 'Отзывы', 'star'));
    if (actor?.permissions?.view_analytics) navigation.push(item('analytics', 'Аналитика', 'chart'));
    if (canImportYearPlan(actor)) navigation.push(item('import', 'Импорт плана', 'upload'));
    if (actor?.permissions?.manage_settings) navigation.push(item('settings', 'Настройки', 'settings'));
    navigation.push(item('notifications', 'Уведомления', 'bell', unreadCount));
    return navigation;
}

function workspaceViewFromQuery(query, actor, pendingCount = 0) {
    const explicit = query.view || query.scope || query.panel;
    return explicit ? normalizeWorkspaceView(explicit, actor) : workspaceDefaultView(actor, pendingCount);
}

export function workspaceURL(params = {}) {
    const canonical = { ...params };
    if (!canonical.view && (canonical.scope || canonical.panel)) {
        const legacy = canonical.scope || canonical.panel;
        canonical.view = workspaceViewAliases[String(legacy).toLowerCase()] || undefined;
        delete canonical.scope;
        delete canonical.panel;
    }
    if (canonical.view === 'calendar') delete canonical.view;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(canonical)) {
        if (value != null && value !== '' && value !== 'all') search.set(key, String(value));
    }
    const suffix = search.toString();
    return suffix ? `/?${suffix}` : '/';
}

function workspaceRedirect(req, res, params = {}) {
    const response = successResponse(req, res, params);
    return response || res.redirect(303, workspaceURL(params));
}

function toSqlDateTime(value, field) {
    const raw = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
        throw new Error(`Некорректная дата: ${field}`);
    }
    const normalized = `${raw.replace('T', ' ')}${raw.length === 16 ? ':00' : ''}`;
    if (Number.isNaN(new Date(normalized.replace(' ', 'T')).getTime())) throw new Error(`Некорректная дата: ${field}`);
    return normalized;
}

function importError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizedText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizedPersonName(value) {
    return normalizedText(value).toLocaleLowerCase('ru-RU');
}

function sameUserId(left, right) {
    const leftId = Number(left);
    const rightId = Number(right);
    return Number.isSafeInteger(leftId) && leftId > 0 && leftId === rightId;
}

export function canImportYearPlan(actor) {
    return Boolean(
        actor?.permissions?.create_event
        && STAFF_ROLE_IDS.includes(Number(actor.type))
        && normalizedPersonName(actor.name) === normalizedPersonName(YEAR_PLAN_IMPORT.expectedCreatorName)
    );
}

function assertYearPlanImportActor(actor) {
    if (!canImportYearPlan(actor)) {
        throw importError(`Импорт графика доступен только в активной SSO-сессии пользователя «${YEAR_PLAN_IMPORT.expectedCreatorName}».`, 403);
    }
}

function parseCsvSnapshot(csv) {
    if (typeof csv !== 'string' || !csv.trim()) throw importError('Загрузите непустой CSV-снимок вкладки 26-27.');
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < csv.length; index += 1) {
        const char = csv[index];
        if (quoted) {
            if (char === '"' && csv[index + 1] === '"') {
                value += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                value += char;
            }
            continue;
        }
        if (char === '"') {
            if (value) throw importError('CSV содержит некорректную кавычку. Экспортируйте вкладку заново из Google Sheets.');
            quoted = true;
        } else if (char === ',') {
            row.push(value);
            value = '';
        } else if (char === '\n') {
            row.push(value.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            value = '';
        } else {
            value += char;
        }
    }
    if (quoted) throw importError('CSV содержит незакрытую кавычку. Экспортируйте вкладку заново из Google Sheets.');
    if (value || row.length) {
        row.push(value.replace(/\r$/, ''));
        rows.push(row);
    }
    if (rows[0]?.[0]?.charCodeAt(0) === 0xFEFF) rows[0][0] = rows[0][0].slice(1);
    return rows.filter((cells) => cells.some((cell) => String(cell || '').length));
}

function sourceDateToIso(value) {
    const match = normalizedText(value).toLocaleLowerCase('ru-RU').match(/^(?:[а-яё]{2}\s+)?(\d{1,2})\s+([а-яё]+)$/u);
    if (!match) return null;
    const monthNumbers = {
        января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
        июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12
    };
    const day = Number(match[1]);
    const month = monthNumbers[match[2]];
    if (!month || day < 1 || day > 31) return null;
    const year = month >= 8 ? 2026 : 2027;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validateYearPlanSnapshot(rows, fileName) {
    if (!/26[-–—]27/u.test(String(fileName || ''))) throw importError('Имя CSV должно содержать «26-27», чтобы исключить импорт другой вкладки.');
    const header = rows[0];
    if (!header || YEAR_PLAN_HEADER.some((expected, index) => normalizedText(header[index]) !== expected)) {
        throw importError('CSV не похож на экспорт вкладки «26-27»: не совпадает строка заголовков.');
    }
}

function sourceDescription({ hash, sourceRows, sourceColumns, comment, note }) {
    const provenance = `Импорт: ${YEAR_PLAN_IMPORT.sourceName}/${YEAR_PLAN_IMPORT.sheetName}; SHA-256=${hash}; строка CSV ${sourceRows.join(', ')}; колонки ${sourceColumns.join(', ')}`;
    if (note) return `${provenance}\nСлужебная заметка: ${note}`;
    return comment ? `${provenance}\nКомментарий: ${comment}` : provenance;
}

export function buildYearPlanImportRecords(csv, fileName = '26-27.csv') {
    const rows = parseCsvSnapshot(csv);
    validateYearPlanSnapshot(rows, fileName);
    const snapshotHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
    const grouped = new Map();
    const records = [];

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const sourceDate = sourceDateToIso(row[1]);
        if (!sourceDate || sourceDate < YEAR_PLAN_IMPORT.startDate) continue;
        const sourceRow = rowIndex + 1;
        const comment = String(row[6] || '').trim();
        const populatedColumns = YEAR_PLAN_SOURCE_COLUMNS
            .map((column) => ({ ...column, title: String(row[column.index] || '').trim() }))
            .filter((column) => column.title);

        if (!populatedColumns.length && comment) {
            records.push({
                title: `Служебная заметка — ${sourceDate.split('-').reverse().join('.')}`,
                description: sourceDescription({ hash: snapshotHash, sourceRows: [sourceRow], sourceColumns: ['комментарии'], note: comment }),
                sourceRows: [sourceRow],
                sourceColumns: ['комментарии'],
                sourceValues: [{ column: 'комментарии', value: comment }],
                sourceDate,
                audienceAll: true,
                grades: []
            });
            continue;
        }

        for (const column of populatedColumns) {
            const key = `${sourceDate}\u0000${column.title}`;
            const record = grouped.get(key) || {
                title: column.title,
                description: null,
                sourceRows: [sourceRow],
                sourceColumns: [],
                sourceValues: comment ? [{ column: 'комментарии', value: comment }] : [],
                sourceDate,
                audienceAll: false,
                grades: [],
                comment
            };
            if (!record.sourceRows.includes(sourceRow)) record.sourceRows.push(sourceRow);
            if (!record.sourceColumns.includes(column.label)) record.sourceColumns.push(column.label);
            record.sourceValues.push({ column: column.label, value: column.title });
            record.grades.push(...column.grades);
            grouped.set(key, record);
        }
    }

    for (const record of grouped.values()) {
        record.grades = [...new Set(record.grades)].sort((left, right) => left - right);
        record.audienceAll = record.sourceColumns.length === YEAR_PLAN_SOURCE_COLUMNS.length;
        record.description = sourceDescription({
            hash: snapshotHash,
            sourceRows: record.sourceRows,
            sourceColumns: record.sourceColumns,
            comment: record.comment
        });
        delete record.comment;
        records.push(record);
    }
    if (!records.length) throw importError(`В CSV нет записей начиная с ${YEAR_PLAN_IMPORT.startDate.split('-').reverse().join('.')}.`);
    return { snapshotHash, records };
}

function importPreviewSignature(actorId, snapshotHash, expiresAt) {
    const secret = process.env.AUTH_SESSION_SECRET || process.env.JWT_SECRET;
    if (!secret) throw importError('Не настроен секрет для подтверждения импорта.', 503);
    return crypto.createHmac('sha256', secret).update(`${actorId}:${snapshotHash}:${expiresAt}`).digest('base64url');
}

function createImportPreviewToken(actorId, snapshotHash) {
    const expiresAt = Math.floor(Date.now() / 1000) + YEAR_PLAN_IMPORT.previewTtlSeconds;
    return { expiresAt, signature: importPreviewSignature(actorId, snapshotHash, expiresAt) };
}

function verifyImportPreviewToken(actorId, snapshotHash, expiresAt, signature) {
    if (!Number.isInteger(Number(expiresAt)) || Number(expiresAt) < Math.floor(Date.now() / 1000)) {
        throw importError('Срок действия предварительного просмотра истёк. Загрузите CSV повторно.');
    }
    const expected = importPreviewSignature(actorId, snapshotHash, Number(expiresAt));
    const actual = String(signature || '');
    if (!actual || actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
        throw importError('Подтверждение не соответствует проверенному CSV-снимку.', 403);
    }
}

function userNameMap(people) {
    return new Map(people.map((person) => [Number(person.id), person]));
}

function parallelFromName(name) {
    const match = String(name || '').trim().match(/^(\d+)/);
    return match ? match[1] : '';
}

function eventAudienceIds(event) {
    return parseIdList(event.target_audience_id);
}

async function enrichEvents(events) {
    if (!events.length) return [];
    const ids = new Set();
    for (const event of events) {
        ids.add(Number(event.created_by));
        if (event.review_author_id) ids.add(Number(event.review_author_id));
        parseIdList(event.responsible_ids).forEach((id) => ids.add(id));
        if (event.target_audience_type === 'specific_users') eventAudienceIds(event).forEach((id) => ids.add(id));
    }
    const people = userNameMap(await getActiveUsersByIds([...ids]));
    const kafIds = new Set();
    for (const event of events) {
        if (event.target_audience_type === 'class' || event.target_audience_type === 'department') {
            const id = Number(event.target_audience_id);
            if (id) kafIds.add(id);
        }
        if (event.target_audience_type === 'multiple_classes') eventAudienceIds(event).forEach((id) => kafIds.add(id));
    }
    const kafs = await Promise.all([...kafIds].map((id) => getKafById(id)));
    const kafById = new Map(kafs.filter(Boolean).map((kaf) => [kaf.id, kaf]));
    return events.map((event) => {
        const responsible = parseIdList(event.responsible_ids).map((id) => people.get(id)?.name).filter(Boolean);
        const creator = people.get(Number(event.created_by));
        const reviewer = people.get(Number(event.review_author_id));
        let audience_name = '';
        if (event.target_audience_type === 'class' || event.target_audience_type === 'department') audience_name = kafById.get(Number(event.target_audience_id))?.name || '';
        if (event.target_audience_type === 'multiple_classes') audience_name = eventAudienceIds(event).map((id) => kafById.get(id)?.name).filter(Boolean).join(', ');
        if (event.target_audience_type === 'specific_users') audience_name = eventAudienceIds(event).map((id) => people.get(id)?.name).filter(Boolean).join(', ');
        return {
            ...event,
            creator_name: creator?.name || `Пользователь #${event.created_by}`,
            reviewer_name: reviewer?.name || null,
            responsible_names: responsible,
            audience_name
        };
    });
}

async function getEvent(eventId) {
    const [rows] = await pool.query(`
        SELECT e.*, et.name AS type_name
          FROM events e
          LEFT JOIN event_types et ON et.id = e.event_type_id
         WHERE e.id = ?
         LIMIT 1
    `, [Number(eventId)]);
    return rows[0] || null;
}

async function getEvents(where = '', params = []) {
    const [rows] = await pool.query(`
        SELECT e.*, et.name AS type_name,
               (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) AS participants_count
          FROM events e
          LEFT JOIN event_types et ON et.id = e.event_type_id
          ${where}
         ORDER BY e.start_datetime ASC, e.id DESC
    `, params);
    return enrichEvents(rows);
}

export async function eventVisibleTo(event, actor, children = null) {
    if (actor.type === 5 || sameUserId(event.created_by, actor.id)) return true;
    if (Number(event.is_admin_event)) return false;
    if (!visibleStatuses.has(event.status)) return false;
    const targets = actor.type === 6 ? (children || await getChildrenForParent(actor.id)) : [actor];
    if (event.target_audience_type === 'all') return true;
    if (event.target_audience_type === 'specific_users') return eventAudienceIds(event).some((id) => targets.some((target) => target.id === id));
    if (event.target_audience_type === 'class') return targets.some((target) => Number(target.kaf) === Number(event.target_audience_id));
    if (event.target_audience_type === 'multiple_classes') return eventAudienceIds(event).some((id) => targets.some((target) => Number(target.kaf) === id));
    if (event.target_audience_type === 'department') return targets.some((target) => Number(target.kaf) === Number(event.target_audience_id));
    if (event.target_audience_type === 'parallel') return targets.some((target) => parallelFromName(target.kaf_name) === String(event.target_audience_id));
    return false;
}

async function visibleEventsFor(actor, { includeArchived = false } = {}) {
    const events = await getEvents();
    const children = actor.type === 6 ? await getChildrenForParent(actor.id) : null;
    const filtered = [];
    for (const event of events) {
        if (!includeArchived && ['REJECTED', 'CANCELED', 'COMPLETED'].includes(event.status) && actor.type !== 5 && !sameUserId(event.created_by, actor.id)) continue;
        if (await eventVisibleTo(event, actor, children)) filtered.push(event);
    }
    return filtered;
}

const archivedEventStatuses = new Set(['REJECTED', 'CANCELED', 'COMPLETED']);

function normalizedEventStatus(value) {
    const status = String(value || 'all').toUpperCase();
    if (status === 'WAITING') return 'WAITING_ADMIN';
    return ['APPROVED', 'WAITING_ADMIN', 'REJECTED', 'CANCELED', 'COMPLETED', 'DRAFT', 'all'].includes(status) ? status : 'all';
}

export function shouldPublishAfterApproval(pendingApprovals) {
    return Number(pendingApprovals) === 0;
}

async function participantsByEvent(eventIds) {
    if (!eventIds.length) return new Map();
    const [rows] = await pool.query(
        `SELECT event_id, user_id FROM event_participants WHERE event_id IN (${eventIds.map(() => '?').join(',')})`,
        eventIds
    );
    const result = new Map();
    for (const row of rows) result.set(Number(row.event_id), [...(result.get(Number(row.event_id)) || []), Number(row.user_id)]);
    return result;
}

export async function workspaceEventsFor(actor, query = {}) {
    const view = normalizeWorkspaceView(query.view || query.scope || 'calendar', actor);
    const scope = workspaceScopeForView(view);
    const needsArchive = ['archive', 'reviews'].includes(scope) || ['REJECTED', 'CANCELED', 'COMPLETED'].includes(normalizedEventStatus(query.status));
    let events = await visibleEventsFor(actor, { includeArchived: needsArchive });

    if (scope === 'moderation') {
        events = actor.type === 5 ? (await getEvents("WHERE e.status = 'WAITING_ADMIN'")) : [];
    } else if (scope === 'archive') {
        events = events.filter((event) => archivedEventStatuses.has(event.status));
    } else if (scope === 'reviews') {
        events = events.filter((event) => event.review_text);
    } else if (scope === 'mine') {
        const participants = await participantsByEvent(events.map((event) => event.id));
        if (actor.type === 1) {
            events = events.filter((event) => sameUserId(event.created_by, actor.id) || (participants.get(Number(event.id)) || []).some((id) => sameUserId(id, actor.id)));
        } else if (actor.type === 6) {
            const children = await getChildrenForParent(actor.id);
            const childIds = new Set(children.map((child) => Number(child.id)));
            events = events.filter((event) => (participants.get(Number(event.id)) || []).some((id) => childIds.has(Number(id))));
        } else {
            events = events.filter((event) => sameUserId(event.created_by, actor.id));
        }
    } else if (scope === 'children') {
        if (actor.type !== 6) return [];
        const children = await getChildrenForParent(actor.id);
        const childById = new Map(children.map((child) => [Number(child.id), child]));
        const participants = await participantsByEvent(events.map((event) => event.id));
        events = events.map((event) => {
            const participant = (participants.get(Number(event.id)) || []).find((id) => childById.has(Number(id)));
            return { ...event, child_name: participant ? childById.get(Number(participant)).name : null };
        });
    }

    const status = normalizedEventStatus(query.status);
    const typeId = Number(query.type);
    const search = String(query.search || '').trim().toLocaleLowerCase('ru-RU');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? `${query.from}T00:00:00` : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? `${query.to}T23:59:59` : null;
    const filtered = events.filter((event) => {
        if (status !== 'all' && event.status !== status) return false;
        if (Number.isSafeInteger(typeId) && typeId > 0 && Number(event.event_type_id) !== typeId) return false;
        const start = String(event.start_datetime || '').replace(' ', 'T');
        if (from && start < from) return false;
        if (to && start > to) return false;
        if (search) return [event.title, event.description, event.location, event.type_name, event.creator_name, event.audience_name]
            .some((value) => String(value || '').toLocaleLowerCase('ru-RU').includes(search));
        return true;
    });
    const sort = String(query.sort || 'start_asc');
    return filtered.sort((left, right) => {
        if (sort === 'start_desc') return String(right.start_datetime).localeCompare(String(left.start_datetime));
        if (sort === 'title') return String(left.title).localeCompare(String(right.title), 'ru');
        return String(left.start_datetime).localeCompare(String(right.start_datetime));
    });
}

export async function workspaceEventPageFor(actor, query = {}) {
    const items = await workspaceEventsFor(actor, query);
    const pageSize = Math.min(Math.max(Number(query.page_size) || 24, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const start = (page - 1) * pageSize;
    const counts = items.reduce((result, event) => {
        result.all += 1;
        result[event.status] = (result[event.status] || 0) + 1;
        return result;
    }, { all: 0 });
    return {
        items: items.slice(start, start + pageSize),
        total: items.length,
        page,
        page_size: pageSize,
        counts,
        range: { from: String(query.from || ''), to: String(query.to || '') }
    };
}

async function createNotification(userId, eventId, type, message) {
    try {
        await pool.query(
            'INSERT INTO notifications (user_id, event_id, type, message) VALUES (?, ?, ?, ?)',
            [Number(userId), eventId ? Number(eventId) : null, type, message]
        );
    } catch (error) {
        mlog('[ERROR]', 'Не удалось сохранить уведомление', error.code || error.message);
    }
}

async function notifyAdmins(eventId, type, message, exceptId = null) {
    const admins = await getCalendarAdmins();
    await Promise.all(admins.filter((admin) => admin.id !== exceptId).map((admin) => createNotification(admin.id, eventId, type, message)));
}

async function formData() {
    const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
    const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
    const [classes, departments, users] = await Promise.all([listClasses(), listDepartments(), listActiveUsers()]);
    return { types, subjects, classes, departments, users };
}

async function normalizeEventInput(body, validationContext = null) {
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim() || null;
    if (!title || title.length > 100 || description?.length > 500) throw new Error('Проверьте название и описание мероприятия');
    const eventTypeId = Number(body.event_type_id);
    if (validationContext?.eventTypeIds) {
        if (!validationContext.eventTypeIds.has(eventTypeId)) throw new Error('Выберите существующий тип мероприятия');
    } else {
        const [eventTypes] = await pool.query('SELECT id FROM event_types WHERE id = ?', [eventTypeId]);
        if (!eventTypes.length) throw new Error('Выберите существующий тип мероприятия');
    }
    const subjectId = body.subject_id ? Number(body.subject_id) : null;
    if (subjectId) {
        if (validationContext?.subjectIds) {
            if (!validationContext.subjectIds.has(subjectId)) throw new Error('Выберите существующий предмет');
        } else {
            const [subjects] = await pool.query('SELECT id FROM subjects WHERE id = ?', [subjectId]);
            if (!subjects.length) throw new Error('Выберите существующий предмет');
        }
    }
    const start = toSqlDateTime(body.start_datetime, 'начала');
    const end = toSqlDateTime(body.end_datetime, 'окончания');
    if (new Date(start.replace(' ', 'T')) >= new Date(end.replace(' ', 'T'))) throw new Error('Дата начала должна быть раньше даты окончания');
    const audienceType = String(body.target_audience_type || '');
    if (!audienceTypes.has(audienceType)) throw new Error('Некорректная аудитория мероприятия');
    const rawAudience = audienceType === 'specific_users' || audienceType === 'multiple_classes' ? body.target_audience_ids : body.target_audience_id;
    let audienceId = null;
    if (audienceType === 'class') {
        const classId = Number(rawAudience);
        if (validationContext?.classIds ? !validationContext.classIds.has(classId) : !(await getKafById(classId, 1))) throw new Error('Выберите существующий класс');
        audienceId = String(classId);
    } else if (audienceType === 'department') {
        const kaf = await getKafById(rawAudience, 2);
        if (!kaf) throw new Error('Выберите существующую кафедру');
        audienceId = String(kaf.id);
    } else if (audienceType === 'parallel') {
        const parallel = String(rawAudience || '').trim();
        const classes = validationContext?.classes || await listClasses();
        if (!parallel || !classes.some((item) => parallelFromName(item.name) === parallel)) throw new Error('Выберите существующую параллель');
        audienceId = parallel;
    } else if (audienceType === 'multiple_classes') {
        const ids = parseIdList(rawAudience);
        const valid = validationContext?.classIds ? ids.every((id) => validationContext.classIds.has(id)) : (await Promise.all(ids.map((id) => getKafById(id, 1)))).every(Boolean);
        if (!ids.length || !valid) throw new Error('Выберите существующие классы');
        audienceId = ids.join(',');
    } else if (audienceType === 'specific_users') {
        const ids = parseIdList(rawAudience);
        if (!ids.length) throw new Error('Выберите хотя бы одного пользователя');
        await assertActiveUsers(ids);
        audienceId = ids.join(',');
    }
    const responsibleIds = parseIdList(body.responsible_ids);
    if (!responsibleIds.length) throw new Error('Выберите хотя бы одного ответственного');
    if (validationContext?.staffUserIds) {
        if (!responsibleIds.every((id) => validationContext.staffUserIds.has(id))) throw new Error('Выбранный пользователь недоступен в SSO');
    } else {
        await assertActiveUsers(responsibleIds, STAFF_ROLE_IDS);
    }
    const departmentId = body.department_id ? Number(body.department_id) : null;
    if (departmentId && !(await getKafById(departmentId, 2))) throw new Error('Указана несуществующая кафедра');
    const rewardType = body.enable_rewards ? String(body.reward_type || 'educational') : 'none';
    if (!rewardTypes.has(rewardType)) throw new Error('Некорректная награда');
    const rewardPlaces = rewardType === 'competitive' ? Number(body.places_count || 3) : null;
    if (rewardPlaces != null && (!Number.isInteger(rewardPlaces) || rewardPlaces < 1 || rewardPlaces > 100)) throw new Error('Некорректное количество призовых мест');
    return {
        title,
        description,
        eventTypeId,
        departmentId,
        subjectId,
        start,
        end,
        location: String(body.location || '').trim().slice(0, 255) || null,
        level: levels.has(body.level) ? body.level : 'school',
        audienceType,
        audienceId,
        isAdminEvent: body.is_admin_event ? 1 : 0,
        registrationEnabled: body.is_registration_enabled ? 1 : 0,
        rewardType,
        rewardPlaces,
        responsibleIds: responsibleIds.join(',')
    };
}

async function resetApprovals(connection, eventId, admins) {
    if (!admins.length) throw new Error('В SSO нет назначенных администраторов Calendar');
    await connection.query('DELETE FROM event_approvals WHERE event_id = ?', [eventId]);
    for (const admin of admins) {
        await connection.query(
            "INSERT INTO event_approvals (event_id, user_id, role_type, status, order_index) VALUES (?, ?, 'admin', 'pending', 0)",
            [eventId, admin.id]
        );
    }
}

async function insertEventAwaitingApproval(connection, input, creatorId, admins) {
    const [result] = await connection.query(`
        INSERT INTO events (title, description, event_type_id, department_id, subject_id, start_datetime, end_datetime, location, level, status, target_audience_type, target_audience_id, is_admin_event, is_registration_enabled, reward_type, reward_places, created_by, responsible_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_ADMIN', ?, ?, ?, ?, ?, ?, ?, ?)
    `, [input.title, input.description, input.eventTypeId, input.departmentId, input.subjectId, input.start, input.end, input.location, input.level, input.audienceType, input.audienceId, input.isAdminEvent, input.registrationEnabled, input.rewardType, input.rewardPlaces, creatorId, input.responsibleIds]);
    await resetApprovals(connection, result.insertId, admins);
    return Number(result.insertId);
}

function resolveYearPlanAudience(record, classes) {
    if (record.audienceAll) return { type: 'all', ids: [] };
    const classIds = classes
        .filter((item) => record.grades.includes(Number(parallelFromName(item.name))))
        .map((item) => Number(item.id));
    const missingGrades = record.grades.filter((grade) => !classIds.some((id) => {
        const classItem = classes.find((item) => Number(item.id) === id);
        return Number(parallelFromName(classItem?.name)) === grade;
    }));
    if (missingGrades.length) {
        throw importError(`Строка CSV ${record.sourceRows.join(', ')}: в SSO нет активного класса для параллели ${missingGrades.join(', ')}.`);
    }
    return { type: 'multiple_classes', ids: [...new Set(classIds)] };
}

async function prepareYearPlanImport(csv, fileName, actor) {
    assertYearPlanImportActor(actor);
    const { snapshotHash, records } = buildYearPlanImportRecords(csv, fileName);
    const [[eventTypes], classes, staff, admins] = await Promise.all([
        pool.query('SELECT id, name FROM event_types WHERE name = ?', [YEAR_PLAN_IMPORT.defaultEventType]),
        listClasses(),
        listActiveUsers(STAFF_ROLE_IDS),
        getCalendarAdmins()
    ]);
    const eventType = eventTypes[0];
    if (!eventType) throw importError(`В Calendar отсутствует тип мероприятия «${YEAR_PLAN_IMPORT.defaultEventType}».`);
    if (!admins.length) throw importError('В SSO нет назначенных администраторов Calendar.');
    const staffUserIds = new Set(staff.map((item) => Number(item.id)));
    if (!staffUserIds.has(Number(actor.id))) throw importError('Учётная запись Юниковой Марины недоступна среди активных сотрудников SSO.', 403);
    const validationContext = {
        eventTypeIds: new Set([Number(eventType.id)]),
        classIds: new Set(classes.map((item) => Number(item.id))),
        classes,
        staffUserIds
    };
    const preparedRecords = [];
    for (const record of records) {
        const audience = resolveYearPlanAudience(record, classes);
        const input = await normalizeEventInput({
            title: record.title,
            description: record.description,
            event_type_id: eventType.id,
            start_datetime: `${record.sourceDate}T09:00`,
            end_datetime: `${record.sourceDate}T18:00`,
            target_audience_type: audience.type,
            target_audience_ids: audience.ids.join(','),
            responsible_ids: String(actor.id),
            level: 'school'
        }, validationContext);
        preparedRecords.push({ ...record, input, audience });
    }
    const marker = `Импорт: ${YEAR_PLAN_IMPORT.sourceName}/${YEAR_PLAN_IMPORT.sheetName}; SHA-256=${snapshotHash};`;
    const [existing] = await pool.query('SELECT id FROM events WHERE description LIKE ? LIMIT 1', [`${marker}%`]);
    if (existing.length) throw importError('Этот CSV-снимок уже был импортирован. Повторный запуск не создаёт дубли.', 409);
    return { snapshotHash, marker, records: preparedRecords, admins };
}

function yearPlanImportSummary(prepared) {
    return {
        events: prepared.records.length,
        notes: prepared.records.filter((record) => record.sourceColumns.length === 1 && record.sourceColumns[0] === 'комментарии').length,
        allAudience: prepared.records.filter((record) => record.audience.type === 'all').length,
        multipleClasses: prepared.records.filter((record) => record.audience.type === 'multiple_classes').length,
        sourceRows: [...new Set(prepared.records.flatMap((record) => record.sourceRows))].length,
        startsAt: YEAR_PLAN_IMPORT.startDate,
        defaultTime: '09:00–18:00'
    };
}

async function autoCompleteEvents() {
    try {
        const [events] = await pool.query("SELECT id, title, created_by FROM events WHERE status = 'APPROVED' AND end_datetime < NOW()");
        for (const event of events) {
            await pool.query("UPDATE events SET status = 'COMPLETED' WHERE id = ? AND status = 'APPROVED'", [event.id]);
            await createNotification(event.created_by, event.id, 'completed', `Мероприятие «${event.title}» автоматически завершено.`);
            const [participants] = await pool.query('SELECT user_id FROM event_participants WHERE event_id = ?', [event.id]);
            await Promise.all(participants.filter((item) => item.user_id !== event.created_by).map((item) => createNotification(item.user_id, event.id, 'completed', `Мероприятие «${event.title}» завершено.`)));
        }
    } catch (error) {
        mlog('[ERROR]', 'Автозавершение мероприятий', error.code || error.message);
    }
}

async function sendEventReminders() {
    try {
        const [events] = await pool.query(`
            SELECT id, title, start_datetime, created_by FROM events
             WHERE status = 'APPROVED'
               AND start_datetime > NOW()
               AND start_datetime <= DATE_ADD(NOW(), INTERVAL 1 HOUR)
        `);
        for (const event of events) {
            const [participants] = await pool.query('SELECT user_id FROM event_participants WHERE event_id = ?', [event.id]);
            const recipients = new Set([event.created_by, ...participants.map((item) => item.user_id)]);
            for (const recipient of recipients) {
                const [existing] = await pool.query("SELECT id FROM notifications WHERE event_id = ? AND user_id = ? AND type = 'reminder'", [event.id, recipient]);
                if (!existing.length) await createNotification(recipient, event.id, 'reminder', `Напоминание: мероприятие «${event.title}» начнётся в ${event.start_datetime}.`);
            }
        }
    } catch (error) {
        mlog('[ERROR]', 'Напоминания о мероприятиях', error.code || error.message);
    }
}

if (process.env.NODE_ENV !== 'test') {
    cron.schedule('0 * * * *', autoCompleteEvents);
    cron.schedule('*/15 * * * *', sendEventReminders);
}

app.get('/', requirePageAuth, async (req, res) => {
    try {
        const actor = user(req);
        const [[types], [pendingRows]] = await Promise.all([
            pool.query('SELECT * FROM event_types ORDER BY name'),
            actor.permissions?.moderate_event
                ? pool.query("SELECT COUNT(*) AS count FROM events WHERE status = 'WAITING_ADMIN'")
                : Promise.resolve([[{ count: 0 }]])
        ]);
        const pendingCount = Number(pendingRows[0]?.count || 0);
        const view = workspaceViewFromQuery(req.query, actor, pendingCount);
        const navigation = workspaceNavigation(actor, { pendingCount, unreadCount: res.locals.unreadCount });
        const mobileNavigation = [
            navigation.find((item) => item.view === 'calendar'),
            navigation.find((item) => item.view === 'moderation') || navigation.find((item) => item.view === 'children') || navigation.find((item) => item.view === 'mine'),
            navigation.find((item) => item.view === 'notifications')
        ].filter(Boolean).map((item) => ({ ...item, isActive: item.view === view }));
        res.render('calendar/index', {
            title: 'Календарь мероприятий',
            types,
            workspaceNavigation: navigation.map((item) => ({ ...item, isActive: item.view === view })),
            workspaceMobileNavigation: mobileNavigation,
            workspaceState: {
            view,
            scope: workspaceScopeForView(view),
            panel: '',
            event: Number(req.query.event) || null,
            compose: String(req.query.compose || ''),
            search: String(req.query.search || ''),
            status: normalizedEventStatus(req.query.status),
            type: Number(req.query.type) || null,
            from: String(req.query.from || ''),
            to: String(req.query.to || '')
        }
        });
    } catch (error) {
        mlog('[ERROR]', 'Загрузка календаря', error.code || error.message);
        pageError(res, 500, 'Ошибка сервера');
    }
});

app.get('/admin/settings', requirePageAuth, requirePermission('manage_settings'), (req, res) => workspaceRedirect(req, res, { panel: 'settings' }));

app.get('/events/create', requirePageAuth, requirePermission('create_event'), (req, res) => workspaceRedirect(req, res, { compose: 'create' }));

app.get('/events/import/year-plan', requirePageAuth, requirePermission('create_event'), (req, res) => {
    try {
        assertYearPlanImportActor(user(req));
        workspaceRedirect(req, res, { panel: 'import' });
    } catch (error) {
        pageError(res, error.status || 400, error.message || 'Импорт недоступен');
    }
});

app.post('/api/events/import/year-plan/preview', requireApiAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const prepared = await prepareYearPlanImport(req.body?.csv, req.body?.fileName, user(req));
        const preview = createImportPreviewToken(user(req).id, prepared.snapshotHash);
        res.json({
            success: true,
            snapshot: {
                source: `${YEAR_PLAN_IMPORT.sourceName}/${YEAR_PLAN_IMPORT.sheetName}`,
                fileName: String(req.body.fileName || ''),
                sha256: prepared.snapshotHash,
                startDate: YEAR_PLAN_IMPORT.startDate
            },
            summary: yearPlanImportSummary(prepared),
            preview,
            examples: prepared.records.slice(0, 8).map((record) => ({
                title: record.input.title,
                date: record.sourceDate,
                sourceRows: record.sourceRows,
                audience: record.audience.type === 'all' ? 'Все пользователи' : `Классы: ${record.audience.ids.length}`
            }))
        });
    } catch (error) {
        mlog('[ERROR]', 'Предпросмотр импорта годового графика', error.message);
        apiError(res, error.status || 400, error.message || 'Не удалось проверить CSV-снимок');
    }
});

app.post('/api/events/import/year-plan/commit', requireApiAuth, requirePermission('create_event'), async (req, res) => {
    let connection;
    try {
        assertYearPlanImportActor(user(req));
        const snapshot = buildYearPlanImportRecords(req.body?.csv, req.body?.fileName);
        verifyImportPreviewToken(user(req).id, snapshot.snapshotHash, req.body?.expiresAt, req.body?.signature);
        const prepared = await prepareYearPlanImport(req.body?.csv, req.body?.fileName, user(req));
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const manifestRecords = [];
        for (const record of prepared.records) {
            const eventId = await insertEventAwaitingApproval(connection, { ...record.input, isAdminEvent: 0 }, user(req).id, prepared.admins);
            manifestRecords.push({
                eventId,
                sourceRows: record.sourceRows,
                sourceColumns: record.sourceColumns,
                sourceValues: record.sourceValues,
                sourceDate: record.sourceDate,
                title: record.input.title
            });
        }
        await connection.commit();
        connection.release();
        connection = null;
        const summary = yearPlanImportSummary(prepared);
        const notificationText = `Импорт графика «${YEAR_PLAN_IMPORT.sheetName}» завершён: ${summary.events} мероприятий ожидают модерации.`;
        await Promise.all(prepared.admins.map((admin) => createNotification(admin.id, null, 'year_plan_import', notificationText)));
        res.json({
            success: true,
            summary,
            manifest: {
                source: YEAR_PLAN_IMPORT.sourceName,
                sheet: YEAR_PLAN_IMPORT.sheetName,
                fileName: String(req.body.fileName || ''),
                sha256: prepared.snapshotHash,
                importedAt: new Date().toISOString(),
                createdBy: { id: Number(user(req).id), name: user(req).name },
                records: manifestRecords
            }
        });
    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (rollbackError) { mlog('[ERROR]', 'Откат импорта годового графика', rollbackError.message); }
        }
        mlog('[ERROR]', 'Импорт годового графика', error.message);
        apiError(res, error.status || 400, error.message || 'Не удалось импортировать CSV-снимок');
    } finally {
        if (connection) connection.release();
    }
});

app.post('/events/create', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const input = await normalizeEventInput(req.body);
        const admins = await getCalendarAdmins();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const eventId = await insertEventAwaitingApproval(connection, { ...input, isAdminEvent: user(req).type === 5 ? input.isAdminEvent : 0 }, user(req).id, admins);
            await connection.commit();
            await notifyAdmins(eventId, 'new_event', `Новое мероприятие «${input.title}» ожидает утверждения администраторами.`);
            workspaceRedirect(req, res, { event: eventId, scope: 'mine' });
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    } catch (error) { mlog('[ERROR]', 'Создание мероприятия', error.message); pageError(res, 400, error.message || 'Ошибка сервера'); }
});

async function renderEventForm(req, res, view, title) {
    const event = await getEvent(req.params.id);
    if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return pageError(res, 404, 'Мероприятие не найдено или доступ запрещён');
    const selectedIds = event.target_audience_type === 'specific_users' ? parseIdList(event.target_audience_id) : [];
    const selectedClassIds = event.target_audience_type === 'multiple_classes' ? parseIdList(event.target_audience_id) : [];
    res.render(view, { title, event, ...(await formData()), selectedIds, selectedClassIds, selectedResponsibleIds: parseIdList(event.responsible_ids) });
}

app.get('/events/copy/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return pageError(res, 404, 'Мероприятие не найдено или доступ запрещён');
        workspaceRedirect(req, res, { event: event.id, compose: 'copy', scope: 'archive' });
    } catch (error) { pageError(res, 500, 'Ошибка загрузки мероприятия'); }
});

app.get('/events/edit/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return pageError(res, 404, 'Мероприятие не найдено или доступ запрещён');
        workspaceRedirect(req, res, { event: event.id, compose: 'edit' });
    } catch (error) { pageError(res, 500, 'Ошибка загрузки мероприятия'); }
});

app.post('/events/edit/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return pageError(res, 403, 'Доступ запрещён');
        if (!editableStatuses.has(event.status)) return pageError(res, 400, 'Редактировать можно только ожидающее или отклонённое мероприятие');
        const input = await normalizeEventInput(req.body);
        const admins = await getCalendarAdmins();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(`UPDATE events SET title=?, description=?, event_type_id=?, department_id=?, subject_id=?, start_datetime=?, end_datetime=?, location=?, level=?, target_audience_type=?, target_audience_id=?, is_admin_event=?, is_registration_enabled=?, reward_type=?, reward_places=?, responsible_ids=?, status='WAITING_ADMIN', approved_by=NULL, rejection_reason=NULL, rejected_by=NULL, rejected_at=NULL WHERE id=?`, [input.title, input.description, input.eventTypeId, input.departmentId, input.subjectId, input.start, input.end, input.location, input.level, input.audienceType, input.audienceId, user(req).type === 5 ? input.isAdminEvent : 0, input.registrationEnabled, input.rewardType, input.rewardPlaces, input.responsibleIds, event.id]);
            await resetApprovals(connection, event.id, admins);
            await connection.commit();
            await notifyAdmins(event.id, 'edited', `Мероприятие «${input.title}» изменено и снова ожидает утверждения.`);
            workspaceRedirect(req, res, { event: event.id, scope: 'mine' });
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    } catch (error) { mlog('[ERROR]', 'Редактирование мероприятия', error.message); pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.get('/my-events', requirePageAuth, async (req, res) => {
    workspaceRedirect(req, res, { scope: 'mine' });
});

app.get('/child-events', requirePageAuth, requirePermission('view_children'), async (req, res) => {
    workspaceRedirect(req, res, { scope: 'children' });
});

app.get('/events/moderation', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    workspaceRedirect(req, res, { scope: 'moderation' });
});

async function approvalsForEvents(eventIds) {
    if (!eventIds.length) return new Map();
    const [rows] = await pool.query(`SELECT event_id, user_id, role_type, status, comment, updated_at FROM event_approvals WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY order_index, id`, eventIds);
    const people = userNameMap(await getActiveUsersByIds(rows.map((row) => row.user_id)));
    const result = new Map();
    for (const row of rows) {
        const value = { ...row, user_name: people.get(Number(row.user_id))?.name || `Пользователь #${row.user_id}` };
        const group = result.get(Number(row.event_id)) || [];
        group.push(value);
        result.set(Number(row.event_id), group);
    }
    return result;
}

function moderationOutcome(status) {
    const outcomes = {
        APPROVED: {
            statusClass: 'approved',
            title: 'Мероприятие утверждено и опубликовано',
            message: 'Оно уже доступно целевой аудитории в календаре.',
            nextHref: '/',
            nextLabel: 'Открыть календарь'
        },
        REJECTED: {
            statusClass: 'rejected',
            title: 'Мероприятие отклонено',
            message: 'Создатель получил уведомление с причиной и может исправить заявку.',
            nextHref: '/events/moderation',
            nextLabel: 'Вернуться к очереди'
        },
        CANCELED: {
            statusClass: 'canceled',
            title: 'Мероприятие отменено',
            message: 'Оно больше не находится в очереди модерации.',
            nextHref: '/events/moderation',
            nextLabel: 'Вернуться к очереди'
        },
        COMPLETED: {
            statusClass: 'completed',
            title: 'Мероприятие завершено',
            message: 'Оно находится в архиве мероприятий.',
            nextHref: '/events/archive',
            nextLabel: 'Открыть архив'
        },
        WAITING_ADMIN: {
            statusClass: 'waiting',
            title: 'Мероприятие ожидает решения',
            message: 'Откройте очередь модерации, чтобы утвердить или отклонить его.',
            nextHref: '/events/moderation',
            nextLabel: 'Открыть очередь'
        }
    };
    return outcomes[status] || {
        statusClass: 'draft',
        title: 'Статус мероприятия изменился',
        message: 'Проверьте актуальную информацию в календаре.',
        nextHref: '/',
        nextLabel: 'Открыть календарь'
    };
}

app.get('/events/moderation/result/:id', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event) return pageError(res, 404, 'Мероприятие не найдено');
        workspaceRedirect(req, res, { event: event.id, scope: event.status === 'WAITING_ADMIN' ? 'moderation' : 'all' });
    } catch (error) { pageError(res, 500, 'Не удалось получить результат модерации'); }
});

app.post('/events/admin-approve/:id', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    const eventId = Number(req.params.id);
    try {
        const connection = await pool.getConnection();
        let event;
        let publishedNow = false;
        try {
            await connection.beginTransaction();
            const [events] = await connection.query('SELECT id, title, created_by, status FROM events WHERE id = ? FOR UPDATE', [eventId]);
            event = events[0];
            if (!event) throw new Error('Мероприятие не найдено');
            if (event.status === 'WAITING_ADMIN') {
                const [approvals] = await connection.query("SELECT id, status FROM event_approvals WHERE event_id = ? AND user_id = ? AND role_type = 'admin' FOR UPDATE", [eventId, user(req).id]);
                let approval = approvals[0];
                if (!approval) {
                    const [result] = await connection.query("INSERT INTO event_approvals (event_id, user_id, role_type, status, order_index) VALUES (?, ?, 'admin', 'approved', 0)", [eventId, user(req).id]);
                    approval = { id: result.insertId, status: 'approved' };
                } else if (!['pending', 'approved'].includes(approval.status)) {
                    throw new Error('У вас нет права утвердить мероприятие');
                }
                if (approval.status === 'pending') {
                    await connection.query("UPDATE event_approvals SET status = 'approved' WHERE id = ?", [approval.id]);
                }
                const [pending] = await connection.query("SELECT COUNT(*) AS count FROM event_approvals WHERE event_id = ? AND role_type = 'admin' AND status = 'pending'", [eventId]);
                if (shouldPublishAfterApproval(pending[0]?.count)) {
                    const [update] = await connection.query("UPDATE events SET status = 'APPROVED', approved_by = ? WHERE id = ? AND status = 'WAITING_ADMIN'", [user(req).id, eventId]);
                    publishedNow = update.affectedRows === 1;
                }
            }
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        if (publishedNow) {
            await createNotification(event.created_by, eventId, 'approved', `Мероприятие «${event.title}» утверждено и опубликовано.`);
            await notifyAdmins(eventId, 'approved', `Мероприятие «${event.title}» утверждено и опубликовано.`, user(req).id);
        }
        workspaceRedirect(req, res, { event: eventId, scope: publishedNow ? 'all' : 'moderation' });
    } catch (error) { pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.post('/events/reject/:id', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    const eventId = Number(req.params.id);
    const reason = String(req.body.rejection_reason || '').trim().slice(0, 500) || 'Без указания причины';
    try {
        const connection = await pool.getConnection();
        let event;
        let rejectedNow = false;
        try {
            await connection.beginTransaction();
            const [events] = await connection.query('SELECT id, title, created_by, status FROM events WHERE id = ? FOR UPDATE', [eventId]);
            event = events[0];
            if (!event) throw new Error('Мероприятие не найдено');
            if (event.status === 'WAITING_ADMIN') {
                const [approvals] = await connection.query("SELECT id, status FROM event_approvals WHERE event_id = ? AND user_id = ? AND role_type = 'admin' FOR UPDATE", [eventId, user(req).id]);
                const approval = approvals[0];
                if (!approval) {
                    await connection.query("INSERT INTO event_approvals (event_id, user_id, role_type, status, comment, order_index) VALUES (?, ?, 'admin', 'rejected', ?, 0)", [eventId, user(req).id, reason]);
                } else {
                    if (approval.status !== 'pending') throw new Error('У вас нет права отклонить мероприятие');
                    await connection.query("UPDATE event_approvals SET status = 'rejected', comment = ? WHERE id = ?", [reason, approval.id]);
                }
                await connection.query("UPDATE events SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), rejection_reason = ? WHERE id = ?", [user(req).id, reason, eventId]);
                rejectedNow = true;
            }
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        if (rejectedNow) {
            await createNotification(event.created_by, eventId, 'rejected', `Мероприятие «${event.title}» отклонено. Причина: ${reason}`);
            await notifyAdmins(eventId, 'rejected', `Мероприятие «${event.title}» отклонено администратором ${user(req).name}.`, user(req).id);
        }
        workspaceRedirect(req, res, { event: eventId, scope: 'archive' });
    } catch (error) { pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.post('/events/resend/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !sameUserId(event.created_by, user(req).id) || event.status !== 'REJECTED') return pageError(res, 400, 'Можно повторно отправить только своё отклонённое мероприятие');
        const admins = await getCalendarAdmins();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query("UPDATE events SET status = 'WAITING_ADMIN', rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?", [event.id]);
            await resetApprovals(connection, event.id, admins);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        await notifyAdmins(event.id, 'resubmitted', `Мероприятие «${event.title}» повторно отправлено на утверждение.`);
        workspaceRedirect(req, res, { event: event.id, scope: 'mine' });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/events/archive', requirePageAuth, async (req, res) => {
    workspaceRedirect(req, res, { scope: 'archive' });
});

app.get('/analytics', requirePageAuth, requirePermission('view_analytics'), async (req, res) => {
    workspaceRedirect(req, res, { panel: 'analytics' });
});

app.get('/api/events', requireApiAuth, async (req, res) => {
    try { res.json(await workspaceEventsFor(user(req), req.query)); }
    catch (error) { mlog('[ERROR]', 'API событий', error.message); apiError(res, 500, 'Ошибка сервера'); }
});

app.get('/api/workspace/events', requireApiAuth, async (req, res) => {
    try { res.json(await workspaceEventPageFor(user(req), req.query)); }
    catch (error) { mlog('[ERROR]', 'API представления событий', error.message); apiError(res, 500, 'Не удалось загрузить события'); }
});

app.get('/api/workspace', requireApiAuth, async (req, res) => {
    try {
        const actor = user(req);
        const [types, allEvents, unreadRows] = await Promise.all([
            pool.query('SELECT id, name FROM event_types ORDER BY name').then(([rows]) => rows),
            visibleEventsFor(actor, { includeArchived: true }),
            pool.query('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0', [actor.id]).then(([rows]) => rows)
        ]);
        const [children, teachers] = await Promise.all([
            actor.type === 6 ? getChildrenForParent(actor.id) : [],
            actor.type === 5 ? listActiveUsers([2, 3, 4]) : []
        ]);
        const counts = {
            all: allEvents.length,
            approved: allEvents.filter((event) => event.status === 'APPROVED').length,
            pending: allEvents.filter((event) => event.status === 'WAITING_ADMIN').length,
            archive: allEvents.filter((event) => archivedEventStatuses.has(event.status)).length,
            reviews: allEvents.filter((event) => event.review_text).length
        };
        const unreadCount = Number(unreadRows[0]?.count || 0);
        res.json({
            user: { id: actor.id, name: actor.name, type: actor.type, role_name: actor.role_name, permissions: actor.permissions },
            types,
            children: children.map((child) => ({ id: child.id, name: child.name, class_name: child.kaf_name || '' })),
            teachers: teachers.map((teacher) => ({ id: teacher.id, name: teacher.name })),
            can_import_year_plan: canImportYearPlan(actor),
            default_view: workspaceDefaultView(actor, counts.pending),
            navigation: workspaceNavigation(actor, { pendingCount: counts.pending, unreadCount }),
            unread_count: unreadCount,
            contextual_counts: {
                visible: counts.all,
                upcoming: allEvents.filter((event) => new Date(event.start_datetime).getTime() >= Date.now() && event.status === 'APPROVED').length,
                pending: counts.pending
            },
            counts
        });
    } catch (error) { apiError(res, 500, 'Не удалось загрузить рабочее пространство'); }
});

app.get('/api/event-form-options', requireApiAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const options = await formData();
        res.json({
            ...options,
            defaults: {
                responsible_ids: [Number(user(req).id)],
                level: 'school',
                target_audience_type: 'class'
            }
        });
    } catch (error) { apiError(res, 500, 'Не удалось загрузить форму мероприятия'); }
});

app.get('/api/workspace/settings', requireApiAuth, requirePermission('manage_settings'), async (req, res) => {
    try {
        const [classes, departments, subjects, eventTypes] = await Promise.all([
            listClasses(), listDepartments(), pool.query('SELECT * FROM subjects ORDER BY name').then(([rows]) => rows), pool.query('SELECT * FROM event_types ORDER BY name').then(([rows]) => rows)
        ]);
        res.json({ classes, departments, subjects, event_types: eventTypes });
    } catch (error) { apiError(res, 500, 'Не удалось загрузить справочники'); }
});

app.get('/api/notifications', requireApiAuth, async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [user(req).id, limit]);
        res.json(rows);
    } catch (error) { apiError(res, 500, 'Не удалось загрузить уведомления'); }
});

app.post('/api/notifications/mark-all-read', requireApiAuth, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user(req).id]);
        res.json({ success: true });
    } catch (error) { apiError(res, 500, 'Не удалось обновить уведомления'); }
});

app.post('/api/notifications/:id/read', requireApiAuth, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [Number(req.params.id), user(req).id]);
        res.json({ success: true });
    } catch (error) { apiError(res, 500, 'Не удалось обновить уведомление'); }
});

app.get('/api/events/:id', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return apiError(res, 404, 'Мероприятие не найдено');
        res.json((await enrichEvents([event]))[0]);
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.get('/api/events/:id/approvals', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return apiError(res, 404, 'Мероприятие не найдено');
        res.json((await approvalsForEvents([event.id])).get(event.id) || []);
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

async function participantForRequest(req, event) {
    if (user(req).type !== 6) return user(req).id;
    const children = await getChildrenForParent(user(req).id);
    const requested = Number(req.body?.child_id);
    const requestedChild = children.find((child) => child.id === requested);
    if (requestedChild && await eventVisibleTo(event, requestedChild)) return requestedChild.id;
    if (children.length === 1 && await eventVisibleTo(event, children[0])) return children[0].id;
    throw new Error('Для записи выберите ребёнка, которому доступно мероприятие');
}

app.post('/api/events/:id/register', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !event.is_registration_enabled || !(await eventVisibleTo(event, user(req)))) return apiError(res, 403, 'Запись недоступна');
        const participantId = await participantForRequest(req, event);
        await assertActiveUsers([participantId]);
        await pool.query('INSERT INTO event_participants (event_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE registered_at = registered_at', [event.id, participantId]);
        res.json({ success: true, participant_id: participantId });
    } catch (error) { apiError(res, 400, error.message || 'Ошибка записи'); }
});

app.get('/api/events/:id/is-registered', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return apiError(res, 404, 'Мероприятие не найдено');
        const participantId = user(req).type === 6 ? Number(req.query.child_id) : user(req).id;
        const [rows] = await pool.query('SELECT id FROM event_participants WHERE event_id = ? AND user_id = ?', [event.id, participantId]);
        res.json({ registered: Boolean(rows.length) });
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.post('/api/events/:id/unregister', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return apiError(res, 404, 'Мероприятие не найдено');
        const participantId = await participantForRequest(req, event);
        await pool.query('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?', [event.id, participantId]);
        res.json({ success: true });
    } catch (error) { apiError(res, 400, error.message || 'Ошибка отмены записи'); }
});

app.get('/api/events/:id/participants', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return apiError(res, 404, 'Мероприятие не найдено');
        const [rows] = await pool.query('SELECT user_id, registered_at, attended FROM event_participants WHERE event_id = ? ORDER BY registered_at', [event.id]);
        const people = userNameMap(await getActiveUsersByIds(rows.map((row) => row.user_id)));
        res.json(rows.map((row) => ({ ...row, user_name: people.get(Number(row.user_id))?.name || `Пользователь #${row.user_id}`, class_name: people.get(Number(row.user_id))?.kaf_name || null })));
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.post('/api/events/:id/complete', requireApiAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return apiError(res, 403, 'Доступ запрещён');
        if (event.status !== 'APPROVED') return apiError(res, 400, 'Можно завершить только утверждённое мероприятие');
        await pool.query("UPDATE events SET status = 'COMPLETED' WHERE id = ?", [event.id]);
        res.json({ success: true });
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.post('/events/delete/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (!sameUserId(event.created_by, user(req).id) && user(req).type !== 5)) return pageError(res, 403, 'Доступ запрещён');
        if (!editableStatuses.has(event.status)) return pageError(res, 400, 'Удалить можно только ожидающее или отклонённое мероприятие');
        await pool.query('DELETE FROM events WHERE id = ?', [event.id]);
        workspaceRedirect(req, res, { scope: 'mine', deleted: event.id });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.post('/events/review/:id', requirePageAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return pageError(res, 404, 'Мероприятие не найдено');
        if (![event.created_by, ...parseIdList(event.responsible_ids)].some((id) => sameUserId(id, user(req).id)) && user(req).type !== 5) return pageError(res, 403, 'Доступ запрещён');
        const review = String(req.body.review_text || '').trim();
        if (!review || review.length > 5000) return pageError(res, 400, 'Некорректный отзыв');
        await pool.query('UPDATE events SET review_text = ?, review_author_id = ?, review_created_at = NOW() WHERE id = ?', [review, user(req).id, event.id]);
        workspaceRedirect(req, res, { event: event.id, scope: 'archive' });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/reviews', requirePageAuth, async (req, res) => {
    workspaceRedirect(req, res, { scope: 'reviews' });
});

app.post('/events/cancel/:id', requirePageAuth, requirePermission('cancel_event'), async (req, res) => {
    const reason = String(req.body.cancel_reason || '').trim().slice(0, 500) || 'Причина не указана';
    try {
        const event = await getEvent(req.params.id);
        if (!event || !['APPROVED', 'WAITING_ADMIN'].includes(event.status)) return pageError(res, 400, 'Мероприятие нельзя отменить');
        await pool.query("UPDATE events SET status = 'CANCELED', cancel_reason = ?, canceled_by = ?, canceled_at = NOW() WHERE id = ?", [reason, user(req).id, event.id]);
        await createNotification(event.created_by, event.id, 'canceled', `Мероприятие «${event.title}» отменено. Причина: ${reason}`);
        const [participants] = await pool.query('SELECT user_id FROM event_participants WHERE event_id = ?', [event.id]);
        await Promise.all(participants.filter((item) => item.user_id !== event.created_by).map((item) => createNotification(item.user_id, event.id, 'canceled', `Мероприятие «${event.title}» отменено. Причина: ${reason}`)));
        await notifyAdmins(event.id, 'canceled', `Мероприятие «${event.title}» отменено администратором ${user(req).name}.`, user(req).id);
        workspaceRedirect(req, res, { event: event.id, scope: 'archive' });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/notifications/all', requirePageAuth, async (req, res) => {
    workspaceRedirect(req, res, { panel: 'notifications' });
});

app.post('/notifications/mark-all-read', requirePageAuth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user(req).id]);
    workspaceRedirect(req, res, { panel: 'notifications' });
});

app.post('/notifications/mark-read/:id', requireApiAuth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [Number(req.params.id), user(req).id]);
    res.json({ success: true });
});

app.get('/api/analytics', requireApiAuth, requirePermission('view_analytics'), async (req, res) => {
    try {
        const events = await getEvents();
        const canSeeAll = user(req).type === 5;
        const period = String(req.query.period || 'month');
        const periodStart = new Date();
        if (period === 'week') periodStart.setDate(periodStart.getDate() - 7);
        else if (period === 'month') periodStart.setMonth(periodStart.getMonth() - 1);
        else if (period === 'quarter') periodStart.setMonth(periodStart.getMonth() - 3);
        else if (period === 'year') periodStart.setFullYear(periodStart.getFullYear() - 1);
        const filtered = events.filter((event) => {
            if (!['APPROVED', 'COMPLETED', 'REJECTED', 'CANCELED'].includes(event.status)) return false;
            if (period !== 'all' && new Date(event.start_datetime) < periodStart) return false;
            if (!canSeeAll && !sameUserId(event.created_by, user(req).id) && !parseIdList(event.responsible_ids).some((id) => sameUserId(id, user(req).id))) return false;
            if (req.query.type && req.query.type !== 'all' && Number(req.query.type) !== Number(event.event_type_id)) return false;
            if (canSeeAll && req.query.teacher && req.query.teacher !== 'all' && Number(req.query.teacher) !== Number(event.created_by)) return false;
            return true;
        });
        const [participantRows] = await pool.query('SELECT event_id, user_id FROM event_participants');
        const participantEvents = new Map();
        for (const row of participantRows) participantEvents.set(Number(row.event_id), [...(participantEvents.get(Number(row.event_id)) || []), Number(row.user_id)]);
        const people = userNameMap(await getActiveUsersByIds(participantRows.map((row) => row.user_id).concat(filtered.map((event) => event.created_by), filtered.flatMap((event) => parseIdList(event.responsible_ids)))));
        const totals = {
            total_events: filtered.length,
            approved_count: filtered.filter((event) => event.status === 'APPROVED').length,
            rejected_count: filtered.filter((event) => event.status === 'REJECTED').length,
            canceled_count: filtered.filter((event) => event.status === 'CANCELED').length,
            total_participants: new Set(filtered.flatMap((event) => participantEvents.get(event.id) || [])).size
        };
        const countBy = (values, key) => [...values.entries()].map(([id, count]) => ({ id: Number(id), name: people.get(Number(id))?.name || `Пользователь #${id}`, [key]: count }));
        const created = new Map();
        filtered.forEach((event) => created.set(event.created_by, (created.get(event.created_by) || 0) + 1));
        const participation = new Map();
        filtered.forEach((event) => (participantEvents.get(event.id) || []).forEach((id) => participation.set(id, (participation.get(id) || 0) + 1)));
        const teachers = countBy(new Map([...created].filter(([id]) => [2, 3, 4].includes(people.get(Number(id))?.type))), 'created_events').map((row) => ({ ...row, participations: participation.get(row.id) || 0 })).sort((a, b) => b.created_events - a.created_events).slice(0, 10);
        const students = countBy(new Map([...participation].filter(([id]) => people.get(Number(id))?.type === 1)), 'participations').map((row) => ({ ...row, created_events: created.get(row.id) || 0, class_name: people.get(row.id)?.kaf_name || '' })).sort((a, b) => b.participations - a.participations).slice(0, 10);
        const classStats = new Map();
        filtered.forEach((event) => (participantEvents.get(event.id) || []).forEach((id) => {
            const className = people.get(Number(id))?.kaf_name;
            if (!className) return;
            const value = classStats.get(className) || { name: className, events: new Set(), participants: new Set() };
            value.events.add(event.id); value.participants.add(Number(id)); classStats.set(className, value);
        }));
        const responsibleCounts = new Map();
        filtered.forEach((event) => parseIdList(event.responsible_ids).forEach((id) => responsibleCounts.set(id, (responsibleCounts.get(id) || 0) + 1)));
        const typeCounts = new Map(); filtered.forEach((event) => typeCounts.set(event.type_name || 'Без типа', (typeCounts.get(event.type_name || 'Без типа') || 0) + 1));
        const timelineCounts = new Map(); filtered.forEach((event) => { const date = String(event.start_datetime).slice(0, 10); timelineCounts.set(date, (timelineCounts.get(date) || 0) + 1); });
        const classes = [...classStats.values()].map((item) => ({ name: item.name, events_count: item.events.size, participants_count: item.participants.size })).sort((a, b) => b.events_count - a.events_count).slice(0, 10);
        const responsible = countBy(responsibleCounts, 'responsible_count').sort((a, b) => b.responsible_count - a.responsible_count).slice(0, 10);
        res.json({ totals, teachers, classes, event_types: [...typeCounts].map(([type_name, count]) => ({ type_name, count })), timeline: [...timelineCounts].map(([date, count]) => ({ date, count })), students, responsible, organizers: countBy(created, 'created_events').sort((a, b) => b.created_events - a.created_events).slice(0, 10) });
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.use((error, req, res, next) => {
    mlog('[ERROR]', 'Неперехваченная ошибка', error.code || error.message);
    if (res.headersSent) return next(error);
    res.status(500).send('Ошибка сервера');
});

const PORT = Number(process.env.PORT || 3000);
const listenOptions = { port: PORT };
if (process.env.HOST) listenOptions.host = process.env.HOST;
if (process.env.NODE_ENV !== 'test') {
    app.listen(listenOptions, () => mlog(`Calendar started on http://${listenOptions.host || 'localhost'}:${PORT}`));
}

export { app, parseCsvSnapshot, sourceDateToIso, YEAR_PLAN_IMPORT, normalizedEventStatus };
