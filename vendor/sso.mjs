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

function mapPerson(row) {
    return {
        id: Number(row.id),
        name: row.name || `Пользователь #${row.id}`,
        type: Number(row.type),
        kaf: row.kaf == null ? null : Number(row.kaf),
        kaf_name: row.kaf_name || null,
        role_name: ROLE_NAMES[Number(row.type)] || 'Пользователь'
    };
}

export function roleName(roleId) {
    return ROLE_NAMES[Number(roleId)] || 'Пользователь';
}

export async function getActiveUserById(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const [rows] = await ssoPool.query(`
        SELECT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM users u
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE u.id = ? AND ${activeUserFilter('u')}
         LIMIT 1
    `, [id]);
    return rows[0] ? mapPerson(rows[0]) : null;
}

export async function getActiveUsersByIds(ids) {
    const normalized = uniquePositiveIds(ids);
    if (!normalized.length) return [];
    const [rows] = await ssoPool.query(`
        SELECT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM users u
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE u.id IN (${placeholders(normalized)})
           AND ${activeUserFilter('u')}
         ORDER BY u.name, u.id
    `, normalized);
    return rows.map(mapPerson);
}

export async function listActiveUsers(roleIds = CALENDAR_ROLE_IDS) {
    const roles = uniquePositiveIds(roleIds).filter((id) => CALENDAR_ROLE_IDS.includes(id));
    if (!roles.length) return [];
    const [rows] = await ssoPool.query(`
        SELECT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM users u
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE u.lifecycle_state = 'active'
           AND u.type IN (${placeholders(roles)})
         ORDER BY u.name, u.id
    `, roles);
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
    const [rows] = await ssoPool.query(`
        SELECT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM parents_kids pk
          JOIN users u ON u.id = pk.kid_id
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE pk.parent_id = ?
           AND u.lifecycle_state = 'active'
           AND u.type = 1
         ORDER BY u.name, u.id
    `, [id]);
    return rows.map(mapPerson);
}

export async function getCalendarAdmins() {
    const serviceId = Number(process.env.SSO_SERVICE_ID);
    if (!Number.isInteger(serviceId) || serviceId <= 0) throw new Error('SSO_SERVICE_ID is not configured');
    const [rows] = await ssoPool.query(`
        SELECT DISTINCT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM rights r
          JOIN users u ON u.id = r.usr_id
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE r.srv_id = ?
           AND r.role_id = 5
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
    const [rows] = await ssoPool.query(`
        SELECT u.id, u.name, u.type, u.kaf, k.name AS kaf_name
          FROM users u
          LEFT JOIN kaf_name k ON k.id = u.kaf
         WHERE u.id IN (${placeholders(normalized)})
           AND u.lifecycle_state = 'active'
           AND u.type IN (${placeholders(allowed)})
    `, [...normalized, ...allowed]);
    const people = rows.map(mapPerson);
    if (people.length !== normalized.length) throw new Error('Выбранный пользователь недоступен в SSO');
    return people;
}

export function parseIdList(value) {
    return uniquePositiveIds(value);
}
