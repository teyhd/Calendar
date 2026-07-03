import { format } from 'date-fns';

// Хелперы для Handlebars
export function registerHelpers(handlebarsInstance) {
    const hbs = handlebarsInstance?.handlebars || handlebarsInstance;
    
    if (!hbs || typeof hbs.registerHelper !== 'function') {
        console.warn('⚠️ Handlebars не передан или недоступен, хелперы не зарегистрированы');
        return;
    }

    hbs.registerHelper('eq', (a, b) => a === b);
    
    hbs.registerHelper('or', function(a, b) {
        return a || b;
    });

    // Хелпер "не равно"
    hbs.registerHelper('ne', function(a, b) {
        return a !== b;
    });
    
    hbs.registerHelper('formatDate', (date) => {
        if (!date) return '';
        try {
            return format(new Date(date), 'dd.MM.yyyy HH:mm');
        } catch {
            return date;
        }
    });
    
    hbs.registerHelper('formatDateForInput', function(date) {
        if (!date) return '';
        try {
            const d = new Date(date);
            // Проверяем, что дата валидна
            if (isNaN(d.getTime())) return '';
        
            // Формируем строку в локальном времени
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const hours = String(d.getHours()).padStart(2, '0');
            const minutes = String(d.getMinutes()).padStart(2, '0');
            
            return `${year}-${month}-${day}T${hours}:${minutes}`;
        } catch {
            return '';
        }
    });
    
    hbs.registerHelper('statusColor', (status) => {
        const colors = {
            'DRAFT': '#adb5bd',
            'WAITING_ADMIN': '#ffc107',
            'WAITING_DIRECTOR': '#fd7e14',
            'APPROVED': '#28a745',
            'REJECTED': '#dc3545',
            'CANCELED': '#6c757d',
            'COMPLETED': '#17a2b8'
        };
        return colors[status] || '#6c757d';
    });
    
    hbs.registerHelper('statusText', (status) => {
        const texts = {
            'DRAFT': 'Черновик',
            'WAITING_ADMIN': 'Ожидает админа',
            'WAITING_DIRECTOR': 'Ожидает директора',
            'APPROVED': 'Утверждено',
            'REJECTED': 'Отклонено',
            'CANCELED': 'Отменено',
            'COMPLETED': 'Завершено'
        };
        return texts[status] || status;
    });
    
    // Хелпер для отображения роли по числовому типу (1-Ученик, 2-Учитель, 5-Админ, 6-Родитель)
    hbs.registerHelper('roleText', (type) => {
        const roles = {
            1: 'Ученик',
            2: 'Учитель',
            3: 'Наставник',
            4: 'Тьютор',
            5: 'Админ',
            6: 'Родитель'
        };
        return roles[type] || 'Неизвестно';
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

    // Хелпер для проверки вхождения ID в массив selectedIds
    hbs.registerHelper('includesInArray', function(array, value) {
        if (!Array.isArray(array)) return false;
        return array.includes(parseInt(value));
    });

    // === ДОПОЛНИТЕЛЬНЫЕ ХЕЛПЕРЫ ДЛЯ РАБОТЫ С ЧИСЛОВЫМИ ТИПАМИ ===
    // Хелпер для проверки роли: {{#ifRole 5}} ... {{/ifRole}}
    hbs.registerHelper('ifRole', function(roleType, options) {
        const userType = this.user?.type;
        return (userType === roleType) ? options.fn(this) : options.inverse(this);
    });

    // Хелпер для получения названия роли по числовому типу: {{roleName user.type}}
    hbs.registerHelper('roleName', function(type) {
        const roles = {
            1: 'Ученик',
            2: 'Учитель',
            3: 'Наставник',
            4: 'Тьютор',
            5: 'Админ',
            6: 'Родитель'
        };
        return roles[type] || 'Неизвестно';
    });

    hbs.registerHelper('ifTeacher', function(options) {
        const userType = this.user?.type;
        if ([2, 3, 4].includes(userType)) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    // Хелпер для проверки, является ли тип педагогической ролью (2,3,4)
    hbs.registerHelper('isTeacherRole', function(type) {
        return [2, 3, 4].includes(type);
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