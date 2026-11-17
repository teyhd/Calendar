import crypto from 'node:crypto';

const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
const schoolDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });
const iso = value => value ? `${String(value).replace(' ', 'T')}+03:00` : null;
const link = id => `https://event.platoniks.ru/?event=${encodeURIComponent(id)}`;

export function readMainportalRequest(raw, headers, key, now = new Date()) {
    if (!key) fail(503, 'context_disabled');
    const timestamp = String(headers['x-service-timestamp'] || '');
    const signature = String(headers['x-service-signature'] || '');
    if (headers['x-service-name'] !== 'mainportal' || !/^\d{13}$/.test(timestamp)
        || Math.abs(+now - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/i.test(signature)
        || !Buffer.isBuffer(raw) || raw.length > 65536) fail(401, 'invalid_service_request');
    const expected = crypto.createHmac('sha256', key).update(timestamp).update('\n').update(raw).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(401, 'invalid_service_request');
    let input;
    try { input = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'invalid_json'); }
    if (input?.schema !== 1 || !positive(input.actorId) || input.date !== schoolDate.format(now)
        || !['personal', 'school'].includes(input.context)
        || input.childId != null && !positive(input.childId)
        || input.lessonRefs != null && (!Array.isArray(input.lessonRefs) || input.lessonRefs.length > 200)
        || input.returns != null && (!Array.isArray(input.returns) || input.returns.length > 200)) fail(400, 'invalid_context');
    return input;
}

// This read adapter resolves every service role independently; it does not change
// browser sessions or grant mutations through a second identity mechanism.
export async function loadMainportalContext(calendar, directory, input, { serviceId } = {}) {
    if (!positive(serviceId)) fail(503, 'context_unconfigured');
    const [rights] = await directory.query(`SELECT DISTINCT r.role_id FROM users u
        JOIN rights r ON r.usr_id=u.id JOIN srvs s ON s.id=r.srv_id
        JOIN srvs_roles sr ON sr.srvs_id=s.id AND sr.role_id=r.role_id
        WHERE u.id=? AND u.lifecycle_state='active' AND s.id=? AND s.name='calendar'
        AND r.role_id IN (1,2,3,4,5,6)`, [input.actorId, serviceId]);
    const roles = rights.map(row => Number(row.role_id));
    if (!roles.length || input.context === 'school' && !roles.includes(5)) fail(403, 'context_forbidden');
    let children = [];
    if (roles.includes(6)) {
        const [rows] = await directory.query(`SELECT DISTINCT u.id FROM parents_kids pk JOIN users u ON u.id=pk.kid_id
            WHERE pk.parent_id=? AND u.lifecycle_state='active' AND u.type=1
            AND EXISTS (SELECT 1 FROM rights r JOIN srvs_roles sr ON sr.srvs_id=r.srv_id AND sr.role_id=r.role_id
                WHERE r.usr_id=u.id AND r.srv_id=? AND r.role_id=1)`, [input.actorId, serviceId]);
        children = rows.map(row => Number(row.id));
    }
    if (input.childId != null && !children.includes(input.childId)) fail(403, 'child_forbidden');
    // Unselected siblings never silently enter a selected-child response.
    const subjects = [input.actorId, ...(input.childId ? [input.childId] : children)];
    const result = { schema: 1, date: input.date, items: [], lessons: [], events: [] };
    const placeholders = subjects.map(() => '?').join(',');
    const [rows] = await calendar.query(`SELECT e.id,e.title,e.status,e.created_by,e.responsible_ids,
        DATE_FORMAT(e.start_datetime,'%Y-%m-%d %H:%i:%s') AS starts,
        DATE_FORMAT(e.end_datetime,'%Y-%m-%d %H:%i:%s') AS ends,
        ep.user_id AS participant_id
        FROM events e LEFT JOIN event_participants ep ON ep.event_id=e.id AND ep.user_id IN (${placeholders})
        WHERE e.status='APPROVED' AND (e.is_admin_event=0 OR ?=1 OR e.created_by=?)
        AND e.end_datetime>? AND e.start_datetime<DATE_ADD(?,INTERVAL 7 DAY)
        AND (ep.user_id IS NOT NULL OR FIND_IN_SET(?,e.responsible_ids)>0)
        ORDER BY e.start_datetime,e.id,ep.user_id LIMIT 501`, [...subjects, roles.includes(5) ? 1 : 0, input.actorId, `${input.date} 00:00:00`, `${input.date} 00:00:00`, input.actorId]);
    result.partial = rows.length > 500;
    const seen = new Set();
    for (const row of rows.slice(0, 500)) {
        const responsible = roles.some(role => [2,3,4,5].includes(role))
            && String(row.responsible_ids || '').split(',').map(Number).includes(input.actorId);
        const participant = Number(row.participant_id);
        for (const relation of [responsible ? { relation: 'responsible', studentId: null } : null,
            subjects.includes(participant) ? { relation: 'participant', studentId: participant === input.actorId ? null : participant } : null].filter(Boolean)) {
            const key = `${row.id}:${relation.relation}:${relation.studentId || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.events.push({ id: String(row.id), title: row.title, start: iso(row.starts), end: iso(row.ends), ...relation, href: link(row.id) });
        }
    }
    // Personal approvals belong to the assigned approver, not every administrator.
    if (roles.includes(5)) {
        const [pending] = await calendar.query(`SELECT e.id,e.title,DATE_FORMAT(e.start_datetime,'%Y-%m-%d %H:%i:%s') AS starts
            FROM events e WHERE e.status='WAITING_ADMIN' AND e.end_datetime>?
            AND EXISTS (SELECT 1 FROM event_approvals a WHERE a.event_id=e.id AND a.user_id=? AND a.status='pending')
            ORDER BY e.start_datetime,e.id LIMIT 100`, [`${input.date} 00:00:00`, input.actorId]);
        for (const row of pending) result.items.push({ key: `calendar:approval:${row.id}`, kind: 'calendar_approval',
            title: 'Мероприятие ждёт вашего согласования', subtitle: row.title, start: iso(row.starts),
            actions: [{ label: 'Рассмотреть', href: `https://event.platoniks.ru/?view=moderation&event=${row.id}` }] });
    }
    if (roles.some(role => [2,3,4,5].includes(role))) {
        const [pending] = await calendar.query(`SELECT id,title,DATE_FORMAT(start_datetime,'%Y-%m-%d %H:%i:%s') AS starts
            FROM events WHERE status='WAITING_ADMIN' AND created_by=? AND end_datetime>?
            ORDER BY start_datetime,id LIMIT 100`, [input.actorId, `${input.date} 00:00:00`]);
        for (const row of pending) result.items.push({ key: `calendar:waiting:${row.id}`, kind: 'calendar_waiting',
            title: 'Ваше мероприятие ещё не согласовано', subtitle: row.title, start: iso(row.starts),
            actions: [{ label: 'Открыть', href: link(row.id) }] });
    }
    const [sync] = await calendar.query(`SELECT status FROM google_calendar_connections WHERE user_id=?
        ORDER BY (status<>'disconnected') DESC,id DESC LIMIT 1`, [input.actorId]);
    if (['reauth_required', 'error'].includes(sync[0]?.status)) result.items.push({
        key: 'calendar:sync', kind: 'calendar_sync', title: sync[0].status === 'reauth_required'
            ? 'Переподключите Google Calendar' : 'Синхронизация календаря требует проверки',
        subtitle: 'На телефоне могут быть не все обновления',
        actions: [{ label: 'Проверить синхронизацию', href: 'https://event.platoniks.ru/?view=google-calendar' }]
    });
    return result;
}

export function registerMainportalContext(app, express, calendar, directory) {
    app.post('/internal/v1/mainportal/context', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const input = readMainportalRequest(req.body, req.headers, process.env.MAINPORTAL_CONTEXT_KEY);
            res.json(await loadMainportalContext(calendar, directory, input, { serviceId: Number(process.env.SSO_SERVICE_ID) }));
        } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'calendar_unavailable' }); }
    });
}
