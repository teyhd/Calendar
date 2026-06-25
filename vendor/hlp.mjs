import { format } from 'date-fns';

// Хелперы для Handlebars
export function registerHelpers(handlebarsInstance) {
    const hbs = handlebarsInstance?.handlebars || handlebarsInstance;
    
    if (!hbs || typeof hbs.registerHelper !== 'function') {
        console.warn('⚠️ Handlebars не передан или недоступен, хелперы не зарегистрированы');
        return;
    }

    hbs.registerHelper('eq', (a, b) => a === b);
    
    hbs.registerHelper('formatDate', (date) => {
        if (!date) return '';
        try {
            return format(new Date(date), 'dd.MM.yyyy HH:mm');
        } catch {
            return date;
        }
    });
    
    // ===== НОВЫЙ ХЕЛПЕР ДЛЯ INPUT =====
    hbs.registerHelper('formatDateForInput', function(date) {
        if (!date) return '';
        try {
            const d = new Date(date);
            return d.toISOString().slice(0, 16);
        } catch {
            return '';
        }
    });
    
    hbs.registerHelper('statusColor', (status) => {
        const colors = {
            pending: '#ffc107',
            approved: '#28a745',
            rejected: '#dc3545',
            canceled: '#6c757d',
            completed: '#17a2b8'
        };
        return colors[status] || '#6c757d';
    });
    
    hbs.registerHelper('statusText', (status) => {
        const texts = {
            pending: 'На модерации',
            approved: 'Опубликовано',
            rejected: 'Отклонено',
            canceled: 'Отменено',
            completed: 'Завершено'
        };
        return texts[status] || status;
    });
    
    hbs.registerHelper('roleText', (role) => {
        const texts = {
            admin: 'Администратор',
            teacher: 'Учитель',
            student: 'Ученик',
            parent: 'Родитель'
        };
        return texts[role] || role;
    });
    
    hbs.registerHelper('audienceTypeText', (type) => {
        const texts = {
            class: 'Класс',
            parallel: 'Параллель',
            department: 'Кафедра',
            specific_users: 'Конкретные пользователи',
            all: 'Все'
        };
        return texts[type] || type;
    });

    hbs.registerHelper('ifEquals', (arg1, arg2, options) => {
        return (arg1 === arg2) ? options.fn(this) : options.inverse(this);
    });

    hbs.registerHelper('json', function(context) {
        try {
            return JSON.stringify(context);
        } catch (e) {
            return '{}';
        }
    });
}

// Утилиты (экспортируются для использования в JavaScript, не в шаблонах)
export function formatDateForInput(date) {
    if (!date) return '';
    try {
        const d = new Date(date);
        return d.toISOString().slice(0, 16);
    } catch {
        return '';
    }
}

export function isPast(date) {
    try {
        return new Date(date) < new Date();
    } catch {
        return false;
    }
}