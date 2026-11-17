import { ssoPool } from './db.mjs';

export const CALENDAR_ROLE_IDS = Object.freeze([1, 2, 3, 4, 5, 6]);
export const STAFF_ROLE_IDS = Object.freeze([2, 3, 4, 5]);

const ROLE_NAMES = {
    1: 'Ученик',
    2: 'Учитель',
    3: 'Наставник',
    4: 'Тьютор',
    5: 'Админ',
    6: 'Родитель'
};

const PERSON_FIELDS = 'u.id, u.name, u.type, u.kaf, k.name AS kaf_name, rn.name AS role_name';
const PERSON_JOINS = `
    LEFT JOIN kaf_name k ON k.id = u.kaf
    LEFT JOIN role_name rn ON rn.id = u.type`;

function uniquePositiveIds(values) {
    return [...new Set((Array.isArray(values) ? values : String(values || '').split(','))
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0))];
}

function placeholders(values) {
    return values.map(() => '?').join(', ');
}

function activeUserFilter(alias = 'u') {
    return `${alias}.lifecycle_state = 'active' AND ${alias}.type IN (${CALENDAR_ROLE_IDS.join(', ')})`;
}

function calendarServiceId() {
    const serviceId = Number(process.env.SSO_SERVICE_ID);
    if (!Number.isInteger(serviceId) || serviceId <= 0) throw new Error('SSO_SERVICE_ID is not configured');
    return serviceId;
}

/**
 * Service access is read from the SSO source of truth.  The role on the
 * Calendar right must match the user's primary SSO role and be allowed by
 * the service policy.
 */
function calendarAccessFilter(alias = 'u') {
    return `EXISTS (
        SELECT 1
          FROM rights calendar_right
          JOIN srvs calendar_service ON calendar_service.id = calendar_right.srv_id
          JOIN srvs_roles calendar_service_role
            ON calendar_service_role.srvs_id = calendar_service.id
           AND calendar_service_role.role_id = calendar_right.role_id
         WHERE calendar_right.usr_id = ${alias}.id
           AND calendar_right.role_id = ${alias}.type
           AND calendar_service.id = ?
           AND calendar_service.name = 'calendar'
    )`;
}

function mapPerson(row) {
    return {
        id: Number(row.id),
        name: row.name || `Пользователь #${row.id}`,
        type: Number(row.type),
        kaf: row.kaf == null ? null : Number(row.kaf),
        kaf_name: row.kaf_name || null,
        role_name: row.role_name || ROLE_NAMES[Number(row.type)] || 'Пользователь'
    };
}

export function roleName(roleId) {
    return ROLE_NAMES[Number(roleId)] || 'Пользователь';
}

export async function getActiveUserById(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT ${PERSON_FIELDS}
          FROM users u
          ${PERSON_JOINS}
         WHERE u.id = ?
           AND ${activeUserFilter('u')}
           AND ${calendarAccessFilter('u')}
         LIMIT 1
    `, [id, serviceId]);
    return rows[0] ? mapPerson(rows[0]) : null;
}

// Authentication only: directory identity plus all currently granted Calendar
// roles. Other directory listings keep their existing primary-role policies.
export async function getCalendarAuthIdentity(userId) {
    const id=Number(userId);
    if (!Number.isSafeInteger(id)||id<=0) return null;
    const [rows]=await ssoPool.query(`SELECT ${PERSON_FIELDS},r.role_id AS granted_role
        FROM users u ${PERSON_JOINS}
        JOIN rights r ON r.usr_id=u.id JOIN srvs s ON s.id=r.srv_id
        JOIN srvs_roles sr ON sr.srvs_id=s.id AND sr.role_id=r.role_id
        WHERE u.id=? AND u.lifecycle_state='active' AND s.id=? AND s.name='calendar'
        AND r.role_id IN (1,2,3,4,5,6)`,[id,calendarServiceId()]);
    if (!rows.length) return null;
    return {...mapPerson(rows[0]),roles:[...new Set(rows.map(row=>Number(row.granted_role)))]};
}

export async function getActiveUsersByIds(ids) {
    const normalized = uniquePositiveIds(ids);
    if (!normalized.length) return [];
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT ${PERSON_FIELDS}
          FROM users u
          ${PERSON_JOINS}
         WHERE u.id IN (${placeholders(normalized)})
           AND ${activeUserFilter('u')}
           AND ${calendarAccessFilter('u')}
         ORDER BY u.name, u.id
    `, [...normalized, serviceId]);
    return rows.map(mapPerson);
}

export async function listActiveUsers(roleIds = CALENDAR_ROLE_IDS) {
    const roles = uniquePositiveIds(roleIds).filter((id) => CALENDAR_ROLE_IDS.includes(id));
    if (!roles.length) return [];
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT ${PERSON_FIELDS}
          FROM users u
          ${PERSON_JOINS}
         WHERE u.lifecycle_state = 'active'
           AND u.type IN (${placeholders(roles)})
           AND ${calendarAccessFilter('u')}
         ORDER BY u.name, u.id
    `, [...roles, serviceId]);
    return rows.map(mapPerson);
}

export async function listClasses() {
    const [rows] = await ssoPool.query(`SELECT id, type, name FROM kaf_name WHERE type = 1 ORDER BY name, id`);
    return rows.map((row) => ({ ...row, id: Number(row.id), type: Number(row.type) }));
}

export async function listDepartments() {
    const [rows] = await ssoPool.query(`SELECT id, type, name FROM kaf_name WHERE type = 2 ORDER BY name, id`);
    return rows.map((row) => ({ ...row, id: Number(row.id), type: Number(row.type) }));
}

export async function getKafById(id, expectedType) {
    const kafId = Number(id);
    if (!Number.isInteger(kafId) || kafId <= 0) return null;
    const params = [kafId];
    let where = 'id = ?';
    if (expectedType != null) {
        where += ' AND type = ?';
        params.push(Number(expectedType));
    }
    const [rows] = await ssoPool.query(`SELECT id, type, name FROM kaf_name WHERE ${where} LIMIT 1`, params);
    return rows[0] ? { ...rows[0], id: Number(rows[0].id), type: Number(rows[0].type) } : null;
}

export async function getChildrenForParent(parentId) {
    const id = Number(parentId);
    if (!Number.isInteger(id) || id <= 0) return [];
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT ${PERSON_FIELDS}
          FROM parents_kids pk
          JOIN users u ON u.id = pk.kid_id
          ${PERSON_JOINS}
         WHERE pk.parent_id = ?
           AND u.lifecycle_state = 'active'
           AND u.type = 1
           AND ${calendarAccessFilter('u')}
         ORDER BY u.name, u.id
    `, [id, serviceId]);
    return rows.map(mapPerson);
}

export async function getCalendarAdmins() {
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT DISTINCT ${PERSON_FIELDS}
          FROM rights r
          JOIN srvs srv ON srv.id = r.srv_id AND srv.name = 'calendar'
          JOIN srvs_roles srv_role ON srv_role.srvs_id = srv.id AND srv_role.role_id = r.role_id
          JOIN users u ON u.id = r.usr_id
          ${PERSON_JOINS}
         WHERE r.srv_id = ?
           AND r.role_id = 5
           AND u.type = 5
           AND ${activeUserFilter('u')}
         ORDER BY u.id
    `, [serviceId]);
    return rows.map(mapPerson);
}

export async function assertActiveUsers(ids, allowedRoles = CALENDAR_ROLE_IDS) {
    const normalized = uniquePositiveIds(ids);
    if (!normalized.length) return [];
    const allowed = uniquePositiveIds(allowedRoles).filter((id) => CALENDAR_ROLE_IDS.includes(id));
    if (!allowed.length) return [];
    const serviceId = calendarServiceId();
    const [rows] = await ssoPool.query(`
        SELECT ${PERSON_FIELDS}
          FROM users u
          ${PERSON_JOINS}
         WHERE u.id IN (${placeholders(normalized)})
           AND u.lifecycle_state = 'active'
           AND u.type IN (${placeholders(allowed)})
           AND ${calendarAccessFilter('u')}
    `, [...normalized, ...allowed, serviceId]);
    const people = rows.map(mapPerson);
    if (people.length !== normalized.length) throw new Error('Выбранный пользователь недоступен в SSO');
    return people;
}

export function parseIdList(value) {
    return uniquePositiveIds(value);
}
