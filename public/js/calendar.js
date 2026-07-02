// ================================================================
// calendar.js – Школьный календарь мероприятий
// ================================================================

document.addEventListener('DOMContentLoaded', function() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;

    window.currentUserId = document.querySelector('meta[name="user-id"]')?.content || 0;
    window.currentUserRole = document.querySelector('meta[name="user-role"]')?.content || '';

    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'ru',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,listWeek'
        },
        buttonText: {
            today: 'Сегодня',
            month: 'Месяц',
            week: 'Неделя',
            list: 'Список'
        },
        buttonHints: {
            prev: 'Предыдущий',
            next: 'Следующий',
            today: 'Сегодня'
        },
        events: function(fetchInfo, successCallback, failureCallback) {
            const search = document.getElementById('searchInput')?.value || '';
            const status = document.getElementById('filterStatus')?.value || 'all';
            const type = document.getElementById('filterType')?.value || 'all';

            const params = new URLSearchParams({ search, status, type });
            const url = `/api/events?${params.toString()}`;

            fetch(url)
                .then(response => {
                    if (!response.ok) throw new Error('Ошибка загрузки');
                    return response.json();
                })
                .then(events => {
                    const formatted = events.map(event => ({
                        id: event.id,
                        title: event.title,
                        start: event.start_datetime,
                        end: event.end_datetime,
                        description: event.description || '',
                        location: event.location || '',
                        status: event.status,
                        created_by: event.created_by,
                        extendedProps: {
                            id: event.id,
                            description: event.description,
                            location: event.location,
                            status: event.status,
                            creator: event.creator_name,
                            type: event.type_name,
                            created_by: event.created_by,
                            start_datetime: event.start_datetime,
                            end_datetime: event.end_datetime,
                            level: event.level,
                            target_audience_type: event.target_audience_type,
                            target_audience_id: event.target_audience_id,
                            is_admin_event: event.is_admin_event,
                            is_registration_enabled: event.is_registration_enabled,
                            created_at: event.created_at,
                            updated_at: event.updated_at
                        }
                    }));
                    successCallback(formatted);
                    loadStats();
                })
                .catch(error => {
                    console.error('Ошибка загрузки событий:', error);
                    failureCallback(error);
                });
        },
        eventClick: function(info) {
            const event = info.event;
            const props = event.extendedProps;
            const userId = window.currentUserId;
            const userRole = parseInt(window.currentUserRole);
            const isOwner = parseInt(props.created_by) === parseInt(userId);
            const isAdmin = userRole === 5;
            const canEdit = isAdmin || (isOwner && props.status === 'pending');

            renderEventModal(event, props, canEdit, isAdmin, isOwner);
            const modal = new bootstrap.Modal(document.getElementById('eventModal'));
            modal.show();
        },
        eventDidMount: function(info) {
            const status = info.event.extendedProps.status;
            const colors = {
                approved: '#28a745',
                pending: '#ffc107',
                rejected: '#dc3545',
                completed: '#17a2b8',
                canceled: '#6c757d'
            };
            const color = colors[status] || '#6c757d';
            info.el.style.borderLeft = `4px solid ${color}`;
            info.el.style.borderRadius = '4px';
            info.el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
            
        }
    });

    calendar.render();
    window.calendar = calendar;

    // Фильтры
    const searchInput = document.getElementById('searchInput');
    const filterStatus = document.getElementById('filterStatus');
    const filterType = document.getElementById('filterType');
    const resetBtn = document.getElementById('resetFiltersBtn');

    if (searchInput) {
        searchInput.addEventListener('input', function() {
            window.calendar.refetchEvents();
        });
    }
    if (filterStatus) {
        filterStatus.addEventListener('change', function() {
            window.calendar.refetchEvents();
        });
    }
    if (filterType) {
        filterType.addEventListener('change', function() {
            window.calendar.refetchEvents();
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            if (searchInput) searchInput.value = '';
            if (filterStatus) filterStatus.value = 'all';
            if (filterType) filterType.value = 'all';
            window.calendar.refetchEvents();
        });
    }
});

// ===== ЗАГРУЗКА СТАТИСТИКИ =====
function loadStats() {
    fetch('/api/events')
        .then(res => res.json())
        .then(events => {
            const total = events.length;
            const approved = events.filter(e => e.status === 'approved').length;
            const pending = events.filter(e => e.status === 'pending').length;
            const myParticipations = events.filter(e => e.created_by == window.currentUserId).length;

            const elTotal = document.getElementById('totalEvents');
            const elApproved = document.getElementById('approvedEvents');
            const elPending = document.getElementById('pendingEvents');
            const elMy = document.getElementById('myParticipations');

            if (elTotal) elTotal.textContent = total;
            if (elApproved) elApproved.textContent = approved;
            if (elPending) elPending.textContent = pending;
            if (elMy) elMy.textContent = myParticipations || '?';
        })
        .catch(err => console.error('Ошибка загрузки статистики:', err));
}

// ================================================================
// === ФУНКЦИЯ ОТОБРАЖЕНИЯ МОДАЛЬНОГО ОКНА ===
// ================================================================
function renderEventModal(event, props, canEdit, isAdmin, isOwner) {
    const modalBody = document.getElementById('eventModalBody');
    const modalFooter = document.getElementById('eventModalFooter');
    const modalTitle = document.getElementById('eventModalLabel');
    
    if (!modalBody || !modalFooter || !modalTitle) {
        console.error('Элементы модального окна не найдены в DOM');
        return;
    }

    function truncateText(text, maxLength = 300) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.slice(0, maxLength) + '...';
    }

    const statusColors = {
        pending: 'warning',
        approved: 'success',
        rejected: 'danger',
        canceled: 'secondary',
        completed: 'info'
    };
    const statusTexts = {
        pending: 'На модерации',
        approved: 'Опубликовано',
        rejected: 'Отклонено',
        canceled: 'Отменено',
        completed: 'Завершено'
    };
    const statusColor = statusColors[props.status] || 'secondary';
    const statusText = statusTexts[props.status] || props.status;

    modalTitle.textContent = `📌 ${truncateText(event.title, 80)}`;

    const isRegistrationEnabled = props.is_registration_enabled === 1 || props.is_registration_enabled === true;
    const showParticipants = isOwner || isAdmin;

    modalBody.innerHTML = `
        <div class="row">
            <div class="col-md-8">
                <div class="mb-3 d-flex flex-wrap gap-1">
                    <span class="badge bg-${statusColor}" style="font-size: 0.9rem; padding: 0.4rem 0.9rem; border-radius: 1rem;">
                        ${statusText}
                    </span>
                    ${props.is_admin_event ? '<span class="badge bg-danger" style="font-size: 0.9rem; padding: 0.4rem 0.9rem; border-radius: 1rem;">🔒 Только для администраторов</span>' : ''}
                    ${isRegistrationEnabled ? '<span class="badge bg-info" style="font-size: 0.9rem; padding: 0.4rem 0.9rem; border-radius: 1rem;">📝 Запись открыта</span>' : ''}
                </div>

                <div class="mb-2" style="display: flex; align-items: baseline; gap: 0.5rem;">
                    <span style="font-weight: 600; color: #172033; min-width: 110px;">📅 Дата и время:</span>
                    <span>${new Date(props.start_datetime).toLocaleString('ru-RU')} — ${new Date(props.end_datetime).toLocaleString('ru-RU')}</span>
                </div>

                ${props.location ? `
                    <div class="mb-2" style="display: flex; align-items: baseline; gap: 0.5rem;">
                        <span style="font-weight: 600; color: #172033; min-width: 110px;">📍 Место:</span>
                        <span title="${props.location.replace(/"/g, '&quot;')}">${truncateText(props.location, 80)}</span>
                    </div>
                ` : ''}

                ${props.description ? `
                    <div class="mb-2" style="display: flex; align-items: flex-start; gap: 0.5rem;">
                        <span style="font-weight: 600; color: #172033; min-width: 110px;">📝 Описание:</span>
                        <span title="${props.description.replace(/"/g, '&quot;')}">${truncateText(props.description, 300)}</span>
                    </div>
                ` : ''}

                <div class="row mb-2">
                    <div class="col-6">
                        <span style="font-weight: 600; color: #172033;">📂 Тип:</span>
                        <span>${props.type || 'Не указан'}</span>
                    </div>
                    <div class="col-6">
                        <span style="font-weight: 600; color: #172033;">🏷️ Уровень:</span>
                        <span>${props.level === 'school' ? '🏫 Школьное' :
                                props.level === 'city' ? '🏙️ Городское' :
                                props.level === 'regional' ? '🌍 Региональное' :
                                props.level === 'national' ? '🇷🇺 Всероссийское' :
                                props.level === 'international' ? '🌐 Международное' : 'Не указан'}</span>
                    </div>
                </div>

                <div class="mb-2" style="display: flex; align-items: baseline; gap: 0.5rem;">
                    <span style="font-weight: 600; color: #172033; min-width: 110px;">👤 Организатор:</span>
                    <span>${props.creator || 'Неизвестен'}</span>
                </div>

                <div class="mb-2" style="display: flex; align-items: baseline; gap: 0.5rem;">
                    <span style="font-weight: 600; color: #172033; min-width: 110px;">🎯 Аудитория:</span>
                    <span>${props.target_audience_type === 'all' ? 'Все пользователи' :
                            props.target_audience_type === 'class' ? `Класс (ID: ${props.target_audience_id})` :
                            props.target_audience_type === 'parallel' ? `Параллель (ID: ${props.target_audience_id})` :
                            props.target_audience_type === 'department' ? `Кафедра (ID: ${props.target_audience_id})` :
                            props.target_audience_type === 'specific_users' ? `Конкретные пользователи (ID: ${props.target_audience_id})` :
                            props.target_audience_type === 'multiple_classes' ? `Несколько классов (ID: ${props.target_audience_id})` :
                            'Не указана'}</span>
                </div>

                ${props.created_at ? `
                    <div class="text-muted small mt-3" style="border-top: 1px solid #e9ecef; padding-top: 0.75rem;">
                        Создано: ${new Date(props.created_at).toLocaleString('ru-RU')}
                        ${props.updated_at && props.updated_at !== props.created_at ? `(обновлено: ${new Date(props.updated_at).toLocaleString('ru-RU')})` : ''}
                    </div>
                ` : ''}
            </div>

            <div class="col-md-4">
                ${showParticipants ? `
                    <div id="participantsContainer" style="display: none;">
                        <div class="card bg-light border-0 shadow-sm">
                            <div class="card-body">
                                <h6 class="card-title fw-semibold mb-2" style="color: #172033;">
                                    👥 Участники (<span id="participantsCount">0</span>)
                                </h6>
                                <div id="participantsList" class="small" style="max-height: 250px; overflow-y: auto;">
                                    <span class="text-muted">Загрузка...</span>
                                </div>
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="card bg-light border-0 shadow-sm">
                        <div class="card-body">
                            <h6 class="card-title fw-semibold mb-2" style="color: #172033;">📊 Статус</h6>
                            <span class="badge bg-${statusColor} fs-6" style="font-size: 1rem; padding: 0.4rem 1rem; border-radius: 1rem;">
                                ${statusText}
                            </span>
                            ${props.status === 'pending' ? `
                                <div class="alert alert-warning border-0 small mt-2 mb-0">
                                    ⏳ Мероприятие ожидает утверждения администратором.
                                </div>
                            ` : ''}
                            ${props.status === 'rejected' ? `
                                <div class="alert alert-danger border-0 small mt-2 mb-0">
                                    ❌ Мероприятие отклонено.
                                </div>
                            ` : ''}
                            ${props.status === 'completed' ? `
                                <div class="alert alert-info border-0 small mt-2 mb-0">
                                    ✔️ Мероприятие завершено.
                                </div>
                            ` : ''}
                            ${props.status === 'canceled' ? `
                                <div class="alert alert-secondary border-0 small mt-2 mb-0">
                                    🚫 Мероприятие отменено.
                                </div>
                            ` : ''}
                            ${props.status === 'approved' ? `
                                <div class="alert alert-success border-0 small mt-2 mb-0">
                                    ✅ Мероприятие опубликовано.
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `}
            </div>
        </div>
    `;

    if (showParticipants) {
        const container = document.getElementById('participantsContainer');
        const list = document.getElementById('participantsList');
        const count = document.getElementById('participantsCount');

        if (container && list && count) {
            container.style.display = 'block';

            fetch(`/api/events/${event.id}/participants`)
                .then(res => res.json())
                .then(participants => {
                    count.textContent = participants.length;
                    if (participants.length === 0) {
                        list.innerHTML = '<span class="text-muted">Нет участников</span>';
                    } else {
                        list.innerHTML = participants.map(p => 
                            `<div class="py-1 border-bottom border-light">👤 ${p.name} ${p.class_name ? '(' + p.class_name + ')' : ''}</div>`
                        ).join('');
                    }
                })
                .catch(err => {
                    console.error('Ошибка загрузки участников:', err);
                    list.innerHTML = '<span class="text-danger">Не удалось загрузить участников</span>';
                });
        }
    }

    let footerButtons = '';

    if (canEdit) {
        footerButtons += `
            <a href="/events/edit/${event.id}" class="btn btn-primary">
                ✏️ Редактировать
            </a>
        `;
    }

    if ((isOwner || isAdmin) && props.status === 'approved') {
        footerButtons += `
            <button type="button" class="btn btn-success" onclick="completeEvent(${event.id})">
                ✅ Завершить мероприятие
            </button>
        `;
    }

    if (isOwner && props.status === 'pending') {
        footerButtons += `
            <button type="button" class="btn btn-danger" onclick="openReasonModal(${event.id}, 'delete')">
                🗑️ Удалить
            </button>
        `;
    }

    if ((isOwner || isAdmin) && props.status === 'approved') {
        footerButtons += `
            <button type="button" class="btn btn-danger" onclick="openReasonModal(${event.id}, 'cancel', '/events/cancel/${event.id}')">
                ❌ Отменить мероприятие
            </button>
        `;
    }

    if (isAdmin && props.status === 'pending') {
        footerButtons += `
            <a href="/events/moderation" class="btn btn-warning">
                🔍 Модерация
            </a>
        `;
    }

    const userRole = parseInt(window.currentUserRole);
    if ((userRole === 1 || userRole === 6) && props.status === 'approved' && isRegistrationEnabled) {
        fetch(`/api/events/${event.id}/is-registered`)
            .then(res => res.json())
            .then(data => {
                let buttons = footerButtons;
                if (data.isRegistered) {
                    buttons += `
                        <button type="button" class="btn btn-danger" onclick="openReasonModal(${event.id}, 'cancel_registration')">
                            ❌ Отменить запись
                        </button>
                    `;
                } else {
                    buttons += `
                        <button type="button" class="btn btn-success" onclick="registerForEvent(${event.id})">
                            📝 Записаться
                        </button>
                    `;
                }
                modalFooter.innerHTML = buttons;
            })
            .catch(() => {
                let buttons = footerButtons;
                buttons += `
                    <button type="button" class="btn btn-success" onclick="registerForEvent(${event.id})">
                        📝 Записаться
                    </button>
                `;
                modalFooter.innerHTML = buttons;
            });
    } else {
        modalFooter.innerHTML = footerButtons;
    }
}

window.renderEventModal = renderEventModal;

// ================================================================
// === ФУНКЦИЯ ЗАПИСИ НА МЕРОПРИЯТИЕ ===
// ================================================================
function registerForEvent(eventId) {
    if (!confirm('Вы действительно хотите записаться на это мероприятие?')) return;

    fetch(`/api/events/${eventId}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('✅ ' + data.message);
            const modal = bootstrap.Modal.getInstance(document.getElementById('eventModal'));
            if (modal) modal.hide();
            if (window.calendar) {
                window.calendar.refetchEvents();
                loadStats();
            }
        } else {
            alert('❌ ' + (data.error || 'Ошибка при записи'));
        }
    })
    .catch(error => {
        console.error('Ошибка записи:', error);
        alert('❌ Ошибка сервера при записи');
    });
}

// ===== ЗАВЕРШЕНИЕ МЕРОПРИЯТИЯ =====
function completeEvent(eventId) {
    if (!confirm('Вы уверены, что мероприятие завершено? Оно переместится в архив.')) return;

    fetch(`/api/events/${eventId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('✅ ' + data.message);
            const modal = bootstrap.Modal.getInstance(document.getElementById('eventModal'));
            if (modal) modal.hide();
            if (window.calendar) {
                window.calendar.refetchEvents();
                loadStats();
            }
        } else {
            alert('❌ ' + (data.error || 'Ошибка завершения'));
        }
    })
    .catch(error => {
        console.error('Ошибка завершения:', error);
        alert('❌ Ошибка сервера');
    });
}