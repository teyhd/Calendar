(() => {
    const STATUS = {
        WAITING_ADMIN: { text: 'На модерации', className: 'waiting', color: '#f79009' },
        APPROVED: { text: 'Опубликовано', className: 'approved', color: '#12b76a' },
        REJECTED: { text: 'Отклонено', className: 'rejected', color: '#d92d20' },
        CANCELED: { text: 'Отменено', className: 'canceled', color: '#d92d20' },
        COMPLETED: { text: 'Завершено', className: 'completed', color: '#155eef' },
        DRAFT: { text: 'Черновик', className: 'draft', color: '#98a2b3' }
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (symbol) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[symbol]));
    }

    function formatDate(value) {
        if (!value) return 'Не указано';
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? 'Не указано' : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
    }

    function audienceText(props) {
        const labels = { all: 'Все пользователи', class: 'Класс', parallel: 'Параллель', department: 'Кафедра', specific_users: 'Выбранные пользователи', multiple_classes: 'Несколько классов' };
        return labels[props.target_audience_type] || 'Не указана';
    }

    function eventLevel(value) {
        const labels = { school: 'Школьный', city: 'Городской', regional: 'Региональный', national: 'Всероссийский', international: 'Международный' };
        return labels[value] || 'Не указан';
    }

    window.loadStats = function loadStats() {
        fetch('/api/events')
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('Не удалось загрузить статистику')))
            .then((events) => {
                const values = {
                    totalEvents: events.length,
                    approvedEvents: events.filter((event) => event.status === 'APPROVED').length,
                    pendingEvents: events.filter((event) => event.status === 'WAITING_ADMIN').length,
                    myParticipations: events.filter((event) => Number(event.created_by) === Number(window.currentUserId)).length
                };
                Object.entries(values).forEach(([id, value]) => {
                    const element = document.getElementById(id);
                    if (element) element.textContent = value;
                });
            })
            .catch((error) => console.error('Не удалось загрузить статистику:', error));
    };

    window.renderEventModal = function renderEventModal(event, props, canEdit, isAdmin, isOwner) {
        const body = document.getElementById('eventModalBody');
        const footer = document.getElementById('eventModalFooter');
        const title = document.getElementById('eventModalLabel');
        if (!body || !footer || !title) return;

        const status = STATUS[props.status] || STATUS.DRAFT;
        const registrationEnabled = props.is_registration_enabled === 1 || props.is_registration_enabled === true;
        const responsible = Array.isArray(props.responsible_names) ? props.responsible_names.join(', ') : props.responsible_names;
        title.textContent = String(event.title || 'Мероприятие').slice(0, 90);

        body.innerHTML = `
            <div class="app-detail-layout">
                <section>
                    <div class="app-detail-statuses"><span class="app-status app-status-${status.className}">${status.text}</span><span class="app-type">${escapeHtml(props.type_name || props.type || 'Без типа')}</span>${props.is_admin_event ? '<span class="app-type">Административное</span>' : ''}${registrationEnabled ? '<span class="app-type">Запись открыта</span>' : ''}</div>
                    <dl class="app-detail-list">
                        <div><dt>Дата и время</dt><dd>${formatDate(props.start_datetime)} — ${formatDate(props.end_datetime)}</dd></div>
                        ${props.location ? `<div><dt>Место</dt><dd>${escapeHtml(props.location)}</dd></div>` : ''}
                        ${props.description ? `<div><dt>Описание</dt><dd>${escapeHtml(props.description)}</dd></div>` : ''}
                        <div><dt>Тип</dt><dd>${escapeHtml(props.type_name || props.type || 'Не указан')}</dd></div>
                        <div><dt>Уровень</dt><dd>${eventLevel(props.level)}</dd></div>
                        <div><dt>Организатор</dt><dd>${escapeHtml(props.creator_name || props.creator || 'Неизвестен')}</dd></div>
                        ${responsible ? `<div><dt>Ответственные</dt><dd>${escapeHtml(responsible)}</dd></div>` : ''}
                        <div><dt>Аудитория</dt><dd>${audienceText(props)}</dd></div>
                    </dl>
                    ${props.created_at ? `<p class="app-detail-note">Создано ${formatDate(props.created_at)}${props.updated_at && props.updated_at !== props.created_at ? ` · обновлено ${formatDate(props.updated_at)}` : ''}</p>` : ''}
                </section>
                <aside class="app-detail-aside" id="eventSideInfo">
                    <section class="app-detail-panel"><h3>Статус</h3><span class="app-status app-status-${status.className}">${status.text}</span>${props.status === 'WAITING_ADMIN' ? '<p>Мероприятие ожидает решения администратора.</p>' : ''}</section>
                    ${isOwner || isAdmin ? '<section class="app-detail-panel" id="participantsContainer"><h3>Участники <span id="participantsCount">0</span></h3><div id="participantsList" class="app-detail-rows"><span class="app-help">Загрузка…</span></div></section>' : ''}
                    ${isAdmin ? '<section class="app-detail-panel" id="approvalsContainer"><h3>Согласование</h3><div id="approvalsList" class="app-detail-rows"><span class="app-help">Загрузка…</span></div></section>' : ''}
                </aside>
            </div>`;

        if (isOwner || isAdmin) loadParticipants(event.id);
        if (isAdmin) loadApprovals(event.id);

        let actions = '<span></span><button type="button" class="app-btn app-btn-secondary" data-dialog-close>Закрыть</button>';
        if (canEdit) actions += `<a class="app-btn app-btn-primary" href="/events/edit/${encodeURIComponent(event.id)}">Редактировать</a>`;
        if ((isOwner || isAdmin) && props.status === 'APPROVED') actions += `<button type="button" class="app-btn app-btn-primary" onclick="completeEvent(${Number(event.id)})">Завершить</button>`;
        if (isOwner && props.status === 'WAITING_ADMIN') actions += `<button type="button" class="app-btn app-btn-danger" onclick="openReasonModal(${Number(event.id)}, 'delete')">Удалить</button>`;
        if (isAdmin && (props.status === 'APPROVED' || props.status === 'WAITING_ADMIN')) actions += `<button type="button" class="app-btn app-btn-danger" onclick="openReasonModal(${Number(event.id)}, 'cancel')">Отменить</button>`;
        if (isAdmin && props.status === 'WAITING_ADMIN') actions += `<a class="app-btn app-btn-warning" href="/events/moderation">К модерации</a>`;
        footer.innerHTML = actions;

        const role = Number(window.currentUserRole || 0);
        if ((role === 1 || role === 6) && props.status === 'APPROVED' && registrationEnabled) {
            fetch(`/api/events/${encodeURIComponent(event.id)}/is-registered`)
                .then((response) => response.ok ? response.json() : { isRegistered: false })
                .then((result) => {
                    footer.insertAdjacentHTML('beforeend', result.isRegistered
                        ? `<button type="button" class="app-btn app-btn-danger" onclick="openReasonModal(${Number(event.id)}, 'cancel_registration')">Отменить запись</button>`
                        : `<button type="button" class="app-btn app-btn-primary" onclick="registerForEvent(${Number(event.id)})">Записаться</button>`);
                })
                .catch(() => footer.insertAdjacentHTML('beforeend', `<button type="button" class="app-btn app-btn-primary" onclick="registerForEvent(${Number(event.id)})">Записаться</button>`));
        }
    };

    function loadParticipants(eventId) {
        const list = document.getElementById('participantsList');
        const count = document.getElementById('participantsCount');
        fetch(`/api/events/${encodeURIComponent(eventId)}/participants`)
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('Не удалось загрузить участников')))
            .then((participants) => {
                if (count) count.textContent = participants.length;
                if (list) list.innerHTML = participants.length ? participants.map((participant) => `<div>${escapeHtml(participant.user_name)}${participant.class_name ? ` · ${escapeHtml(participant.class_name)}` : ''}</div>`).join('') : '<span class="app-help">Пока нет участников</span>';
            })
            .catch(() => { if (list) list.innerHTML = '<span class="app-help">Не удалось загрузить список</span>'; });
    }

    function loadApprovals(eventId) {
        const list = document.getElementById('approvalsList');
        fetch(`/api/events/${encodeURIComponent(eventId)}/approvals`)
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('Не удалось загрузить согласования')))
            .then((approvals) => {
                if (list) list.innerHTML = approvals.length ? approvals.map((approval) => `<div><strong>${escapeHtml(approval.user_name)}</strong><br><span class="app-help">${approval.status === 'approved' ? 'Утверждено' : approval.status === 'rejected' ? 'Отклонено' : 'Ожидает решения'}${approval.comment ? ` · ${escapeHtml(approval.comment)}` : ''}</span></div>`).join('') : '<span class="app-help">Нет данных по согласованию</span>';
            })
            .catch(() => { if (list) list.innerHTML = '<span class="app-help">Не удалось загрузить данные</span>'; });
    }

    window.registerForEvent = function registerForEvent(eventId) {
        if (!window.confirm('Записаться на это мероприятие?')) return;
        fetch(`/api/events/${encodeURIComponent(eventId)}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .then((response) => response.json())
            .then((data) => {
                if (!data.success) throw new Error(data.error || 'Не удалось записаться');
                window.appUI?.closeDialog('eventModal'); window.calendar?.refetchEvents(); window.loadStats();
            })
            .catch((error) => window.alert(error.message || 'Ошибка сервера'));
    };

    window.completeEvent = function completeEvent(eventId) {
        if (!window.confirm('Подтвердить завершение мероприятия? Оно будет перенесено в архив.')) return;
        fetch(`/api/events/${encodeURIComponent(eventId)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .then((response) => response.json())
            .then((data) => {
                if (!data.success) throw new Error(data.error || 'Не удалось завершить мероприятие');
                window.appUI?.closeDialog('eventModal'); window.calendar?.refetchEvents(); window.loadStats();
            })
            .catch((error) => window.alert(error.message || 'Ошибка сервера'));
    };

    document.addEventListener('DOMContentLoaded', () => {
        const calendarElement = document.getElementById('calendar');
        if (!calendarElement || !window.FullCalendar) return;

        window.currentUserId = document.querySelector('meta[name="user-id"]')?.content || 0;
        window.currentUserRole = document.querySelector('meta[name="user-role"]')?.content || 0;
        const calendar = new FullCalendar.Calendar(calendarElement, {
            initialView: 'dayGridMonth', locale: 'ru', height: 'auto',
            headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' },
            buttonText: { prev: 'Назад', next: 'Вперёд', today: 'Сегодня', month: 'Месяц', week: 'Неделя', list: 'Список' },
            events(fetchInfo, successCallback, failureCallback) {
                const params = new URLSearchParams({ search: document.getElementById('searchInput')?.value || '', status: document.getElementById('filterStatus')?.value || 'all', type: document.getElementById('filterType')?.value || 'all' });
                fetch(`/api/events?${params}`)
                    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Не удалось загрузить календарь')))
                    .then((events) => {
                        successCallback(events.map((item) => ({ id: item.id, title: item.title, start: item.start_datetime, end: item.end_datetime, extendedProps: { status: item.status } })));
                        window.loadStats();
                    })
                    .catch((error) => { console.error('Не удалось загрузить события:', error); failureCallback(error); });
            },
            eventClick(info) { window.openEventModal(info.event.id, info.el); },
            eventDidMount(info) {
                const status = STATUS[info.event.extendedProps.status] || STATUS.DRAFT;
                info.el.style.borderLeft = `3px solid ${status.color}`;
            }
        });
        calendar.render();
        window.calendar = calendar;

        ['searchInput', 'filterStatus', 'filterType'].forEach((id) => document.getElementById(id)?.addEventListener(id === 'searchInput' ? 'input' : 'change', () => calendar.refetchEvents()));
        document.getElementById('resetFiltersBtn')?.addEventListener('click', () => {
            const search = document.getElementById('searchInput'); const status = document.getElementById('filterStatus'); const type = document.getElementById('filterType');
            if (search) search.value = ''; if (status) status.value = 'all'; if (type) type.value = 'all'; calendar.refetchEvents();
        });
    });
})();
