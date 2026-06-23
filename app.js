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
import bcrypt from 'bcrypt';

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

// ----- Middleware проверки ролей -----
function isAuthenticated(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
}

function isAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).send('Доступ запрещен');
    }
    next();
}

function isTeacher(req, res, next) {
    if (!req.session.user || !['admin', 'teacher'].includes(req.session.user.role)) {
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
// ===== АУТЕНТИФИКАЦИЯ =====
// ============================================================

app.get('/auth/login', (req, res) => {
    res.render('auth/login', { title: 'Вход' });
});

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
            return res.render('auth/login', { error: 'Неверный email или пароль' });
        }
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.render('auth/login', { error: 'Неверный email или пароль' });
        }
        req.session.user = {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            class_id: user.class_id,
            department_id: user.department_id
        };
        mlog(`Пользователь ${user.email} вошел в систему`);
        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка входа', error);
        res.render('auth/login', { error: 'Ошибка сервера' });
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth/login');
});


// ============================================================
// ===== ПРОФИЛЬ =====
// ============================================================

app.get('/profile', isAuthenticated, (req, res) => {
    res.render('profile/index', { 
        title: 'Мой профиль',
        user: req.session.user
    });
});

// ============================================================
// ===== АДМИН: ПОЛЬЗОВАТЕЛИ =====
// ============================================================

app.get('/admin/users', isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT u.*, c.name as class_name, d.name as department_name
            FROM users u
            LEFT JOIN classes c ON u.class_id = c.id
            LEFT JOIN departments d ON u.department_id = d.id
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
    const { full_name, email, password, role, class_id, department_id } = req.body;
    
    try {
        // Проверяем, существует ли пользователь
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).send('Пользователь с таким email уже существует');
        }

        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);
        
        await pool.query(
            `INSERT INTO users (full_name, email, password_hash, role, class_id, department_id) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [full_name, email, password_hash, role || 'student', class_id || null, department_id || null]
        );
        
        mlog(`Администратор создал пользователя: ${email} (${role})`);
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
        // Не даем удалить самого себя
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
        const [classes] = await pool.query('SELECT * FROM classes ORDER BY grade_level, name');
        const [departments] = await pool.query('SELECT * FROM departments ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [eventTypes] = await pool.query('SELECT * FROM event_types ORDER BY name');
        
        res.render('admin/settings', { 
            title: 'Настройки системы',
            classes,
            departments,
            subjects,
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
            SELECT u.id, u.email, u.full_name, u.role, u.class_id, u.department_id,
                   c.name as class_name, d.name as department_name
            FROM users u
            LEFT JOIN classes c ON u.class_id = c.id
            LEFT JOIN departments d ON u.department_id = d.id
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

app.get('/events/create', isTeacher, async (req, res) => {
    try {
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM classes ORDER BY grade_level, name');
        const [departments] = await pool.query('SELECT * FROM departments ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, full_name, email, role 
            FROM users 
            WHERE role IN ('student', 'teacher') 
            ORDER BY full_name
        `);
        
        res.render('events/create', {
            title: 'Создание мероприятия',
            types,
            classes,
            departments,
            subjects,
            users
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки формы создания', error);
        res.status(500).send('Ошибка сервера');
    }
});
app.post('/events/create', isTeacher, async (req, res) => {
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, is_admin_event
    } = req.body;

    try {
        const [result] = await pool.query(
            `INSERT INTO events (
                title, description, event_type_id, department_id, subject_id,
                start_datetime, end_datetime, location, level, status,
                target_audience_type, target_audience_id, is_admin_event, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [
                title, description, event_type_id, department_id || null, subject_id || null,
                start_datetime, end_datetime, location, level || 'school',
                target_audience_type, target_audience_id || null,
                is_admin_event ? 1 : 0,
                req.session.user.id
            ]
        );
        const eventId = result.insertId;
        mlog(`Мероприятие "${title}" создано пользователем ${req.session.user.email}`);

        // Уведомление всем администраторам
        const [admins] = await pool.query('SELECT id FROM users WHERE role = "admin"');
        for (const admin of admins) {
            await createNotification(
                admin.id,
                eventId,
                'new_event',
                `Новое мероприятие "${title}" ожидает модерации от ${req.session.user.full_name}`
            );
        }

        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка создания мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Редактирование мероприятия (страница) -----
app.get('/events/edit/:id', isTeacher, async (req, res) => {
    const eventId = req.params.id;
    try {
        // Проверяем доступ (создатель или админ)
        const [events] = await pool.query(
            `SELECT * FROM events WHERE id = ? AND (created_by = ? OR ? = 'admin')`,
            [eventId, req.session.user.id, req.session.user.role]
        );
        if (events.length === 0) {
            return res.status(404).send('Мероприятие не найдено или доступ запрещён');
        }
        const event = events[0];

        // Справочники для формы
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM classes ORDER BY grade_level, name');
        const [departments] = await pool.query('SELECT * FROM departments ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`SELECT id, full_name, email FROM users WHERE role IN ('student','teacher') ORDER BY full_name`);

        res.render('events/edit', {
            title: 'Редактирование мероприятия',
            event,
            types,
            classes,
            departments,
            subjects,
            users
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки редактирования', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Обновление мероприятия -----
app.post('/events/edit/:id', isTeacher, async (req, res) => {
    const eventId = req.params.id;
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, is_admin_event
    } = req.body;

    try {
        // Проверяем доступ
        const [check] = await pool.query(
            `SELECT created_by FROM events WHERE id = ? AND (created_by = ? OR ? = 'admin')`,
            [eventId, req.session.user.id, req.session.user.role]
        );
        if (check.length === 0) {
            return res.status(403).send('Доступ запрещён');
        }

        // Обновляем, сбрасываем статус на pending (если был утверждён)
        await pool.query(
            `UPDATE events SET 
                title = ?, description = ?, event_type_id = ?, department_id = ?, subject_id = ?,
                start_datetime = ?, end_datetime = ?, location = ?, level = ?,
                target_audience_type = ?, target_audience_id = ?, is_admin_event = ?,
                status = 'pending', approved_by = NULL, rejection_reason = NULL
             WHERE id = ?`,
            [
                title, description, event_type_id, department_id || null, subject_id || null,
                start_datetime, end_datetime, location, level || 'school',
                target_audience_type, target_audience_id || null,
                is_admin_event ? 1 : 0,
                eventId
            ]
        );
        mlog(`Мероприятие ${eventId} обновлено пользователем ${req.session.user.email}`);
        
        // Уведомление администраторам (опционально)
        const [admins] = await pool.query('SELECT id FROM users WHERE role = "admin"');
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

// ----- Модерация -----
app.get('/events/moderation', isAdmin, async (req, res) => {
    try {
        const [events] = await pool.query(`
            SELECT e.*, u.full_name as creator_name, et.name as type_name
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
        // Получаем информацию о мероприятии
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

// ----- Архив -----
app.get('/events/archive', isAuthenticated, async (req, res) => {
    try {
        const [events] = await pool.query(`
            SELECT e.*, u.full_name as creator_name, et.name as type_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE e.status IN ('completed', 'canceled')
            ORDER BY e.end_datetime DESC
        `);
        res.render('events/archive', {
            title: 'Архив мероприятий',
            events
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
        let query = `
            SELECT e.*, u.full_name as creator_name, et.name as type_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE (e.status = 'approved' 
                   OR (e.status = 'pending' AND e.created_by = ?))
        `;
        const params = [user.id];

        // Дополнительные фильтры по ролям
        if (user.role === 'student' && user.class_id) {
            query += ` AND (
                e.target_audience_type = 'all' 
                OR (e.target_audience_type = 'class' AND e.target_audience_id = ?)
                OR (e.target_audience_type = 'parallel' AND e.target_audience_id = (SELECT grade_level FROM classes WHERE id = ?))
                OR (e.target_audience_type = 'specific_users' AND e.target_audience_id = ?)
            )`;
            params.push(user.class_id, user.class_id, user.id);
        } else if (user.role === 'parent') {
            query += ` AND (
                e.target_audience_type = 'all'
                OR e.target_audience_id IN (SELECT student_id FROM parent_student WHERE parent_id = ?)
                OR (e.target_audience_type = 'specific_users' AND e.target_audience_id IN (SELECT student_id FROM parent_student WHERE parent_id = ?))
            )`;
            params.push(user.id, user.id);
        } else if (user.role === 'teacher' && user.department_id) {
            query += ` AND (
                e.target_audience_type = 'all'
                OR (e.target_audience_type = 'department' AND e.target_audience_id = ?)
                OR (e.target_audience_type = 'specific_users' AND e.target_audience_id = ?)
            )`;
            params.push(user.department_id, user.id);
        }

        if (['student', 'parent'].includes(user.role)) {
            query += ' AND e.is_admin_event = 0';
        }

        query += ' ORDER BY e.start_datetime';

        const [events] = await pool.query(query, params);
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
        
        // Уведомление ученику
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

// ============================================================
// ===== ЗАПУСК СЕРВЕРА =====
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    mlog(`Сервер запущен на http://localhost:${PORT}`);
    mlog('Школьный календарь готов к работе!');
});