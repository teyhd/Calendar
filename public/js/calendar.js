document.addEventListener('DOMContentLoaded', function() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;

    // Получаем мета-данные пользователя
    window.currentUserId = document.querySelector('meta[name="user-id"]')?.content || 0;
    window.currentUserRole = document.querySelector('meta[name="user-role"]')?.content || '';

    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'ru', // русская локализация (месяцы, дни недели)
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,listWeek'
        },
        // ---------- ПЕРЕВОД КНОПОК ----------
        buttonText: {
            today: 'Сегодня',
            month: 'Месяц',
            week: 'Неделя',
            list: 'Список',
            // Для навигации (если нужно) – обычно это иконки, но можно задать текст:
            prev: '‹',
            next: '›'
        },
        // Всплывающие подсказки для навигации (тоже на русском)
        buttonHints: {
            prev: 'Предыдущий',
            next: 'Следующий',
            today: 'Сегодня'
        },
        // ------------------------------------
        events: function(fetchInfo, successCallback, failureCallback) {
            fetch('/api/events')
                .then(response => {
                    if (!response.ok) throw new Error('Ошибка загрузки событий');
                    return response.json();
                })
                .then(events => {
                    const formattedEvents = events.map(event => ({
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
                            created_at: event.created_at,
                            updated_at: event.updated_at
                        }
                    }));
                    successCallback(formattedEvents);
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
            const userRole = window.currentUserRole;
            const isOwner = parseInt(props.created_by) === parseInt(userId);
            const isAdmin = userRole === 'admin';
            const canEdit = isAdmin || (isOwner && props.status === 'pending');
    
            renderEventModal(event, props, canEdit, isAdmin, isOwner);
    
            const modal = new bootstrap.Modal(document.getElementById('eventModal'));
            modal.show();
        },
        eventDidMount: function(info) {
            const status = info.event.extendedProps.status;
            if (status === 'approved') {
                info.el.style.borderLeft = '4px solid #28a745';
            } else if (status === 'pending') {
                info.el.style.borderLeft = '4px solid #ffc107';
            } else if (status === 'rejected') {
                info.el.style.borderLeft = '4px solid #dc3545';
            } else if (status === 'completed') {
                info.el.style.borderLeft = '4px solid #17a2b8';
            } else if (status === 'canceled') {
                info.el.style.borderLeft = '4px solid #6c757d';
            }
        }
    });

    calendar.render();
    window.calendar = calendar;
});

// ===== ФУНКЦИЯ ОТОБРАЖЕНИЯ МОДАЛЬНОГО ОКНА =====
function renderEventModal(event, props, canEdit, isAdmin, isOwner) {
    const modalBody = document.getElementById('eventModalBody');
    const modalFooter = document.getElementById('eventModalFooter');
    const modalTitle = document.getElementById('eventModalLabel');
    
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
    
    modalTitle.textContent = `📌 ${event.title}`;
    
    modalBody.innerHTML = `
        <div class="row">
            <div class="col-md-8">
                <div class="mb-3">
                    <span class="badge bg-${statusColor}">${statusText}</span>
                    ${props.is_admin_event ? '<span class="badge bg-danger">🔒 Только для администраторов</span>' : ''}
                </div>
                
                <div class="mb-3">
                    <strong>📅 Дата и время:</strong><br>
                    ${new Date(props.start_datetime).toLocaleString('ru-RU')} — ${new Date(props.end_datetime).toLocaleString('ru-RU')}
                </div>
                
                ${props.location ? `
                    <div class="mb-3">
                        <strong>📍 Место:</strong><br>
                        ${props.location}
                    </div>
                ` : ''}
                
                ${props.description ? `
                    <div class="mb-3">
                        <strong>📝 Описание:</strong><br>
                        ${props.description}
                    </div>
                ` : ''}
                
                <div class="row mb-3">
                    <div class="col-md-6">
                        <strong>📂 Тип:</strong> ${props.type || 'Не указан'}
                    </div>
                    <div class="col-md-6">
                        <strong>🏷️ Уровень:</strong> 
                        ${props.level === 'school' ? '🏫 Школьное' : 
                          props.level === 'city' ? '🏙️ Городское' : 
                          props.level === 'regional' ? '🌍 Региональное' : 
                          props.level === 'national' ? '🇷🇺 Всероссийское' : 
                          props.level === 'international' ? '🌐 Международное' : 'Не указан'}
                    </div>
                </div>
                
                <div class="mb-3">
                    <strong>👤 Организатор:</strong> ${props.creator || 'Неизвестен'}
                </div>
                
                <div class="mb-3">
                    <strong>🎯 Аудитория:</strong> 
                    ${props.target_audience_type === 'all' ? 'Все пользователи' :
                      props.target_audience_type === 'class' ? `Класс (ID: ${props.target_audience_id})` :
                      props.target_audience_type === 'parallel' ? `Параллель (ID: ${props.target_audience_id})` :
                      props.target_audience_type === 'department' ? `Кафедра (ID: ${props.target_audience_id})` :
                      props.target_audience_type === 'specific_users' ? `Конкретные пользователи (ID: ${props.target_audience_id})` : 'Не указана'}
                </div>
                
                ${props.created_at ? `
                    <div class="text-muted small mt-3">
                        Создано: ${new Date(props.created_at).toLocaleString('ru-RU')}
                    </div>
                ` : ''}
            </div>
            
            <div class="col-md-4">
                <div class="card bg-light">
                    <div class="card-body">
                        <h6 class="card-title">📊 Статус</h6>
                        <p class="card-text">
                            <span class="badge bg-${statusColor} fs-6">${statusText}</span>
                        </p>
                        ${props.status === 'pending' ? `
                            <div class="alert alert-warning small mb-0">
                                ⏳ Мероприятие ожидает утверждения администратором.
                            </div>
                        ` : ''}
                        ${props.status === 'approved' ? `
                            <div class="alert alert-success small mb-0">
                                ✅ Мероприятие опубликовано и доступно для просмотра.
                            </div>
                        ` : ''}
                        ${props.status === 'rejected' ? `
                            <div class="alert alert-danger small mb-0">
                                ❌ Мероприятие отклонено.
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    let footerButtons = '';
    
    if (canEdit) {
        footerButtons += `
            <a href="/events/edit/${event.id}" class="btn btn-primary">
                ✏️ Редактировать
            </a>
        `;
    }
    
    const userRole = window.currentUserRole;
    if ((userRole === 'student' || userRole === 'parent') && props.status === 'approved') {
        footerButtons += `
            <button type="button" class="btn btn-success" onclick="registerForEvent(${event.id})">
                📝 Записаться
            </button>
        `;
    }
    
    if (isAdmin && props.status === 'pending') {
        footerButtons += `
            <a href="/events/moderation" class="btn btn-warning">
                🔍 Перейти к модерации
            </a>
        `;
    }
    
    footerButtons += `
        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>
    `;
    
    modalFooter.innerHTML = footerButtons;
}

// ===== ФУНКЦИЯ ЗАПИСИ НА МЕРОПРИЯТИЕ =====
function registerForEvent(eventId) {
    if (!confirm('Вы действительно хотите записаться на это мероприятие?')) {
        return;
    }
    
    fetch(`/api/events/${eventId}/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('✅ ' + data.message);
            const modal = bootstrap.Modal.getInstance(document.getElementById('eventModal'));
            if (modal) modal.hide();
            if (window.calendar) {
                window.calendar.refetchEvents();
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