import express from 'express';
import session from 'express-session';
import { engine } from 'express-handlebars';
import handlebars from 'handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cron from 'node-cron';
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
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Middleware для уведомлений
app.use(async (req, res, next) => {
    if (req.session.user) {
        try {
            const [notifications] = await pool.query(
                `SELECT * FROM notifications 
                 WHERE user_id = ? 
                 ORDER BY created_at DESC 
                 LIMIT 5`,
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

// ----- Дополнительные данные для родителя (класс ребёнка) -----
app.use(async (req, res, next) => {
    if (req.session.user && req.session.user.type === 6) {
        try {
            const [children] = await pool.query(
                `SELECT u.kaf, k.name as class_name
                 FROM parent_student ps
                 JOIN users u ON ps.student_id = u.id
                 LEFT JOIN kaf_name k ON u.kaf = k.id
                 WHERE ps.parent_id = ?`,
                [req.session.user.id]
            );
            if (children.length > 0) {
                const classNames = children.map(c => c.class_name).filter(c => c).join(', ');
                req.session.user.child_kaf_name = classNames || 'Не указан';
            } else {
                req.session.user.child_kaf_name = 'Не указан';
            }
            res.locals.user = req.session.user;
        } catch (error) {
            mlog('[ERROR]', 'Ошибка загрузки класса ребёнка для родителя', error);
            req.session.user.child_kaf_name = 'Ошибка загрузки';
            res.locals.user = req.session.user;
        }
    }
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
    if (!req.session.user || ![2, 3, 4, 5].includes(req.session.user.type)) {
        return res.status(403).send('Доступ запрещен');
    }
    next();
}

function isDirector(req, res, next) {
    if (!req.session.user || req.session.user.type !== 7) {
        return res.status(403).send('Доступ запрещен');
    }
    next();
}

function isAdminOrDirector(req, res, next) {
    if (!req.session.user || ![5, 7].includes(req.session.user.type)) {
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

// ----- Автоматическое завершение мероприятий -----
async function autoCompleteEvents() {
    try {
        const now = new Date();
        const nowStr = now.getFullYear() + '-' +
                       String(now.getMonth() + 1).padStart(2, '0') + '-' +
                       String(now.getDate()).padStart(2, '0') + ' ' +
                       String(now.getHours()).padStart(2, '0') + ':' +
                       String(now.getMinutes()).padStart(2, '0') + ':' +
                       String(now.getSeconds()).padStart(2, '0');

        const [events] = await pool.query(`
            SELECT id, title, created_by 
            FROM events 
            WHERE status = 'APPROVED' AND end_datetime < ?
        `, [nowStr]);

        console.log(`🔍 Найдено мероприятий для завершения: ${events.length}`);
        if (events.length === 0) return;

        for (const event of events) {
            await pool.query('UPDATE events SET status = "COMPLETED" WHERE id = ?', [event.id]);

            await createNotification(
                event.created_by,
                event.id,
                'completed',
                `Мероприятие "${event.title}" автоматически завершено.`
            );

            const [participants] = await pool.query(
                'SELECT DISTINCT user_id FROM event_participants WHERE event_id = ?',
                [event.id]
            );
            for (const p of participants) {
                if (p.user_id !== event.created_by) {
                    await createNotification(
                        p.user_id,
                        event.id,
                        'completed',
                        `Мероприятие "${event.title}" завершено.`
                    );
                }
            }
        }

        mlog(`Автоматически завершено ${events.length} мероприятий.`);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка при автоматическом завершении мероприятий', error);
    }
}

// ===== ОТПРАВКА НАПОМИНАНИЙ О МЕРОПРИЯТИЯХ =====
async function sendEventReminders() {
    try {
        const now = new Date();
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
        
        const formatMySQL = (date) => {
            return date.getFullYear() + '-' +
                   String(date.getMonth() + 1).padStart(2, '0') + '-' +
                   String(date.getDate()).padStart(2, '0') + ' ' +
                   String(date.getHours()).padStart(2, '0') + ':' +
                   String(date.getMinutes()).padStart(2, '0') + ':' +
                   String(date.getSeconds()).padStart(2, '0');
        };
        
        const nowStr = formatMySQL(now);
        const oneHourLaterStr = formatMySQL(oneHourLater);
        
        const [events] = await pool.query(`
            SELECT e.id, e.title, e.start_datetime, e.created_by
            FROM events e
            WHERE e.status = 'APPROVED'
              AND e.start_datetime > ? 
              AND e.start_datetime <= ?
              AND NOT EXISTS (
                  SELECT 1 FROM notifications n 
                  WHERE n.event_id = e.id 
                    AND n.type = 'reminder'
                    AND n.user_id = e.created_by
              )
        `, [nowStr, oneHourLaterStr]);

        console.log(`🔔 Найдено мероприятий для напоминания: ${events.length}`);
        
        if (events.length === 0) return;

        for (const event of events) {
            const [participants] = await pool.query(
                'SELECT DISTINCT user_id FROM event_participants WHERE event_id = ?',
                [event.id]
            );
            
            const recipients = new Set();
            recipients.add(event.created_by);
            participants.forEach(p => recipients.add(p.user_id));
            
            const startTime = new Date(event.start_datetime);
            const timeStr = startTime.toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            
            const message = `⏰ Напоминание: мероприятие "${event.title}" начнётся в ${timeStr}. Не пропустите!`;
            
            for (const userId of recipients) {
                const [existing] = await pool.query(
                    'SELECT id FROM notifications WHERE event_id = ? AND user_id = ? AND type = "reminder"',
                    [event.id, userId]
                );
                
                if (existing.length === 0) {
                    await createNotification(
                        userId,
                        event.id,
                        'reminder',
                        message
                    );
                    console.log(`📨 Напоминание отправлено пользователю ${userId} о событии ${event.id}`);
                }
            }
        }
        
        console.log(`✅ Напоминания отправлены для ${events.length} мероприятий`);
        
    } catch (error) {
        mlog('[ERROR]', 'Ошибка при отправке напоминаний', error);
    }
}

// Запуск cron-задач
cron.schedule('0 * * * *', autoCompleteEvents);
console.log('✅ Cron-задача autoCompleteEvents зарегистрирована! Будет запускаться каждый час в 00 минут.');
console.log(`⏰ Следующий запуск: ${new Date(new Date().setHours(new Date().getHours() + 1, 0, 0, 0)).toLocaleString()}`);

cron.schedule('*/15 * * * *', sendEventReminders);
console.log('✅ Cron-задача sendEventReminders зарегистрирована! (каждые 15 минут)');

// ============================================================
// ===== МАРШРУТЫ =====
// ============================================================

// ----- Главная страница / Календарь -----
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        res.render('calendar/index', { 
            title: 'Календарь мероприятий',
            types: types
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки типов для календаря', error);
        res.render('calendar/index', { 
            title: 'Календарь мероприятий',
            types: []
        });
    }
});

// ============================================================
// ===== АУТЕНТИФИКАЦИЯ =====
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
             JOIN role_name r ON u.type = r.id 
             WHERE u.name = ? AND u.pin = ?`,
            [name, pin]
        );
        if (rows.length === 0) {
            return res.render('auth/login', { error: 'Неверное имя или PIN-код' });
        }
        const user = rows[0];
        
        let kaf_name = null;
        if (user.kaf) {
            const [kafRows] = await pool.query(
                'SELECT name FROM kaf_name WHERE id = ?',
                [user.kaf]
            );
            if (kafRows.length > 0) {
                kaf_name = kafRows[0].name;
            }
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            kaf: user.kaf,
            kaf_name: kaf_name,
            type: parseInt(user.type, 10), 
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

app.get('/admin/users', isAdminOrDirector, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT u.*, d.name as kaf_name, r.name as role_name
            FROM users u
            LEFT JOIN kaf_name d ON u.kaf = d.id
            JOIN role_name r ON u.type = r.id
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

app.post('/admin/users/create', isAdminOrDirector, async (req, res) => {
    const { name, pin, type, kaf } = req.body;
    
    try {
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

app.post('/admin/users/delete/:id', isAdminOrDirector, async (req, res) => {
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

app.get('/admin/settings', isAdminOrDirector, async (req, res) => {
    try {
        const [classes] = await pool.query('SELECT * FROM kaf_name WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM kaf_name WHERE type = 2 ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects');
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

app.get('/api/admin/users', isAdminOrDirector, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT u.id, u.name, u.kaf, u.type, u.pin,
                   d.name as kaf_name, r.name as role_name
            FROM users u
            LEFT JOIN kaf_name d ON u.kaf = d.id
            JOIN role_name r ON u.type = r.id
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
        const [classes] = await pool.query('SELECT * FROM kaf_name WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM kaf_name WHERE type = 2 ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, name, type 
            FROM users 
            WHERE type IN (1, 2, 3, 4, 5, 6)
            ORDER BY name
        `);
        
        res.render('events/create', {
            title: 'Создание мероприятия',
            types,
            classes,
            departments,
            subjects: subjects || [],
            users,
            selectedIds: [], 
            selectedClassIds: [], 
            selectedResponsibleIds: []
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки формы создания', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Создание мероприятия (POST) -----
app.post('/events/create', isAuthenticated, async (req, res) => {
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, target_audience_ids,
        is_admin_event, is_registration_enabled, enable_rewards,
        reward_type, places_count, responsible_ids
    } = req.body;

    // Преобразуем target_audience_id в зависимости от типа
    let targetAudienceId = null;
    if (target_audience_type === 'specific_users' || target_audience_type === 'multiple_classes') {
        targetAudienceId = target_audience_ids || null;
        if (Array.isArray(targetAudienceId)) {
            targetAudienceId = targetAudienceId.filter(id => id).join(',');
        }
    } else {
        targetAudienceId = target_audience_id || null;
    }

    // Ответственные – если пришли как массив, склеиваем через запятую
    let responsibleIds = null;
    if (responsible_ids) {
        if (Array.isArray(responsible_ids)) {
            responsibleIds = responsible_ids.filter(id => id).join(',');
        } else {
            responsibleIds = responsible_ids;
        }
    }

    // is_admin_event для учеников и родителей = 0
    let isAdminEvent = is_admin_event ? 1 : 0;
    if (![2, 3, 4, 5].includes(req.session.user.type)) {
        isAdminEvent = 0;
    }

    // Обработка наград
    let rewardType = 'none';
    let rewardPlaces = null;
    if (enable_rewards) {
        rewardType = reward_type || 'educational';
        if (rewardType === 'competitive') {
            rewardPlaces = parseInt(places_count) || 3;
        }
    }

    try {
        // Вставляем мероприятие со статусом WAITING_ADMIN
        const [result] = await pool.query(
            `INSERT INTO events (
                title, description, event_type_id, department_id, subject_id,
                start_datetime, end_datetime, location, level, status,
                target_audience_type, target_audience_id, is_admin_event, is_registration_enabled,
                reward_type, reward_places, created_by, responsible_ids
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_ADMIN', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                title, description, event_type_id, department_id || null, subject_id || null,
                start_datetime, end_datetime, location, level || 'school',
                target_audience_type, targetAudienceId,
                isAdminEvent,
                is_registration_enabled ? 1 : 0,
                rewardType,
                rewardPlaces,
                req.session.user.id,
                responsibleIds
            ]
        );
        const eventId = result.insertId;
        mlog(`Мероприятие "${title}" создано пользователем ${req.session.user.name}`);

        // Создаём записи в event_approvals для всех админов и директора
        const [approvers] = await pool.query(
            'SELECT id, type FROM users WHERE type IN (5, 7)'
        );

        for (const user of approvers) {
            const roleType = user.type === 7 ? 'director' : 'admin';
            await pool.query(
                `INSERT INTO event_approvals (event_id, user_id, role_type, status, order_index)
                 VALUES (?, ?, ?, 'pending', ?)`,
                [eventId, user.id, roleType, 0]
            );
        }

        // ---- Уведомление ТОЛЬКО администраторам (не директору) ----
        const [admins] = await pool.query('SELECT id FROM users WHERE type = 5');
        for (const admin of admins) {
            await createNotification(
                admin.id,
                eventId,
                'new_event',
                `Новое мероприятие "${title}" ожидает утверждения администраторами`
            );
        }
        // ----------------------------------------------------------------

        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка создания мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Копирование мероприятия (для повторной отправки после отклонения) -----
app.get('/events/copy/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;
    const userType = req.session.user.type;

    try {
        const [events] = await pool.query(
            'SELECT * FROM events WHERE id = ?',
            [eventId]
        );
        if (events.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }
        const event = events[0];

        // Проверка прав: только создатель или администратор/директор
        const isCreator = event.created_by === userId;
        const isAdminOrDirector = [5, 7].includes(userType);
        if (!isCreator && !isAdminOrDirector) {
            return res.status(403).send('Нет прав на копирование');
        }

        // Получаем справочники
        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM kaf_name WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM kaf_name WHERE type = 2 ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, name, type 
            FROM users 
            WHERE type IN (1, 2, 3, 4, 5, 6)
            ORDER BY name
        `);

        // Подготовка выбранных ID для множественного выбора
        let selectedIds = [];
        if (event.target_audience_type === 'specific_users' && event.target_audience_id) {
            selectedIds = String(event.target_audience_id).split(',').map(id => parseInt(id));
        }
        let selectedClassIds = [];
        if (event.target_audience_type === 'multiple_classes' && event.target_audience_id) {
            selectedClassIds = String(event.target_audience_id).split(',').map(id => parseInt(id));
        }
        let selectedResponsibleIds = [];
        if (event.responsible_ids) {
            selectedResponsibleIds = String(event.responsible_ids).split(',').map(id => parseInt(id));
        }

        // Передаём данные в шаблон как event (для предзаполнения полей) и дополнительные ID
        res.render('events/create', {
            title: 'Повтор заявки (исправление)',
            types,
            classes,
            departments,
            subjects: subjects || [],
            users,
            event: event, // для заполнения полей
            selectedIds: selectedIds,
            selectedClassIds: selectedClassIds,
            selectedResponsibleIds: selectedResponsibleIds,
            isCopy: true // флаг, чтобы знать, что это копирование (можно использовать для изменения текста кнопки)
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка при копировании мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/events/edit/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [events] = await pool.query(
            `SELECT * FROM events WHERE id = ? AND (created_by = ? OR ? = 5)`,
            [eventId, req.session.user.id, req.session.user.type]
        );
        if (events.length === 0) {
            return res.status(404).send('Мероприятие не найдено или доступ запрещён');
        }
        const event = events[0];

        const [types] = await pool.query('SELECT * FROM event_types ORDER BY name');
        const [classes] = await pool.query('SELECT * FROM kaf_name WHERE type = 1 ORDER BY name');
        const [departments] = await pool.query('SELECT * FROM kaf_name WHERE type = 2 ORDER BY name');
        const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY name');
        const [users] = await pool.query(`
            SELECT id, name, type 
            FROM users 
            WHERE type IN (1, 2, 3, 4, 5, 6)
            ORDER BY name
        `);

        let selectedIds = [];
        if (event.target_audience_type === 'specific_users' && event.target_audience_id) {
            selectedIds = String(event.target_audience_id).split(',').map(id => parseInt(id));
        }

        let selectedClassIds = [];
        if (event.target_audience_type === 'multiple_classes' && event.target_audience_id) {
            selectedClassIds = String(event.target_audience_id).split(',').map(id => parseInt(id));
        }

        let selectedResponsibleIds = [];
        if (event.responsible_ids) {
            selectedResponsibleIds = String(event.responsible_ids).split(',').map(id => parseInt(id));
        }

        res.render('events/edit', {
            title: 'Редактирование мероприятия',
            event,
            types,
            classes,
            departments,
            subjects: subjects || [],
            users,
            selectedIds,
            selectedClassIds,
            selectedResponsibleIds
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки редактирования', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/events/edit/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const {
        title, description, event_type_id, department_id, subject_id,
        start_datetime, end_datetime, location, level,
        target_audience_type, target_audience_id, target_audience_ids,
        is_admin_event, is_registration_enabled, enable_rewards,
        reward_type, places_count, responsible_ids
    } = req.body;

    try {
        const [check] = await pool.query(
            `SELECT created_by FROM events WHERE id = ? AND (created_by = ? OR ? = 5)`,
            [eventId, req.session.user.id, req.session.user.type]
        );
        if (check.length === 0) {
            return res.status(403).send('Доступ запрещён');
        }

        let targetAudienceId = null;
        if (target_audience_type === 'specific_users' || target_audience_type === 'multiple_classes') {
            targetAudienceId = target_audience_ids || null;
            if (Array.isArray(targetAudienceId)) {
                targetAudienceId = targetAudienceId.filter(id => id).join(',');
            }
        } else {
            targetAudienceId = target_audience_id || null;
        }

        let responsibleIds = null;
        if (responsible_ids) {
            if (Array.isArray(responsible_ids)) {
                responsibleIds = responsible_ids.filter(id => id).join(',');
            } else {
                responsibleIds = responsible_ids;
            }
        }

        let isAdminEvent = is_admin_event ? 1 : 0;
        if (![2, 3, 4, 5].includes(req.session.user.type)) {
            isAdminEvent = 0;
        }

        let rewardType = 'none';
        let rewardPlaces = null;
        if (enable_rewards) {
            rewardType = reward_type || 'educational';
            if (rewardType === 'competitive') {
                rewardPlaces = parseInt(places_count) || 3;
            }
        }

        // Начинаем транзакцию
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Обновляем событие
            await connection.query(
                `UPDATE events SET 
                    title = ?, description = ?, event_type_id = ?, department_id = ?, subject_id = ?,
                    start_datetime = ?, end_datetime = ?, location = ?, level = ?,
                    target_audience_type = ?, target_audience_id = ?, is_admin_event = ?, is_registration_enabled = ?,
                    reward_type = ?, reward_places = ?, responsible_ids = ?,
                    status = 'WAITING_ADMIN', approved_by = NULL, rejection_reason = NULL
                 WHERE id = ?`,
                [
                    title, description, event_type_id, department_id || null, subject_id || null,
                    start_datetime, end_datetime, location, level || 'school',
                    target_audience_type, targetAudienceId,
                    isAdminEvent,
                    is_registration_enabled ? 1 : 0,
                    rewardType,
                    rewardPlaces,
                    responsibleIds,
                    eventId
                ]
            );

            // Обновляем event_approvals: удаляем старые и создаём новые
            await connection.query('DELETE FROM event_approvals WHERE event_id = ?', [eventId]);

            const [approvers] = await connection.query('SELECT id, type FROM users WHERE type IN (5, 7)');
            for (const user of approvers) {
                const roleType = user.type === 7 ? 'director' : 'admin';
                await connection.query(
                    `INSERT INTO event_approvals (event_id, user_id, role_type, status, order_index)
                     VALUES (?, ?, ?, 'pending', 0)`,
                    [eventId, user.id, roleType]
                );
            }

            await connection.commit();

            mlog(`Мероприятие ${eventId} обновлено пользователем ${req.session.user.name}`);

            // ---- Уведомление ТОЛЬКО администраторам (не директору) ----
            const [admins] = await pool.query('SELECT id FROM users WHERE type = 5');
            for (const admin of admins) {
                await createNotification(
                    admin.id,
                    eventId,
                    'edited',
                    `Мероприятие "${title}" изменено и снова ожидает утверждения администраторами`
                );
            }
            // ----------------------------------------------------------------

            res.redirect('/');

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        mlog('[ERROR]', 'Ошибка обновления мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Мои мероприятия -----
app.get('/my-events', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userType = req.session.user.type;
        let events = [];
        let title = 'Мои мероприятия';

        if (userType === 1) { // Ученик
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
                WHERE (e.created_by = ? OR ep.user_id = ?)
                  AND e.status IN ('WAITING_ADMIN', 'WAITING_DIRECTOR', 'APPROVED')
                ORDER BY e.start_datetime DESC
            `, [userId, userId, userId]);
            title = 'Мои мероприятия';

        } else if (userType === 6) { // Родитель – только свои созданные мероприятия
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                  AND e.status IN ('WAITING_ADMIN', 'WAITING_DIRECTOR', 'APPROVED')
                ORDER BY e.created_at DESC
            `, [userId]);
            title = 'Мои мероприятия';

        } else if ([2, 3, 4, 5, 7].includes(userType)) { // Педагоги, Наставник, Тьютор, Админ, Директор
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                  AND e.status IN ('WAITING_ADMIN', 'WAITING_DIRECTOR', 'APPROVED')
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

// ----- Мероприятия ребёнка -----
app.get('/child-events', isAuthenticated, async (req, res) => {
    const parentId = req.session.user.id;
    const userType = req.session.user.type;

    if (userType !== 6) {
        return res.status(403).send('Доступ запрещён');
    }

    try {
        const [children] = await pool.query(
            `SELECT student_id FROM parent_student WHERE parent_id = ?`,
            [parentId]
        );

        if (children.length === 0) {
            return res.render('events/child-events', {
                title: 'Мероприятия ребёнка',
                events: [],
                message: 'У вас ещё нет привязанных детей.'
            });
        }

        const childIds = children.map(c => c.student_id);
        const placeholders = childIds.map(() => '?').join(',');

        const params = [...childIds, ...childIds];

        const [events] = await pool.query(`
            SELECT DISTINCT e.*,
                   u.name as creator_name,
                   et.name as type_name,
                   e.is_registration_enabled,
                   s.name as student_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            LEFT JOIN event_participants ep ON e.id = ep.event_id
            LEFT JOIN users s ON ep.user_id = s.id
            WHERE (ep.user_id IN (${placeholders}) OR e.created_by IN (${placeholders}))
              AND e.status IN ('APPROVED', 'COMPLETED', 'CANCELED', 'WAITING_ADMIN', 'WAITING_DIRECTOR')
            ORDER BY e.start_datetime DESC
        `, params);

        res.render('events/child-events', {
            title: 'Мероприятия ребёнка',
            events: events,
            message: null
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки мероприятий ребёнка', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Модерация -----
// ----- Модерация -----
app.get('/events/moderation', isAdminOrDirector, async (req, res) => {
    const userRole = req.session.user.type;
    let statuses = [];
    
    // Определяем, какие статусы показывать в зависимости от роли
    if (userRole === 5) { // Администратор
        statuses = ['WAITING_ADMIN', 'WAITING_DIRECTOR'];
    } else if (userRole === 7) { // Директор
        statuses = ['WAITING_DIRECTOR'];
    } else {
        return res.status(403).send('Доступ запрещён');
    }

    try {
        const [events] = await pool.query(`
            SELECT e.*, u.name as creator_name, et.name as type_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE e.status IN (?)
            ORDER BY 
                CASE e.status 
                    WHEN 'WAITING_ADMIN' THEN 1 
                    WHEN 'WAITING_DIRECTOR' THEN 2 
                END,
                e.created_at DESC
        `, [statuses]);
        
        // Для каждого события загружаем статусы утверждений
        for (let event of events) {
            const [approvals] = await pool.query(`
                SELECT 
                    u.name as user_name,
                    ea.role_type,
                    ea.status
                FROM event_approvals ea
                JOIN users u ON ea.user_id = u.id
                WHERE ea.event_id = ?
            `, [event.id]);
            event.approvals = approvals;
        }
        
        res.render('events/moderation', {
            title: 'Модерация мероприятий',
            events,
            userRole: req.session.user.type
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки модерации', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ============================================================
// === НОВЫЕ МАРШРУТЫ ДЛЯ МНОГОСТУПЕНЧАТОГО УТВЕРЖДЕНИЯ ===
// ============================================================

// ----- 1. Администратор утверждает мероприятие -----
app.post('/events/admin-approve/:id', isAdmin, async (req, res) => {
    const eventId = req.params.id;
    const adminId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }
        if (event[0].status !== 'WAITING_ADMIN') {
            return res.status(400).send('Мероприятие не находится на этапе ожидания администратора');
        }

        const connection = await pool.getConnection();
        let notificationsToSend = [];

        try {
            await connection.query("SET SESSION innodb_lock_wait_timeout = 100");
            await connection.beginTransaction();

            const [approval] = await connection.query(
                `SELECT id, status FROM event_approvals 
                 WHERE event_id = ? AND user_id = ? AND role_type = 'admin'
                 FOR UPDATE`,
                [eventId, adminId]
            );

            if (approval.length === 0) {
                await connection.rollback();
                return res.status(403).send('У вас нет прав на утверждение этого мероприятия');
            }
            if (approval[0].status !== 'pending') {
                await connection.rollback();
                return res.status(400).send('Вы уже утвердили или отклонили это мероприятие');
            }

            await connection.query(
                `UPDATE event_approvals 
                 SET status = 'approved', updated_at = NOW()
                 WHERE id = ?`,
                [approval[0].id]
            );

            const [adminsApprovals] = await connection.query(
                `SELECT status FROM event_approvals 
                 WHERE event_id = ? AND role_type = 'admin'`,
                [eventId]
            );

            const allAdminsApproved = adminsApprovals.every(a => a.status === 'approved');

            if (allAdminsApproved) {
                await connection.query(
                    `UPDATE events SET status = 'WAITING_DIRECTOR' WHERE id = ?`,
                    [eventId]
                );

                // ---- Собираем уведомления в массив (НЕ ОТПРАВЛЯЕМ) ----
                notificationsToSend.push({
                    userId: event[0].created_by,
                    eventId: eventId,
                    type: 'all_admins_approved',
                    message: `Все администраторы утвердили ваше мероприятие "${event[0].title}". Оно ожидает подтверждения директора.`
                });

                const [directors] = await connection.query(
                    `SELECT user_id FROM event_approvals 
                     WHERE event_id = ? AND role_type = 'director'`,
                    [eventId]
                );
                for (const d of directors) {
                    notificationsToSend.push({
                        userId: d.user_id,
                        eventId: eventId,
                        type: 'new_event',
                        message: `Мероприятие "${event[0].title}" ожидает вашего подтверждения (все админы утвердили)`
                    });
                }

                const [admins] = await connection.query(
                    `SELECT user_id FROM event_approvals 
                     WHERE event_id = ? AND role_type = 'admin' AND user_id != ?`,
                    [eventId, adminId]
                );
                for (const a of admins) {
                    notificationsToSend.push({
                        userId: a.user_id,
                        eventId: eventId,
                        type: 'all_admins_approved',
                        message: `Все администраторы утвердили мероприятие "${event[0].title}". Ожидает директора.`
                    });
                }

                mlog(`Все администраторы утвердили мероприятие ${eventId}, статус обновлён на WAITING_DIRECTOR`);
            } else {
                const approvedCount = adminsApprovals.filter(a => a.status === 'approved').length;
                const totalAdmins = adminsApprovals.length;

                notificationsToSend.push({
                    userId: event[0].created_by,
                    eventId: eventId,
                    type: 'admin_approved',
                    message: `Администратор утвердил ваше мероприятие "${event[0].title}". Утверждено ${approvedCount} из ${totalAdmins} администраторов.`
                });

                const [pendingAdmins] = await connection.query(
                    `SELECT user_id FROM event_approvals 
                     WHERE event_id = ? AND role_type = 'admin' AND status = 'pending' AND user_id != ?`,
                    [eventId, adminId]
                );
                for (const a of pendingAdmins) {
                    notificationsToSend.push({
                        userId: a.user_id,
                        eventId: eventId,
                        type: 'admin_approved',
                        message: `Администратор ${req.session.user.name} утвердил мероприятие "${event[0].title}". Ожидается ваше утверждение.`
                    });
                }

                mlog(`Администратор ${adminId} утвердил мероприятие ${eventId} (не все админы утвердили)`);
            }

            await connection.commit();

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        // ---- Отправляем все уведомления ПОСЛЕ освобождения блокировки ----
        for (const n of notificationsToSend) {
            await createNotification(n.userId, n.eventId, n.type, n.message);
        }

        res.redirect('/events/moderation');

    } catch (error) {
        mlog('[ERROR]', 'Ошибка при утверждении администратором', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- 2. Директор утверждает мероприятие (финальное утверждение) -----
app.post('/events/director-approve/:id', isDirector, async (req, res) => {
    const eventId = req.params.id;
    const directorId = req.session.user.id;

    try {
        // Проверяем, что мероприятие существует и находится в статусе WAITING_DIRECTOR
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }

        if (event[0].status !== 'WAITING_DIRECTOR') {
            return res.status(400).send('Мероприятие не находится на этапе ожидания директора');
        }

        // Проверяем, есть ли у этого директора запись в event_approvals со статусом pending
        const [approval] = await pool.query(
            `SELECT id, status FROM event_approvals 
             WHERE event_id = ? AND user_id = ? AND role_type = 'director'`,
            [eventId, directorId]
        );

        if (approval.length === 0) {
            return res.status(403).send('У вас нет прав на утверждение этого мероприятия');
        }

        if (approval[0].status !== 'pending') {
            return res.status(400).send('Вы уже утвердили или отклонили это мероприятие');
        }

        // Начинаем транзакцию
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Обновляем запись директора на approved
            await connection.query(
                `UPDATE event_approvals 
                 SET status = 'approved', updated_at = NOW()
                 WHERE id = ?`,
                [approval[0].id]
            );

            // Дополнительная проверка: убеждаемся, что все администраторы утвердили
            const [adminApprovals] = await connection.query(
                `SELECT status FROM event_approvals 
                 WHERE event_id = ? AND role_type = 'admin'`,
                [eventId]
            );

            const allAdminsApproved = adminApprovals.every(a => a.status === 'approved');
            if (!allAdminsApproved) {
                // Теоретически этого не должно произойти, но если случилось — откатываем
                await connection.rollback();
                return res.status(400).send('Не все администраторы утвердили мероприятие');
            }

            // Переводим событие в APPROVED и заполняем поля
            await connection.query(
                `UPDATE events 
                 SET status = 'APPROVED', approved_by_director = ?, approved_by = ?
                 WHERE id = ?`,
                [directorId, directorId, eventId]
            );

            await connection.commit();

            // Уведомление создателю
            await createNotification(
                event[0].created_by,
                eventId,
                'director_approved',
                `Ваше мероприятие "${event[0].title}" окончательно утверждено директором!`
            );

            // Уведомление всем администраторам (опционально)
            const [admins] = await connection.query(
                `SELECT user_id FROM event_approvals 
                 WHERE event_id = ? AND role_type = 'admin'`,
                [eventId]
            );
            for (const admin of admins) {
                await createNotification(
                    admin.user_id,
                    eventId,
                    'director_approved',
                    `Мероприятие "${event[0].title}" утверждено директором и опубликовано.`
                );
            }

            mlog(`Директор ${directorId} утвердил мероприятие ${eventId}, статус обновлён на APPROVED`);

            res.redirect('/events/moderation');

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        mlog('[ERROR]', 'Ошибка при утверждении директором', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Отклонение мероприятия (администратором или директором) -----
app.post('/events/reject/:id', isAdminOrDirector, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;
    const userType = req.session.user.type;
    const { rejection_reason } = req.body;

    try {
        // Проверяем текущий статус события
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }

        // Определяем, на каком этапе находится событие
        const currentStatus = event[0].status;
        let expectedRole = null;
        if (currentStatus === 'WAITING_ADMIN') {
            expectedRole = 'admin';
        } else if (currentStatus === 'WAITING_DIRECTOR') {
            expectedRole = 'director';
        } else {
            return res.status(400).send('Мероприятие нельзя отклонить на этом этапе');
        }

        // Проверяем, что текущий пользователь имеет запись в event_approvals с соответствующей ролью и статусом pending
        const [approval] = await pool.query(
            `SELECT id, status FROM event_approvals 
             WHERE event_id = ? AND user_id = ? AND role_type = ?`,
            [eventId, userId, expectedRole]
        );

        if (approval.length === 0) {
            return res.status(403).send('У вас нет прав на отклонение этого мероприятия');
        }

        if (approval[0].status !== 'pending') {
            return res.status(400).send('Вы уже проголосовали по этому мероприятию');
        }

        // Начинаем транзакцию
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Обновляем запись на rejected
            await connection.query(
                `UPDATE event_approvals 
                 SET status = 'rejected', comment = ?, updated_at = NOW()
                 WHERE id = ?`,
                [rejection_reason || 'Без указания причины', approval[0].id]
            );

            // Переводим событие в REJECTED
            await connection.query(
                `UPDATE events 
                 SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), rejection_reason = ?
                 WHERE id = ?`,
                [userId, rejection_reason || 'Без указания причины', eventId]
            );

            await connection.commit();

            // Уведомление создателю
            await createNotification(
                event[0].created_by,
                eventId,
                'rejected',
                `Ваше мероприятие "${event[0].title}" отклонено ${expectedRole === 'admin' ? 'администратором' : 'директором'}. Причина: ${rejection_reason || 'не указана'}`
            );

            // Уведомление другим утверждающим (администраторам или директорам), которые ещё не проголосовали
            const [pendingApprovals] = await connection.query(
                `SELECT user_id FROM event_approvals 
                 WHERE event_id = ? AND role_type = ? AND status = 'pending' AND user_id != ?`,
                [eventId, expectedRole, userId]
            );
            for (const p of pendingApprovals) {
                await createNotification(
                    p.user_id,
                    eventId,
                    'rejected',
                    `Мероприятие "${event[0].title}" было отклонено пользователем ${req.session.user.name}.`
                );
            }

            mlog(`Пользователь ${userId} (${expectedRole}) отклонил мероприятие ${eventId}`);

            res.redirect('/events/moderation');

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        mlog('[ERROR]', 'Ошибка при отклонении', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/events/resend/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ? AND created_by = ?',
            [eventId, userId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено или у вас нет прав');
        }

        if (event[0].status !== 'REJECTED') {
            return res.status(400).send('Можно отправить повторно только отклонённое мероприятие');
        }

        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Обновляем статус события
            await connection.query(
                `UPDATE events 
                 SET status = 'WAITING_ADMIN', rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
                 WHERE id = ? AND status = 'REJECTED'`,
                [eventId]
            );

            // Сбрасываем все утверждения на pending
            await connection.query(
                `UPDATE event_approvals 
                 SET status = 'pending', comment = NULL, updated_at = NOW()
                 WHERE event_id = ?`,
                [eventId]
            );

            await connection.commit();

            // ---- Уведомление ТОЛЬКО администраторам (не директору) ----
            const [admins] = await pool.query('SELECT id FROM users WHERE type = 5');
            for (const admin of admins) {
                await createNotification(
                    admin.id,
                    eventId,
                    'new_event',
                    `Мероприятие "${event[0].title}" отправлено повторно на утверждение администраторами (исправлено)`
                );
            }
            // ----------------------------------------------------------------

            mlog(`Пользователь ${userId} повторно отправил мероприятие ${eventId} на модерацию`);
            res.redirect('/');

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        mlog('[ERROR]', 'Ошибка при повторной отправке', error);
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
                        e.review_text,
                        e.review_created_at,
                        reviewer.name as reviewer_name,
                        reviewer.id as reviewer_id,
                        CASE 
                            WHEN e.status = 'COMPLETED' THEN 'Участвовал'
                            WHEN e.status = 'CANCELED' THEN 'Отменено'
                            WHEN e.status = 'REJECTED' THEN 'Отклонено'
                        END as participation_status
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN users reviewer ON e.review_author_id = reviewer.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
                WHERE (e.created_by = ? OR ep.user_id = ?)
                  AND e.status IN ('COMPLETED', 'CANCELED', 'REJECTED')
                ORDER BY e.end_datetime DESC
            `, [userId, userId, userId]);

        } else if (userType === 6) { // Родитель – только свои созданные мероприятия
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled,
                       e.review_text,
                       e.review_created_at,
                       reviewer.name as reviewer_name,
                       reviewer.id as reviewer_id
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN users reviewer ON e.review_author_id = reviewer.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                  AND e.status IN ('COMPLETED', 'CANCELED', 'REJECTED')
                ORDER BY e.end_datetime DESC
            `, [userId]);

        } else if ([2, 3, 4, 5, 7].includes(userType)) { // Педагоги, Админ, Директор
            [events] = await pool.query(`
                SELECT e.*, u.name as creator_name, et.name as type_name,
                       e.is_registration_enabled,
                       (SELECT COUNT(*) FROM event_participants WHERE event_id = e.id) as participants_count,
                       e.review_text,
                       e.review_created_at,
                       reviewer.name as reviewer_name,
                       reviewer.id as reviewer_id,
                       CASE 
                           WHEN e.status = 'COMPLETED' THEN 'Завершено'
                           WHEN e.status = 'CANCELED' THEN 'Отменено'
                           WHEN e.status = 'REJECTED' THEN 'Отклонено'
                       END as participation_status
                FROM events e
                LEFT JOIN users u ON e.created_by = u.id
                LEFT JOIN users reviewer ON e.review_author_id = reviewer.id
                LEFT JOIN event_types et ON e.event_type_id = et.id
                WHERE e.created_by = ?
                  AND e.status IN ('COMPLETED', 'CANCELED', 'REJECTED')
                ORDER BY e.end_datetime DESC
            `, [userId]);
        }

        res.render('events/archive', {
            title: 'Архив мероприятий',
            events: events,
            userType: userType,
            user: req.session.user
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки архива', error);
        res.status(500).send('Ошибка сервера');
    }
});
// ----- Аналитика -----
app.get('/analytics', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const userType = user.type;

    // Проверка прав: администратор, директор или учитель (2,3,4)
    if (![2, 3, 4, 5, 7].includes(userType)) {
        return res.status(403).send('Доступ запрещён');
    }

    // Определяем, какие фильтры доступны для пользователя
    let showAllData = false;
    let userKaf = null;
    let userId = user.id;

    if (userType === 5 || userType === 7) {
        showAllData = true; // администратор и директор видят всё
    } else if ([2, 3, 4].includes(userType)) {
        // Учитель видит только свои данные и данные своей кафедры
        userKaf = user.kaf; // кафедра учителя (может быть null)
        showAllData = false;
    }

    try {
        // Получаем список типов мероприятий для фильтра
        const [eventTypes] = await pool.query('SELECT id, name FROM event_types ORDER BY name');

        // Получаем список учителей для фильтра (только если showAllData)
        let teachers = [];
        if (showAllData) {
            const [teacherRows] = await pool.query(
                'SELECT id, name FROM users WHERE type IN (2,3,4) ORDER BY name'
            );
            teachers = teacherRows;
        }

        res.render('analytics', {
            title: 'Аналитика',
            user: user,
            showAllData: showAllData,
            userKaf: userKaf,
            userId: userId,
            eventTypes: eventTypes,
            teachers: teachers
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки данных для аналитики', error);
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
                   e.is_registration_enabled,
                   e.responsible_ids
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE 1=1
        `;
        const params = [];

        let visibilityCondition = `
            (
                e.status = 'APPROVED'
                OR (e.status IN ('WAITING_ADMIN', 'WAITING_DIRECTOR') AND e.created_by = ?)
                OR (e.status IN ('WAITING_ADMIN', 'WAITING_DIRECTOR') AND ? IN (5, 7))
            )
        `;
        params.push(user.id, user.type);

        if (user.type !== 5 && user.type !== 7) {
            visibilityCondition += `
                AND (
                    e.created_by = ?
                    OR e.status != 'APPROVED'
                )
            `;
            params.push(user.id);

            if (user.type === 1) { // Ученик
                visibilityCondition += `
                    OR (
                        e.status = 'APPROVED'
                        AND (
                            e.target_audience_type = 'all'
                            OR (e.target_audience_type = 'class' AND e.target_audience_id = ?)
                            OR (e.target_audience_type = 'multiple_classes' AND FIND_IN_SET(?, e.target_audience_id))
                            OR (e.target_audience_type = 'specific_users' AND FIND_IN_SET(?, e.target_audience_id))
                            OR (e.target_audience_type = 'parallel' AND e.target_audience_id = (
                                SELECT CAST(SUBSTRING_INDEX(name, '-', 1) AS UNSIGNED) 
                                FROM kaf_name 
                                WHERE id = ?
                            ))
                        )
                    )
                `;
                params.push(user.kaf, user.kaf, user.id, user.kaf);
            } else if (user.type === 6) { // Родитель
                const [children] = await pool.query(
                    `SELECT student_id FROM parent_student WHERE parent_id = ?`,
                    [user.id]
                );
                if (children.length > 0) {
                    const childIds = children.map(c => c.student_id);
                    const [childUsers] = await pool.query(
                        `SELECT id, kaf FROM users WHERE id IN (?)`,
                        [childIds]
                    );
                    let childConditions = [];
                    let childParams = [];

                    childConditions.push(`e.target_audience_type = 'all'`);

                    const childIdsPlaceholders = childIds.map(() => '?').join(',');
                    childConditions.push(`e.created_by IN (${childIdsPlaceholders})`);
                    childParams.push(...childIds);

                    childConditions.push(`EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id IN (${childIdsPlaceholders}))`);
                    childParams.push(...childIds);

                    const kafList = childUsers.map(u => u.kaf).filter(k => k !== null);
                    if (kafList.length) {
                        const kafPlaceholders = kafList.map(() => '?').join(',');
                        childConditions.push(`(e.target_audience_type = 'class' AND e.target_audience_id IN (${kafPlaceholders}))`);
                        childParams.push(...kafList);

                        const [parallels] = await pool.query(`
                            SELECT DISTINCT CAST(SUBSTRING_INDEX(name, '-', 1) AS UNSIGNED) as parallel 
                            FROM kaf_name 
                            WHERE id IN (${kafPlaceholders})
                        `, kafList);
                        const parallelList = parallels.map(p => p.parallel).filter(p => p !== null);
                        if (parallelList.length) {
                            const parallelPlaceholders = parallelList.map(() => '?').join(',');
                            childConditions.push(`(e.target_audience_type = 'parallel' AND e.target_audience_id IN (${parallelPlaceholders}))`);
                            childParams.push(...parallelList);
                        }

                        const multipleConditions = kafList.map(() => `FIND_IN_SET(?, e.target_audience_id)`).join(' OR ');
                        childConditions.push(`(e.target_audience_type = 'multiple_classes' AND (${multipleConditions}))`);
                        childParams.push(...kafList);
                    }

                    const specificConditions = childIds.map(() => `FIND_IN_SET(?, e.target_audience_id)`).join(' OR ');
                    childConditions.push(`(e.target_audience_type = 'specific_users' AND (${specificConditions}))`);
                    childParams.push(...childIds);

                    if (childConditions.length) {
                        const combined = childConditions.join(' OR ');
                        visibilityCondition += `
                            OR (e.status = 'APPROVED' AND (${combined}))
                        `;
                        params.push(...childParams);
                    }
                }
            } else if ([2, 3, 4].includes(user.type)) { // Учитель, Наставник, Тьютор
                visibilityCondition += `
                    OR (
                        e.status = 'APPROVED'
                        AND (
                            e.target_audience_type = 'all'
                            OR (e.target_audience_type = 'department' AND e.target_audience_id = ?)
                            OR (e.target_audience_type = 'multiple_classes' AND FIND_IN_SET(?, e.target_audience_id))
                            OR (e.target_audience_type = 'specific_users' AND FIND_IN_SET(?, e.target_audience_id))
                        )
                    )
                `;
                params.push(user.kaf, user.kaf, user.id);
            }
        }

        sql += ` AND (${visibilityCondition})`;

        if ([1, 6].includes(user.type)) {
            sql += ' AND e.is_admin_event = 0';
        }

        // ===== ОБНОВЛЁННЫЙ БЛОК ФИЛЬТРАЦИИ ПО СТАТУСУ =====
        if (status === 'WAITING') {
            // Если фильтр "На модерации" — показываем оба ожидающих статуса
            sql += ' AND e.status IN ("WAITING_ADMIN", "WAITING_DIRECTOR")';
        } else if (status !== 'all') {
            // Иначе фильтруем по конкретному статусу (APPROVED, REJECTED, etc.)
            sql += ' AND e.status = ?';
            params.push(status);
        }
        // =====================================================

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
        if (event.length === 0 || event[0].status !== 'APPROVED') {
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
        if (event.length === 0 || event[0].status !== 'APPROVED') {
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

// ----- Получение списка участников -----
app.get('/api/events/:id/participants', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [participants] = await pool.query(`
            SELECT u.id, u.name, u.kaf, d.name as class_name
            FROM event_participants ep
            LEFT JOIN users u ON ep.user_id = u.id
            LEFT JOIN kaf_name d ON u.kaf = d.id AND d.type = 1
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
        if (event[0].status !== 'APPROVED') {
            return res.status(400).json({ error: 'Можно завершить только утверждённое мероприятие' });
        }
        if (event[0].created_by !== userId && ![5, 7].includes(req.session.user.type)) {
            return res.status(403).json({ error: 'Нет прав' });
        }

        await pool.query(
            'UPDATE events SET status = "COMPLETED" WHERE id = ?',
            [eventId]
        );
        mlog(`Мероприятие ${eventId} завершено`);
        res.json({ success: true, message: 'Мероприятие завершено' });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка завершения', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Удаление мероприятия (только для WAITING_ADMIN, только создатель) -----
app.post('/events/delete/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;

    try {
        const [event] = await pool.query(
            'SELECT id, status, created_by FROM events WHERE id = ? AND created_by = ? AND status = "WAITING_ADMIN"',
            [eventId, userId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено или не может быть удалено');
        }

        await pool.query('DELETE FROM events WHERE id = ?', [eventId]);
        mlog(`Мероприятие ${eventId} удалено пользователем ${userId}`);
        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка удаления мероприятия', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Сохранение отзыва -----
app.post('/events/review/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;
    const { review_text } = req.body;

    try {
        // Проверяем, что мероприятие существует и завершено
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }
        if (event[0].status !== 'COMPLETED') {
            return res.status(400).send('Отзыв можно оставить только для завершённого мероприятия');
        }

        // Проверяем права: организатор, администратор или директор
        const isCreator = event[0].created_by === userId;
        const isAdminOrDirector = [5, 7].includes(req.session.user.type);
        if (!isCreator && !isAdminOrDirector) {
            return res.status(403).send('Нет прав на добавление отзыва');
        }

        // Сохраняем отзыв
        await pool.query(
            `UPDATE events 
             SET review_text = ?, review_author_id = ?, review_created_at = NOW()
             WHERE id = ?`,
            [review_text || null, userId, eventId]
        );

        // Уведомление организатору (если отзыв оставил не он)
        if (!isCreator) {
            await createNotification(
                event[0].created_by,
                eventId,
                'review_added',
                `На ваше мероприятие "${event[0].title}" добавлен отзыв/резолюция.`
            );
        }

        res.redirect('/events/archive');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка сохранения отзыва', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Страница всех отзывов -----
app.get('/reviews', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const userType = user.type;
    const userId = user.id;

    // Разрешаем всем, кроме учеников и родителей? Нет, разрешаем всем, кто может быть организатором.
    // Но ученики и родители видят только свои мероприятия.
    try {
        let query = `
            SELECT 
                e.id as event_id,
                e.title,
                e.review_text,
                e.review_created_at,
                u.name as reviewer_name,
                creator.name as creator_name
            FROM events e
            LEFT JOIN users u ON e.review_author_id = u.id
            LEFT JOIN users creator ON e.created_by = creator.id
            WHERE e.review_text IS NOT NULL
        `;
        const params = [];

        // Если пользователь НЕ администратор и НЕ директор - показываем только свои мероприятия
        if (![5, 7].includes(userType)) {
            query += ' AND e.created_by = ?';
            params.push(userId);
        }

        query += ' ORDER BY e.review_created_at DESC';

        const [reviews] = await pool.query(query, params);

        res.render('reviews', {
            title: 'Отзывы о мероприятиях',
            reviews,
            isAdminOrDirector: [5, 7].includes(userType)
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки отзывов', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Отмена мероприятия (только для администратора или директора) -----
app.post('/events/cancel/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.session.user.id;
    const { cancel_reason } = req.body;

    // Проверяем, что пользователь администратор или директор
    const isAdminOrDirector = [5, 7].includes(req.session.user.type);
    if (!isAdminOrDirector) {
        return res.status(403).send('Нет прав на отмену мероприятия');
    }

    try {
        const [event] = await pool.query(
            'SELECT id, title, created_by, status FROM events WHERE id = ?',
            [eventId]
        );
        if (event.length === 0) {
            return res.status(404).send('Мероприятие не найдено');
        }

        if (event[0].status === 'CANCELED') {
            return res.status(400).send('Мероприятие уже отменено');
        }

        // Обновляем статус
        await pool.query(
            `UPDATE events 
             SET status = 'CANCELED', cancel_reason = ?, canceled_at = NOW()
             WHERE id = ? AND status != 'CANCELED'`,
            [cancel_reason || 'Причина не указана', eventId]
        );

        // Уведомление создателю
        await createNotification(
            event[0].created_by,
            eventId,
            'canceled',
            `Ваше мероприятие "${event[0].title}" отменено администрацией. Причина: ${cancel_reason || 'не указана'}`
        );

        // Уведомление участникам
        const [participants] = await pool.query(
            'SELECT DISTINCT user_id FROM event_participants WHERE event_id = ?',
            [eventId]
        );
        for (const p of participants) {
            if (p.user_id !== event[0].created_by) {
                await createNotification(
                    p.user_id,
                    eventId,
                    'canceled',
                    `Мероприятие "${event[0].title}" отменено. Причина: ${cancel_reason || 'не указана'}`
                );
            }
        }

        // Уведомление другим администраторам/директорам (если отменил не сам админ/директор)
        const [adminsAndDirectors] = await pool.query(
            'SELECT id FROM users WHERE type IN (5, 7)'
        );
        for (const user of adminsAndDirectors) {
            if (user.id !== userId) {
                await createNotification(
                    user.id,
                    eventId,
                    'canceled',
                    `Мероприятие "${event[0].title}" отменено пользователем ${req.session.user.name}. Причина: ${cancel_reason || 'не указана'}`
                );
            }
        }

        mlog(`Пользователь ${userId} отменил мероприятие ${eventId}`);
        res.redirect('/');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка при отмене', error);
        res.status(500).send('Ошибка сервера');
    }
});

// ----- Все уведомления -----
app.get('/notifications/all', isAuthenticated, async (req, res) => {
    try {
        const [allNotifications] = await pool.query(
            `SELECT * FROM notifications 
             WHERE user_id = ? 
             ORDER BY created_at DESC`,
            [req.session.user.id]
        );
        res.render('notifications/all', {
            title: 'Все уведомления',
            allNotifications
        });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка загрузки уведомлений', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/notifications/mark-all-read', isAuthenticated, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
            [req.session.user.id]
        );
        res.redirect('/notifications/all');
    } catch (error) {
        mlog('[ERROR]', 'Ошибка пометки уведомлений', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/notifications/mark-read/:id', isAuthenticated, async (req, res) => {
    const notificationId = req.params.id;
    try {
        await pool.query(
            'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
            [notificationId, req.session.user.id]
        );
        res.json({ success: true });
    } catch (error) {
        mlog('[ERROR]', 'Ошибка пометки уведомления', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Получение одного мероприятия с именами ответственных -----
app.get('/api/events/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [events] = await pool.query(`
            SELECT e.*, u.name as creator_name, et.name as type_name,
                   e.is_registration_enabled,
                   e.responsible_ids
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            LEFT JOIN event_types et ON e.event_type_id = et.id
            WHERE e.id = ?
        `, [eventId]);
        
        if (events.length === 0) {
            return res.status(404).json({ error: 'Мероприятие не найдено' });
        }
        
        const event = events[0];
        const result = { ...event };
        
        if (event.responsible_ids) {
            const ids = event.responsible_ids.split(',').map(id => parseInt(id)).filter(id => id);
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                const [users] = await pool.query(
                    `SELECT id, name FROM users WHERE id IN (${placeholders})`,
                    ids
                );
                result.responsible_names = users.map(u => u.name);
            } else {
                result.responsible_names = [];
            }
        } else {
            result.responsible_names = [];
        }
        
        res.json(result);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения мероприятия', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ----- Получение статусов утверждений для мероприятия -----
app.get('/api/events/:id/approvals', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [approvals] = await pool.query(`
            SELECT 
                ea.user_id,
                u.name as user_name,
                ea.role_type,
                ea.status,
                ea.comment,
                ea.updated_at
            FROM event_approvals ea
            JOIN users u ON ea.user_id = u.id
            WHERE ea.event_id = ?
            ORDER BY ea.role_type DESC, ea.order_index ASC
        `, [eventId]);
        res.json(approvals);
    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения статусов утверждений', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});


// ----- API: Аналитика -----
app.get('/api/analytics', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const userType = user.type;
    const userId = user.id;
    const userKaf = user.kaf;

    // Проверка прав
    if (![2, 3, 4, 5, 7].includes(userType)) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }

    // Параметры фильтров
    const period = req.query.period || 'month';
    const type = req.query.type || 'all';
    const teacherId = req.query.teacher || 'all';

    // Определяем диапазон дат
    const now = new Date();
    let startDate = null;
    let endDate = new Date();

    switch (period) {
        case 'week':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 7);
            break;
        case 'month':
            startDate = new Date(now);
            startDate.setMonth(now.getMonth() - 1);
            break;
        case 'quarter':
            startDate = new Date(now);
            startDate.setMonth(now.getMonth() - 3);
            break;
        case 'year':
            startDate = new Date(now);
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        case 'all':
        default:
            startDate = null;
            break;
    }

    const formatMySQL = (date) => {
        if (!date) return null;
        return date.getFullYear() + '-' +
               String(date.getMonth() + 1).padStart(2, '0') + '-' +
               String(date.getDate()).padStart(2, '0') + ' 00:00:00';
    };

    const startDateStr = startDate ? formatMySQL(startDate) : '1970-01-01 00:00:00';
    const endDateStr = formatMySQL(endDate);

    // Базовые параметры для запросов
    const queryParams = [];
    let dateCondition = '';
    if (startDate) {
        dateCondition = 'AND e.start_datetime >= ? AND e.start_datetime <= ?';
        queryParams.push(startDateStr, endDateStr);
    }

    // Фильтр по типу мероприятия
    let typeCondition = '';
    if (type !== 'all') {
        typeCondition = 'AND e.event_type_id = ?';
        queryParams.push(type);
    }

    // Фильтр по учителю (только для админов/директоров)
    let teacherCondition = '';
    if (teacherId !== 'all' && (userType === 5 || userType === 7)) {
        teacherCondition = 'AND e.created_by = ?';
        queryParams.push(parseInt(teacherId));
    }

    // Ограничение по роли: учитель видит только свои данные
    let roleFilter = '';
    if ([2, 3, 4].includes(userType)) {
        roleFilter = `
            AND (
                e.created_by = ?
                OR FIND_IN_SET(?, e.responsible_ids)
                OR (e.target_audience_type = 'department' AND e.target_audience_id = ?)
            )
        `;
        queryParams.push(userId, userId, userKaf);
    }

    try {
        // ---- 1. Общие метрики ----
        const [totalsResult] = await pool.query(`
            SELECT 
                COUNT(*) as total_events,
                SUM(CASE WHEN e.status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count,
                SUM(CASE WHEN e.status = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count,
                SUM(CASE WHEN e.status = 'CANCELED' THEN 1 ELSE 0 END) as canceled_count
            FROM events e
            WHERE e.status IN ('APPROVED', 'COMPLETED', 'REJECTED', 'CANCELED')
            ${dateCondition}
            ${typeCondition}
            ${teacherCondition}
            ${roleFilter}
        `, queryParams);

        const [participantsResult] = await pool.query(`
            SELECT COUNT(DISTINCT ep.user_id) as total_participants
            FROM event_participants ep
            JOIN events e ON ep.event_id = e.id
            WHERE e.status IN ('APPROVED', 'COMPLETED')
            ${dateCondition}
            ${typeCondition}
            ${teacherCondition}
            ${roleFilter}
        `, queryParams);

        const totals = {
            total_events: totalsResult[0]?.total_events || 0,
            approved_count: totalsResult[0]?.approved_count || 0,
            rejected_count: totalsResult[0]?.rejected_count || 0,
            canceled_count: totalsResult[0]?.canceled_count || 0,
            total_participants: participantsResult[0]?.total_participants || 0
        };

        // ---- 2. Топ педагогов ----
        const teachersQuery = `
            SELECT 
                u.id,
                u.name,
                COUNT(DISTINCT e.id) as created_events,
                COUNT(DISTINCT ep.event_id) as participations
            FROM users u
            LEFT JOIN events e ON e.created_by = u.id AND e.status IN ('APPROVED', 'COMPLETED')
            LEFT JOIN event_participants ep ON ep.user_id = u.id
            WHERE u.type IN (2,3,4)
              AND (e.id IS NOT NULL OR ep.event_id IS NOT NULL)
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY u.id
            ORDER BY created_events DESC
            LIMIT 10
        `;
        const teachers = await pool.query(teachersQuery, queryParams);

        // ---- 3. Активность классов ----
        const classesQuery = `
            SELECT 
                k.id,
                k.name,
                COUNT(DISTINCT e.id) as events_count,
                COUNT(DISTINCT ep.user_id) as participants_count,
                COUNT(DISTINCT u.id) as active_students
            FROM kaf_name k
            LEFT JOIN users u ON u.kaf = k.id AND u.type = 1
            LEFT JOIN events e ON (
                (e.target_audience_type = 'class' AND e.target_audience_id = k.id)
                OR (e.target_audience_type = 'multiple_classes' AND FIND_IN_SET(k.id, e.target_audience_id))
            ) AND e.status IN ('APPROVED', 'COMPLETED')
            LEFT JOIN event_participants ep ON ep.user_id = u.id
            WHERE k.type = 1
              AND (e.id IS NOT NULL OR u.id IS NOT NULL)
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY k.id
            ORDER BY events_count DESC
            LIMIT 10
        `;
        const classes = await pool.query(classesQuery, queryParams);

        // ---- 4. Распределение по типам ----
        const typesQuery = `
            SELECT 
                et.name as type_name,
                COUNT(e.id) as count
            FROM event_types et
            LEFT JOIN events e ON e.event_type_id = et.id
            WHERE e.status IN ('APPROVED', 'COMPLETED')
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY et.id
            ORDER BY count DESC
        `;
        const eventTypes = await pool.query(typesQuery, queryParams);

        // ---- 5. Динамика по дням ----
        const timelineQuery = `
            SELECT 
                DATE(e.start_datetime) as date,
                COUNT(e.id) as count
            FROM events e
            WHERE e.status IN ('APPROVED', 'COMPLETED')
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY DATE(e.start_datetime)
            ORDER BY date
        `;
        const timeline = await pool.query(timelineQuery, queryParams);

        // ---- 6. Топ учеников (по участиям) ----
        const studentsQuery = `
            SELECT 
                u.id,
                u.name,
                k.name as class_name,
                COUNT(DISTINCT ep.event_id) as participations,
                COUNT(DISTINCT e.id) as created_events
            FROM users u
            LEFT JOIN kaf_name k ON u.kaf = k.id
            LEFT JOIN events e ON e.created_by = u.id AND e.status IN ('APPROVED', 'COMPLETED')
            LEFT JOIN event_participants ep ON ep.user_id = u.id
            WHERE u.type = 1
              AND (e.id IS NOT NULL OR ep.event_id IS NOT NULL)
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY u.id
            ORDER BY participations DESC
            LIMIT 10
        `;
        const students = await pool.query(studentsQuery, queryParams);

        // ---- 7. Топ ответственных ----
        const responsibleQuery = `
            SELECT 
                u.id,
                u.name,
                COUNT(DISTINCT e.id) as responsible_count
            FROM users u
            JOIN events e ON (e.responsible_ids IS NOT NULL AND FIND_IN_SET(u.id, e.responsible_ids))
            WHERE u.type IN (2,3,4)
              AND e.status IN ('APPROVED', 'COMPLETED')
              ${dateCondition}
              ${typeCondition}
              ${roleFilter}
            GROUP BY u.id
            ORDER BY responsible_count DESC
            LIMIT 10
        `;
        // Для ответственных не используем teacherCondition, т.к. они не обязательно создатели
        const responsible = await pool.query(responsibleQuery, queryParams);

        // ---- 8. Топ организаторов (создателей мероприятий) ----
        const organizersQuery = `
            SELECT 
                u.id,
                u.name,
                COUNT(e.id) as created_events
            FROM users u
            JOIN events e ON e.created_by = u.id
            WHERE u.type IN (2,3,4,5,7)
              AND e.status IN ('APPROVED', 'COMPLETED')
              ${dateCondition}
              ${typeCondition}
              ${teacherCondition}
              ${roleFilter}
            GROUP BY u.id
            ORDER BY created_events DESC
            LIMIT 10
        `;
        const organizers = await pool.query(organizersQuery, queryParams);

        // Возвращаем все данные
        res.json({
            totals,
            teachers: teachers[0],
            classes: classes[0],
            event_types: eventTypes[0],
            timeline: timeline[0],
            students: students[0],
            responsible: responsible[0],
            organizers: organizers[0]
        });

    } catch (error) {
        mlog('[ERROR]', 'Ошибка получения данных аналитики', error);
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