import express from 'express';
import session from 'express-session';
import { engine } from 'express-handlebars';
import handlebars from 'handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pool from './vendor/db.mjs';
import { mlog } from './vendor/logs.js';
import { registerHelpers } from './vendor/hlp.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Регистрируем хелперы ДО создания engine
registerHelpers(handlebars);

// ----- Настройка Handlebars -----
const hbs = engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/layouts'),
    partialsDir: path.join(__dirname, 'views/partials'),
    handlebars: handlebars
});

app.engine('.hbs', hbs);
app.set('view engine', '.hbs');
app.set('views', path.join(__dirname, 'views'));

// ----- Middleware -----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Сессии
app.use(session({
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 3600000 }
}));

// Middleware для уведомлений
app.use(async (req, res, next) => {
    if (req.session.user) {
        try {
            const [notifications] = await pool.query(
                `SELECT * FROM notifications 
                 WHERE user_id = ? 
                 ORDER BY created_at DESC 
                 LIMIT 10`,
                [req.session.user.id]
            );
            const [unreadResult] = await pool.query(
                `SELECT COUNT(*) as count FROM notifications 
                 WHERE user_id = ? AND is_read = 0`,
                [req.session.user.id]
            );
            res.locals.notifications = notifications;
            res.locals.unreadCount = unreadResult[0].count;
        } catch (error) {
            mlog('[ERROR]', 'Ошибка загрузки уведомлений', error);
            res.locals.notifications = [];
            res.locals.unreadCount = 0;
        }
    } else {
        res.locals.notifications = [];
        res.locals.unreadCount = 0;
    }
    next();
});

// ----- Middleware для передачи пользователя в шаблоны -----
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.isAuthenticated = !!req.session.user;
    next();
});

// ----- Middleware проверки ролей (по type) -----
function isAuthenticated(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
}

function isAdmin(req, res, next) {
    if (!req.session.user || req.session.user.type !== 5) {
        return res.status(403).send('Доступ запрещен');
    }
    next();
}

function isTeacher(req, res, next) {
    if (!req.session.user || ![2, 5].includes(req.session.user.type)) {
        return res.status(403).send('Доступ запрещен');
    }
    next();
}

// ----- Вспомогательная функция для создания уведомлений -----
async function createNotification(userId, eventId, type, message) {
    try {
        await pool.query(
            `INSERT INTO notifications (user_id, event_id, type, message) 
             VALUES (?, ?, ?, ?)`,
            [userId, eventId || null, type, message]
        );
    } catch (error) {
        mlog('[ERROR]', 'Ошибка создания уведомления', error);
    }
}

// ============================================================
// ===== МАРШРУТЫ =====
// ============================================================

// ----- Главная страница / Календарь -----
app.get('/', isAuthenticated, (req, res) => {
    res.render('calendar/index', { 
        title: 'Календарь мероприятий' 
    });
});

// ============================================================
// ===== АУТЕНТИФИКАЦИЯ (вход по имени и PIN-коду) =====
// ============================================================

app.get('/auth/login', (req, res) => {
    res.render('auth/login', { title: 'Вход' });
});

app.post('/auth/login', async (req, res) => {
    const { name, pin } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT u.*, r.name as role_name 
             FROM users u 
             JOIN roles r ON u.type = r.id 
             WHERE u.name = ? AND u.pin = ?`,
            [name, pin]
        );
        if (rows.length === 0) {
            return res.render('auth/login', { error: 'Неверное имя или PIN-код' });
        }
        const user = rows[0];
        
        // Получаем название кафедры/класса
        let kaf_name = null;
        if (user.kaf) {
            const [kafRows] = await pool.query(
                'SELECT name FROM departments WHERE id = ?',
                [user.kaf]
            );
            if (kafRows.length > 0) {
                kaf_name = kafRows[0].name;
            }
        }

        // Сохраняем в сессию
        req.session.user = {
            id: user.id,
            name: user.name,
            kaf: user.kaf,
            kaf_name: kaf_name,      // ← добавлено
            type: user.type,
            role_name: user.role_name
        };
        mlog(`Пользователь ${user.name} вошел в систему`);
        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка входа', error.message || error);
        res.render('auth/login', { error: 'Ошибка сервера. Попробуйте позже.' });
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth/login');
});

// ============================================================
// ===== АДМИН: ПОЛЬЗОВАТЕЛИ =====
// ============================================================

app.get('/admin/users', isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT u.*, d.name as kaf_name, r.name as role_name
            FROM users u
            LEFT JOIN departments d ON u.kaf = d.id
            JOIN roles r ON u.type = r.id
            ORDER BY u.id
        `);
        res.render('admin/users', { 
            title: 'Управление пользователями',
            users
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки пользователей', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Админ: создание пользователя -----
app.post('/admin/users/create', isAdmin, async (req, res) => {
    const { name, pin, type, kaf } = req.body;
    
    try {
        // Проверяем, существует ли пользователь с таким именем
        const [existing] = await pool.query('SELECT id FROM users WHERE name = ?', [name]);
        if (existing.length > 0) {
            return res.status(400).send('Пользователь с таким именем уже существует');
        }

        await pool.query(
            `INSERT INTO users (id, name, pin, type, kaf) 
             VALUES (?, ?, ?, ?, ?)`,
            [null, name, pin, type || 1, kaf || null]
        );
        
        mlog(`Администратор создал пользователя: ${name}`);
        res.redirect('/admin/users');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка создания пользователя', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Админ: удаление пользователя -----
app.post('/admin/users/delete/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        if (parseInt(id) === req.session.user.id) {
            return res.status(400).send('Нельзя удалить самого себя');
        }
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        mlog(`Администратор удалил пользователя с ID ${id}`);
        res.redirect('/admin/users');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка удаления пользователя', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ============================================================
// ===== АДМИН: НАСТРОЙКИ =====
// ============================================================

app.get('/admin/settings', isAdmin, async (req, res) => {
    try {
        // Классы (type=1) и кафедры (type=2)
        const [classes] = await pool.query('SELECT * FROM departments WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM departments WHERE type = 2 ORDER BY name');
        // Предметов больше нет в структуре sso, оставляем пустой массив или убираем
        const [subjects] = await pool.query('SELECT * FROM subjects'); // если таблица subjects ещё существует
        const [eventTypes] = await pool.query('SELECT * FROM event_types ORDER BY name');
        
        res.render('admin/settings', { 
            title: 'Настройки системы',
            classes,
            departments,
            subjects: subjects || [],
            eventTypes
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки настроек', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ============================================================
// ===== API =====
// ============================================================

// API: список пользователей (для админки)
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT u.id, u.name, u.kaf, u.type, u.pin,
                   d.name as kaf_name, r.name as role_name
            FROM users u
            LEFT JOIN departments d ON u.kaf = d.id
            JOIN roles r ON u.type = r.id
            ORDER BY u.id
        `);
        res.json(users);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения пользователей', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================================
// ===== УПРАВЛЕНИЕ МЕРОПРИЯТИЯМИ =====
// ============================================================

app.get('/events/create', isAuthenticated, async (req, res) => {
    try {
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM departments WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM departments WHERE type = 2 ORDER BY name');
        // subjects – возможно, больше нет, оставим для совместимости
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, name, type 
            FROM users 
            WHERE type IN (1, 2)  -- ученики и учителя
            ORDER BY name
        `);
        
        res.render('events/create', {
            title: 'Создание мероприятия',
            types,
            classes,
            departments,
            subjects: subjects || [],
            users
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки формы создания', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/events/create', isAuthenticated, async (req, res) => {
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, is_admin_event,
        is_registration_enabled 
    } = req.body;

    // Если пользователь не учитель и не админ, то is_admin_event = 0
    let isAdminEvent = is_admin_event ? 1 : 0;
    if (![2, 5].includes(req.session.user.type)) {
        isAdminEvent = 0;
    }

    try {
        const [result] = await pool.query(
            `INSERT INTO events (
                title, description, event_type_id, department_id, subject_id,
                start_datetime, end_datetime, location, level, status,
                target_audience_type, target_audience_id, is_admin_event, is_registration_enabled, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
            [
                title, description, event_type_id, department_id || null, subject_id || null,
                start_datetime, end_datetime, location, level || 'school',
                target_audience_type, target_audience_id || null,
                isAdminEvent, // принудительно установлено
                is_registration_enabled ? 1 : 0,
                req.session.user.id
            ]
        );
        const eventId = result.insertId;
        mlog(`Мероприятие "${title}" создано пользователем ${req.session.user.name}`);

        // Уведомление всем администраторам (type = 5)
        const [admins] = await pool.query('SELECT id FROM users WHERE type = 5');
        for (const admin of admins) {
            await createNotification(
                admin.id,
                eventId,
                'new_event',
                `Новое мероприятие "${title}" ожидает модерации от ${req.session.user.name}`
            );
        }

        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка создания мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Редактирование мероприятия (страница) -----
app.get('/events/edit/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        // Проверяем доступ (создатель или админ)
        const [events] = await pool.query(
            `SELECT * FROM events WHERE id = ? AND (created_by = ? OR ? = 5)`,
            [eventId, req.session.user.id, req.session.user.type]
        );
        if (events.length === 0) {
            return res.status(404).send('Мероприятие не найдено или доступ запрещён');
        }
        const event = events[0];

        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM departments WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM departments WHERE type = 2 ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, name, type 
            FROM users 
            WHERE type IN (1, 2) 
            ORDER BY name
        `);

        res.render('events/edit', {
            title: 'Редактирование мероприятия',
            event,
            types,
            classes,
            departments,
            subjects: subjects || [],
            users
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки редактирования', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Обновление мероприятия (для создателя или админа) -----
app.post('/events/edit/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, is_admin_event,
        is_registration_enabled 
    } = req.body;

    try {
        // Проверяем доступ: создатель или админ (type=5)
        const [check] = await pool.query(
            `SELECT created_by FROM events WHERE id = ? AND (created_by = ? OR ? = 5)`,
            [eventId, req.session.user.id, req.session.user.type]
        );
        if (check.length === 0) {
            return res.status(403).send('Доступ запрещён');
        }

        // Принудительно сбрасываем is_admin_event для учеников и родителей
        let isAdminEvent = is_admin_event ? 1 : 0;
        if (![2, 5].includes(req.session.user.type)) {
            isAdminEvent = 0;
        }

        await pool.query(
            `UPDATE events SET 
                title = ?, description = ?, event_type_id = ?, department_id = ?, subject_id = ?,
                start_datetime = ?, end_datetime = ?, location = ?, level = ?,
                target_audience_type = ?, target_audience_id = ?, is_admin_event = ?, is_registration_enabled = ?,
                status = 'pending', approved_by = NULL, rejection_reason = NULL
             WHERE id = ?`,
            [
                title, description, event_type_id, department_id || null, subject_id || null,
                start_datetime, end_datetime, location, level || 'school',
                target_audience_type, target_audience_id || null,
                isAdminEvent,
                is_registration_enabled ? 1 : 0,
                eventId
            ]
        );
        mlog(`Мероприятие ${eventId} обновлено пользователем ${req.session.user.name}`);
        
        // Уведомление администраторам
        const [admins] = await pool.query('SELECT id FROM users WHERE type = 5');
        for (const admin of admins) {
            await createNotification(
                admin.id,
                eventId,
                'edited',
                `Мероприятие "${title}" изменено и снова ожидает модерации`
            );
        }

        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка обновления мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Мои мероприятия (для всех ролей) -----
app.get('/my-events', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userType = req.session.user.type;
        let events = [];
        let title = 'Мои мероприятия';

        if (userType === 1) { // Ученик – видит свои созданные и те, на которые записан
            [events] = await pool.query(`
                SELECT DISTINCT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled,
                       CASE 
                           WHEN e.end_datetime < NOW() THEN 'Завершено'
                           ELSE 'Записан'
                       END as participation_status
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
                WHERE e.created_by = ? OR ep.user_id = ?
                ORDER BY e.start_datetime DESC
            `, [userId, userId, userId]);
            title = 'Мои мероприятия';

        } else if (userType === 6) { // Родитель – видит свои созданные и мероприятия детей
            [events] = await pool.query(`
                SELECT DISTINCT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled,
                       s.name as student_name
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                LEFT JOIN event_participants ep ON e.id = ep.event_id
                LEFT JOIN users s ON ep.user_id = s.id
                WHERE e.created_by = ? 
                   OR ep.user_id IN (SELECT student_id FROM parent_student WHERE parent_id = ?)
                ORDER BY e.start_datetime DESC
            `, [userId, userId]);
            title = 'Мероприятия моих детей';

        } else if (userType === 2 || userType === 5) { // Учитель или Админ
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                ORDER BY e.created_at DESC
            `, [userId]);
            title = userType === 5 ? 'Мои мероприятия (как администратор)' : 'Мои мероприятия (как организатор)';
        }

        res.render('events/my-events', {
            title: title,
            events: events,
            userType: userType
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки моих мероприятий', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Модерация -----
app.get('/events/moderation', isAdmin, async (req, res) => {
    try {
        const [events] = await pool.query(`
            SELECT e.*, u.name as creator_name, et.name as type_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE e.status = 'pending'
            ORDER BY e.created_at DESC
        `);
        res.render('events/moderation', {
            title: 'Модерация мероприятий',
            events
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки модерации', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/events/moderation/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { action, rejection_reason } = req.body;

    try {
        const [eventRows] = await pool.query(
            'SELECT title, created_by FROM events WHERE id = ?',
            [id]
        );
        if (eventRows.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }
        const { title, created_by } = eventRows[0];

        if (action === 'approve') {
            await pool.query(
                'UPDATE events SET status = "approved", approved_by = ? WHERE id = ?',
                [req.session.user.id, id]
            );
            mlog(`Мероприятие ${id} утверждено`);
            await createNotification(
                created_by,
                id,
                'approved',
                `Ваше мероприятие "${title}" утверждено!`
            );
        } else if (action === 'reject') {
            await pool.query(
                'UPDATE events SET status = "rejected", rejection_reason = ? WHERE id = ?',
                [rejection_reason || 'Без указания причины', id]
            );
            mlog(`Мероприятие ${id} отклонено`);
            await createNotification(
                created_by,
                id,
                'rejected',
                `Ваше мероприятие "${title}" отклонено. Причина: ${rejection_reason || 'не указана'}`
            );
        }
        res.redirect('/events/moderation');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка модерации', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Архив мероприятий -----
app.get('/events/archive', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userType = req.session.user.type;
        let events = [];

        if (userType === 1) { // Ученик
            [events] = await pool.query(`
                SELECT DISTINCT e.*, u.name as creator_name, et.name as type_name,
                        e.is_registration_enabled,
                        CASE 
                            WHEN e.status = 'completed' THEN 'Участвовал'
                            WHEN e.status = 'canceled' THEN 'Отменено'
                        END as participation_status
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
                WHERE (e.created_by = ? OR ep.user_id = ?)
                  AND e.end_datetime < NOW()
                  AND e.status IN ('completed', 'canceled')
                ORDER BY e.end_datetime DESC
            `, [userId, userId, userId]);

        } else if (userType === 6) { // Родитель – пока без parent_student, просто покажем все завершённые
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.end_datetime < NOW()
                  AND e.status IN ('completed', 'canceled')
                ORDER BY e.end_datetime DESC
            `);

        } else if (userType === 2 || userType === 5) { // Учитель или Админ
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled,
                       (SELECT COUNT(*) FROM event_participants WHERE event_id = e.id) as participants_count,
                       CASE 
                           WHEN e.status = 'completed' THEN 'Завершено'
                           WHEN e.status = 'canceled' THEN 'Отменено'
                       END as participation_status
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                  AND e.end_datetime < NOW()
                  AND e.status IN ('completed', 'canceled')
                ORDER BY e.end_datetime DESC
            `, [userId]);
        }

        res.render('events/archive', {
            title: 'Архив мероприятий',
            events: events,
            userType: userType
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки архива', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ============================================================
// ===== API: КАЛЕНДАРЬ =====
// ============================================================

app.get('/api/events', isAuthenticated, async (req, res) => {
    try {
        const user = req.session.user;
        const search = req.query.search || '';
        const status = req.query.status || 'all';
        const type = req.query.type || 'all';

        let sql = `
            SELECT e.*, u.name as creator_name, et.name as type_name,
                   e.is_registration_enabled
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE 1=1
        `;
        const params = [];

        let visibilityCondition = `
            (
                e.status = 'approved'
                OR (e.status = 'pending' AND e.created_by = ?)
                OR (e.status = 'pending' AND ? = 5)
            )
        `;
        params.push(user.id, user.type);

        // Фильтр по аудитории для не-админов
        if (user.type !== 5) {
            visibilityCondition += `
                AND (
                    e.created_by = ?
                    OR e.status != 'approved'
                )
            `;
            params.push(user.id);

            if (user.type === 1) { // Ученик
                // У ученика есть kaf – это id его класса
                visibilityCondition += `
                    OR (
                        e.status = 'approved'
                        AND (
                            e.target_audience_type = 'all'
                            OR (e.target_audience_type = 'class' AND e.target_audience_id = ?)
                            OR (e.target_audience_type = 'specific_users' AND e.target_audience_id = ?)
                        )
                    )
                `;
                params.push(user.kaf, user.id);
            } else if (user.type === 6) { // Родитель – временно показываем все утверждённые
                // Родитель видит все утверждённые мероприятия, но позже можно добавить фильтр по детям
                visibilityCondition += `
                    OR (e.status = 'approved')
                `;
            } else if (user.type === 2) { // Учитель
                // У учителя kaf – это id его кафедры
                visibilityCondition += `
                    OR (
                        e.status = 'approved'
                        AND (
                            e.target_audience_type = 'all'
                            OR (e.target_audience_type = 'department' AND e.target_audience_id = ?)
                            OR (e.target_audience_type = 'specific_users' AND e.target_audience_id = ?)
                        )
                    )
                `;
                params.push(user.kaf, user.id);
            }
        }

        sql += ` AND (${visibilityCondition})`;

        // Скрываем админские события от учеников и родителей
        if ([1, 6].includes(user.type)) {
            sql += ' AND e.is_admin_event = 0';
        }

        // Фильтры
        if (status !== 'all') {
            sql += ' AND e.status = ?';
            params.push(status);
        }
        if (type !== 'all') {
            sql += ' AND e.event_type_id = ?';
            params.push(type);
        }
        if (search) {
            sql += ' AND (e.title LIKE ? OR e.description LIKE ?)';
            const like = `%${search}%`;
            params.push(like, like);
        }

        sql += ' ORDER BY e.start_datetime';

        const [events] = await pool.query(sql, params);
        res.json(events);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения событий для календаря', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Запись на мероприятие -----
app.post('/api/events/:id/register', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT title, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0 || event[0].status !== 'approved') {
            return res.status(400).json({ error: 'Мероприятие недоступно для записи' });
        }

        const [existing] = await pool.query(
            'SELECT * FROM event_participants WHERE event_id = ? AND user_id = ?',
            [eventId, userId]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Вы уже записаны на это мероприятие' });
        }

        await pool.query(
            'INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)',
            [eventId, userId]
        );
        mlog(`Пользователь ${userId} записался на мероприятие ${eventId}`);
        
        await createNotification(
            userId,
            eventId,
            'registered',
            `Вы записались на мероприятие "${event[0].title}"`
        );

        res.json({ success: true, message: 'Вы записаны на мероприятие' });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка записи на мероприятие', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Проверка записи -----
app.get('/api/events/:id/is-registered', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [rows] = await pool.query(
            'SELECT id FROM event_participants WHERE event_id = ? AND user_id = ?',
            [eventId, userId]
        );
        res.json({ isRegistered: rows.length > 0 });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка проверки записи', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Отмена записи -----
app.post('/api/events/:id/unregister', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT title, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0 || event[0].status !== 'approved') {
            return res.status(400).json({ error: 'Нельзя отменить запись' });
        }

        const [result] = await pool.query(
            'DELETE FROM event_participants WHERE event_id = ? AND user_id = ?',
            [eventId, userId]
        );
        if (result.affectedRows === 0) {
            return res.status(400).json({ error: 'Вы не были записаны' });
        }
        mlog(`Пользователь ${userId} отменил запись на мероприятие ${eventId}`);
        res.json({ success: true, message: 'Запись отменена' });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка отмены записи', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Получение списка участников мероприятия -----
app.get('/api/events/:id/participants', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [participants] = await pool.query(`
            SELECT u.id, u.name, u.kaf, d.name as class_name
            FROM event_participants ep
            LEFT JOIN users u ON ep.user_id = u.id
            LEFT JOIN departments d ON u.kaf = d.id AND d.type = 1
            WHERE ep.event_id = ?
            ORDER BY u.name
        `, [eventId]);
        res.json(participants);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения участников', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Завершение мероприятия -----
app.post('/api/events/:id/complete', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).json({ error: 'Мероприятие не найдено' });
        }
        if (event[0].status !== 'approved') {
            return res.status(400).json({ error: 'Можно завершить только утверждённое мероприятие' });
        }
        if (event[0].created_by !== userId && req.session.user.type !== 5) {
            return res.status(403).json({ error: 'Нет прав' });
        }

        await pool.query(
            'UPDATE events SET status = "completed" WHERE id = ?',
            [eventId]
        );
        mlog(`Мероприятие ${eventId} завершено`);
        res.json({ success: true, message: 'Мероприятие завершено' });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка завершения', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Получение одного мероприятия -----
app.get('/api/events/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [events] = await pool.query(`
            SELECT e.*, u.name as creator_name, et.name as type_name,
                   e.is_registration_enabled
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE e.id = ?
        `, [eventId]);
        if (events.length === 0) {
            return res.status(404).json({ error: 'Мероприятие не найдено' });
        }
        res.json(events[0]);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения мероприятия', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================================
// ===== ЗАПУСК СЕРВЕРА =====
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    mlog(`Сервер запущен на http://localhost:${PORT}`);
    mlog('Школьный календарь готов к работе!');
});