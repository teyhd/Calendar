import express from 'express';
import cookieParser from 'cookie-parser';
import { engine } from 'express-handlebars';
import handlebars from 'handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

function toSqlDateTime(value, field) {
    const raw = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
        throw new Error(`Некорректная дата: ${field}`);
    }
    const normalized = `${raw.replace('T', ' ')}${raw.length === 16 ? ':00' : ''}`;
    if (Number.isNaN(new Date(normalized.replace(' ', 'T')).getTime())) throw new Error(`Некорректная дата: ${field}`);
    return normalized;
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

async function eventVisibleTo(event, actor, children = null) {
    if (actor.type === 5 || Number(event.created_by) === actor.id) return true;
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
        if (!includeArchived && ['REJECTED', 'CANCELED', 'COMPLETED'].includes(event.status) && actor.type !== 5 && event.created_by !== actor.id) continue;
        if (await eventVisibleTo(event, actor, children)) filtered.push(event);
    }
    return filtered;
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

async function normalizeEventInput(body) {
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim() || null;
    if (!title || title.length > 100 || description?.length > 500) throw new Error('Проверьте название и описание мероприятия');
    const eventTypeId = Number(body.event_type_id);
    const [eventTypes] = await pool.query('SELECT id FROM event_types WHERE id = ?', [eventTypeId]);
    if (!eventTypes.length) throw new Error('Выберите существующий тип мероприятия');
    const subjectId = body.subject_id ? Number(body.subject_id) : null;
    if (subjectId) {
        const [subjects] = await pool.query('SELECT id FROM subjects WHERE id = ?', [subjectId]);
        if (!subjects.length) throw new Error('Выберите существующий предмет');
    }
    const start = toSqlDateTime(body.start_datetime, 'начала');
    const end = toSqlDateTime(body.end_datetime, 'окончания');
    if (new Date(start.replace(' ', 'T')) >= new Date(end.replace(' ', 'T'))) throw new Error('Дата начала должна быть раньше даты окончания');
    const audienceType = String(body.target_audience_type || '');
    if (!audienceTypes.has(audienceType)) throw new Error('Некорректная аудитория мероприятия');
    const rawAudience = audienceType === 'specific_users' || audienceType === 'multiple_classes' ? body.target_audience_ids : body.target_audience_id;
    let audienceId = null;
    if (audienceType === 'class') {
        const kaf = await getKafById(rawAudience, 1);
        if (!kaf) throw new Error('Выберите существующий класс');
        audienceId = String(kaf.id);
    } else if (audienceType === 'department') {
        const kaf = await getKafById(rawAudience, 2);
        if (!kaf) throw new Error('Выберите существующую кафедру');
        audienceId = String(kaf.id);
    } else if (audienceType === 'parallel') {
        const parallel = String(rawAudience || '').trim();
        const classes = await listClasses();
        if (!parallel || !classes.some((item) => parallelFromName(item.name) === parallel)) throw new Error('Выберите существующую параллель');
        audienceId = parallel;
    } else if (audienceType === 'multiple_classes') {
        const ids = parseIdList(rawAudience);
        if (!ids.length || !(await Promise.all(ids.map((id) => getKafById(id, 1)))).every(Boolean)) throw new Error('Выберите существующие классы');
        audienceId = ids.join(',');
    } else if (audienceType === 'specific_users') {
        const ids = parseIdList(rawAudience);
        if (!ids.length) throw new Error('Выберите хотя бы одного пользователя');
        await assertActiveUsers(ids);
        audienceId = ids.join(',');
    }
    const responsibleIds = parseIdList(body.responsible_ids);
    if (!responsibleIds.length) throw new Error('Выберите хотя бы одного ответственного');
    await assertActiveUsers(responsibleIds, STAFF_ROLE_IDS);
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

cron.schedule('0 * * * *', autoCompleteEvents);
cron.schedule('*/15 * * * *', sendEventReminders);

app.get('/', requirePageAuth, async (req, res) => {
    try {
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        res.render('calendar/index', { title: 'Календарь мероприятий', types });
    } catch (error) {
        mlog('[ERROR]', 'Загрузка календаря', error.code || error.message);
        pageError(res, 500, 'Ошибка сервера');
    }
});

app.get('/admin/settings', requirePageAuth, requirePermission('manage_settings'), async (req, res) => {
    try {
        const [classes, departments, subjects, eventTypes] = await Promise.all([
            listClasses(), listDepartments(), pool.query('SELECT * FROM subjects ORDER BY name').then(([rows]) => rows), pool.query('SELECT * FROM event_types ORDER BY name').then(([rows]) => rows)
        ]);
        res.render('admin/settings', { title: 'Настройки системы', classes, departments, subjects, eventTypes });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/events/create', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try { res.render('events/create', { title: 'Создание мероприятия', ...(await formData()), selectedIds: [], selectedClassIds: [], selectedResponsibleIds: [] }); }
    catch (error) { pageError(res, 500, 'Ошибка загрузки формы'); }
});

app.post('/events/create', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const input = await normalizeEventInput(req.body);
        const admins = await getCalendarAdmins();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(`
                INSERT INTO events (title, description, event_type_id, department_id, subject_id, start_datetime, end_datetime, location, level, status, target_audience_type, target_audience_id, is_admin_event, is_registration_enabled, reward_type, reward_places, created_by, responsible_ids)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_ADMIN', ?, ?, ?, ?, ?, ?, ?, ?)
            `, [input.title, input.description, input.eventTypeId, input.departmentId, input.subjectId, input.start, input.end, input.location, input.level, input.audienceType, input.audienceId, user(req).type === 5 ? input.isAdminEvent : 0, input.registrationEnabled, input.rewardType, input.rewardPlaces, user(req).id, input.responsibleIds]);
            await resetApprovals(connection, result.insertId, admins);
            await connection.commit();
            await notifyAdmins(result.insertId, 'new_event', `Новое мероприятие «${input.title}» ожидает утверждения администраторами.`);
            res.redirect('/');
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    } catch (error) { mlog('[ERROR]', 'Создание мероприятия', error.message); pageError(res, 400, error.message || 'Ошибка сервера'); }
});

async function renderEventForm(req, res, view, title) {
    const event = await getEvent(req.params.id);
    if (!event || (event.created_by !== user(req).id && user(req).type !== 5)) return pageError(res, 404, 'Мероприятие не найдено или доступ запрещён');
    const selectedIds = event.target_audience_type === 'specific_users' ? parseIdList(event.target_audience_id) : [];
    const selectedClassIds = event.target_audience_type === 'multiple_classes' ? parseIdList(event.target_audience_id) : [];
    res.render(view, { title, event, ...(await formData()), selectedIds, selectedClassIds, selectedResponsibleIds: parseIdList(event.responsible_ids) });
}

app.get('/events/copy/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try { await renderEventForm(req, res, 'events/create', 'Повтор заявки'); } catch (error) { pageError(res, 500, 'Ошибка загрузки мероприятия'); }
});

app.get('/events/edit/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try { await renderEventForm(req, res, 'events/edit', 'Редактирование мероприятия'); } catch (error) { pageError(res, 500, 'Ошибка загрузки мероприятия'); }
});

app.post('/events/edit/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (event.created_by !== user(req).id && user(req).type !== 5)) return pageError(res, 403, 'Доступ запрещён');
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
            res.redirect('/');
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    } catch (error) { mlog('[ERROR]', 'Редактирование мероприятия', error.message); pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.get('/my-events', requirePageAuth, async (req, res) => {
    try {
        let events;
        if (user(req).type === 1) {
            events = await getEvents('WHERE e.created_by = ? OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = ?)', [user(req).id, user(req).id]);
        } else if (user(req).type === 6) {
            const children = await getChildrenForParent(user(req).id);
            const childIds = children.map((child) => child.id);
            events = childIds.length ? await getEvents(`WHERE EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id IN (${childIds.map(() => '?').join(',')}))`, childIds) : [];
        } else {
            events = await getEvents('WHERE e.created_by = ?', [user(req).id]);
        }
        res.render('events/my-events', { title: 'Мои мероприятия', events, user: res.locals.user });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/child-events', requirePageAuth, requirePermission('view_children'), async (req, res) => {
    try {
        const children = await getChildrenForParent(user(req).id);
        const events = await visibleEventsFor(user(req));
        const childById = new Map(children.map((child) => [child.id, child]));
        const result = [];
        for (const event of events) {
            const [participants] = await pool.query('SELECT user_id FROM event_participants WHERE event_id = ?', [event.id]);
            const participant = participants.find((item) => childById.has(Number(item.user_id)));
            result.push({ ...event, student_name: participant ? childById.get(Number(participant.user_id)).name : null });
        }
        res.render('events/child-events', { title: 'Мероприятия ребёнка', events: result, message: children.length ? null : 'В SSO нет активных детей, связанных с вашим аккаунтом.' });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/events/moderation', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    try {
        const events = await getEvents("WHERE e.status = 'WAITING_ADMIN'");
        const approvals = await approvalsForEvents(events.map((event) => event.id));
        res.render('events/moderation', { title: 'Модерация мероприятий', events: events.map((event) => ({ ...event, approvals: approvals.get(event.id) || [] })), userRole: user(req).type });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
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

app.post('/events/admin-approve/:id', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    const eventId = Number(req.params.id);
    try {
        const connection = await pool.getConnection();
        let event;
        try {
            await connection.beginTransaction();
            const [events] = await connection.query('SELECT id, title, created_by, status FROM events WHERE id = ? FOR UPDATE', [eventId]);
            event = events[0];
            if (!event || event.status !== 'WAITING_ADMIN') throw new Error('Мероприятие не ожидает утверждения');
            const [approvals] = await connection.query("SELECT id, status FROM event_approvals WHERE event_id = ? AND user_id = ? AND role_type = 'admin' FOR UPDATE", [eventId, user(req).id]);
            if (!approvals[0] || approvals[0].status !== 'pending') throw new Error('У вас нет ожидающего утверждения');
            await connection.query("UPDATE event_approvals SET status = 'approved' WHERE id = ?", [approvals[0].id]);
            const [all] = await connection.query("SELECT status FROM event_approvals WHERE event_id = ? AND role_type = 'admin'", [eventId]);
            if (all.length && all.every((item) => item.status === 'approved')) await connection.query("UPDATE events SET status = 'APPROVED', approved_by = ? WHERE id = ?", [user(req).id, eventId]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        const eventNow = await getEvent(eventId);
        if (eventNow.status === 'APPROVED') {
            await createNotification(event.created_by, eventId, 'approved', `Мероприятие «${event.title}» утверждено всеми администраторами и опубликовано.`);
            await notifyAdmins(eventId, 'approved', `Мероприятие «${event.title}» утверждено всеми администраторами.`, user(req).id);
        } else {
            await createNotification(event.created_by, eventId, 'admin_approved', `Администратор утвердил мероприятие «${event.title}». Ожидаются остальные утверждения.`);
        }
        res.redirect('/events/moderation');
    } catch (error) { pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.post('/events/reject/:id', requirePageAuth, requirePermission('moderate_event'), async (req, res) => {
    const eventId = Number(req.params.id);
    const reason = String(req.body.rejection_reason || '').trim().slice(0, 500) || 'Без указания причины';
    try {
        const connection = await pool.getConnection();
        let event;
        try {
            await connection.beginTransaction();
            const [events] = await connection.query('SELECT id, title, created_by, status FROM events WHERE id = ? FOR UPDATE', [eventId]);
            event = events[0];
            if (!event || event.status !== 'WAITING_ADMIN') throw new Error('Мероприятие нельзя отклонить');
            const [approvals] = await connection.query("SELECT id, status FROM event_approvals WHERE event_id = ? AND user_id = ? AND role_type = 'admin' FOR UPDATE", [eventId, user(req).id]);
            if (!approvals[0] || approvals[0].status !== 'pending') throw new Error('У вас нет права отклонить мероприятие');
            await connection.query("UPDATE event_approvals SET status = 'rejected', comment = ? WHERE id = ?", [reason, approvals[0].id]);
            await connection.query("UPDATE events SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), rejection_reason = ? WHERE id = ?", [user(req).id, reason, eventId]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        await createNotification(event.created_by, eventId, 'rejected', `Мероприятие «${event.title}» отклонено. Причина: ${reason}`);
        await notifyAdmins(eventId, 'rejected', `Мероприятие «${event.title}» отклонено администратором ${user(req).name}.`, user(req).id);
        res.redirect('/events/moderation');
    } catch (error) { pageError(res, 400, error.message || 'Ошибка сервера'); }
});

app.post('/events/resend/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || event.created_by !== user(req).id || event.status !== 'REJECTED') return pageError(res, 400, 'Можно повторно отправить только своё отклонённое мероприятие');
        const admins = await getCalendarAdmins();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query("UPDATE events SET status = 'WAITING_ADMIN', rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?", [event.id]);
            await resetApprovals(connection, event.id, admins);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        await notifyAdmins(event.id, 'resubmitted', `Мероприятие «${event.title}» повторно отправлено на утверждение.`);
        res.redirect('/');
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/events/archive', requirePageAuth, async (req, res) => {
    try {
        const events = (await visibleEventsFor(user(req), { includeArchived: true })).filter((event) => ['COMPLETED', 'CANCELED', 'REJECTED'].includes(event.status));
        res.render('events/archive', { title: 'Архив мероприятий', events, userType: user(req).type, user: res.locals.user });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/analytics', requirePageAuth, requirePermission('view_analytics'), async (req, res) => {
    try {
        const [eventTypes] = await pool.query('SELECT id, name FROM event_types ORDER BY name');
        const teachers = user(req).type === 5 ? await listActiveUsers([2, 3, 4]) : [];
        res.render('analytics', { title: 'Аналитика', user: res.locals.user, showAllData: user(req).type === 5, userKaf: user(req).kaf, userId: user(req).id, eventTypes, teachers });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/api/events', requireApiAuth, async (req, res) => {
    try { res.json(await visibleEventsFor(user(req))); }
    catch (error) { mlog('[ERROR]', 'API событий', error.message); apiError(res, 500, 'Ошибка сервера'); }
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
        if (!event || (event.created_by !== user(req).id && user(req).type !== 5)) return apiError(res, 403, 'Доступ запрещён');
        if (event.status !== 'APPROVED') return apiError(res, 400, 'Можно завершить только утверждённое мероприятие');
        await pool.query("UPDATE events SET status = 'COMPLETED' WHERE id = ?", [event.id]);
        res.json({ success: true });
    } catch (error) { apiError(res, 500, 'Ошибка сервера'); }
});

app.post('/events/delete/:id', requirePageAuth, requirePermission('create_event'), async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || (event.created_by !== user(req).id && user(req).type !== 5)) return pageError(res, 403, 'Доступ запрещён');
        if (!editableStatuses.has(event.status)) return pageError(res, 400, 'Удалить можно только ожидающее или отклонённое мероприятие');
        await pool.query('DELETE FROM events WHERE id = ?', [event.id]);
        res.redirect('/my-events');
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.post('/events/review/:id', requirePageAuth, async (req, res) => {
    try {
        const event = await getEvent(req.params.id);
        if (!event || !(await eventVisibleTo(event, user(req)))) return pageError(res, 404, 'Мероприятие не найдено');
        if (![event.created_by, ...parseIdList(event.responsible_ids)].includes(user(req).id) && user(req).type !== 5) return pageError(res, 403, 'Доступ запрещён');
        const review = String(req.body.review_text || '').trim();
        if (!review || review.length > 5000) return pageError(res, 400, 'Некорректный отзыв');
        await pool.query('UPDATE events SET review_text = ?, review_author_id = ?, review_created_at = NOW() WHERE id = ?', [review, user(req).id, event.id]);
        res.redirect('/events/archive');
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/reviews', requirePageAuth, async (req, res) => {
    try {
        const events = (await visibleEventsFor(user(req), { includeArchived: true })).filter((event) => event.review_text);
        res.render('reviews', { title: 'Отзывы', reviews: events });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
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
        res.redirect('/');
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.get('/notifications/all', requirePageAuth, async (req, res) => {
    try {
        const [allNotifications] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [user(req).id]);
        res.render('notifications/all', { title: 'Все уведомления', allNotifications });
    } catch (error) { pageError(res, 500, 'Ошибка сервера'); }
});

app.post('/notifications/mark-all-read', requirePageAuth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user(req).id]);
    res.redirect('/notifications/all');
});

app.post('/notifications/mark-read/:id', requireApiAuth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [Number(req.params.id), user(req).id]);
    res.json({ success: true });
});

app.get('/api/analytics', requireApiAuth, requirePermission('view_analytics'), async (req, res) => {
    try {
        const events = await getEvents();
        const canSeeAll = user(req).type === 5;
        const filtered = events.filter((event) => {
            if (!['APPROVED', 'COMPLETED', 'REJECTED', 'CANCELED'].includes(event.status)) return false;
            if (!canSeeAll && event.created_by !== user(req).id && !parseIdList(event.responsible_ids).includes(user(req).id)) return false;
            if (req.query.type && req.query.type !== 'all' && Number(req.query.type) !== Number(event.event_type_id)) return false;
            if (canSeeAll && req.query.teacher && req.query.teacher !== 'all' && Number(req.query.teacher) !== Number(event.created_by)) return false;
            return true;
        });
        const [participantRows] = await pool.query('SELECT event_id, user_id FROM event_participants');
        const participantEvents = new Map();
        for (const row of participantRows) participantEvents.set(Number(row.event_id), [...(participantEvents.get(Number(row.event_id)) || []), Number(row.user_id)]);
        const people = userNameMap(await getActiveUsersByIds(participantRows.map((row) => row.user_id).concat(filtered.map((event) => event.created_by))));
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
        const typeCounts = new Map(); filtered.forEach((event) => typeCounts.set(event.type_name || 'Без типа', (typeCounts.get(event.type_name || 'Без типа') || 0) + 1));
        const timelineCounts = new Map(); filtered.forEach((event) => { const date = String(event.start_datetime).slice(0, 10); timelineCounts.set(date, (timelineCounts.get(date) || 0) + 1); });
        res.json({ totals, teachers, classes: [], event_types: [...typeCounts].map(([type_name, count]) => ({ type_name, count })), timeline: [...timelineCounts].map(([date, count]) => ({ date, count })), students, responsible: [], organizers: countBy(created, 'created_events').sort((a, b) => b.created_events - a.created_events).slice(0, 10) });
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
app.listen(listenOptions, () => mlog(`Calendar started on http://${listenOptions.host || 'localhost'}:${PORT}`));
