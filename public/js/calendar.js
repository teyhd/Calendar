(() => {
    const STATUS = {
        WAITING_ADMIN: { text: 'На модерации', className: 'waiting', color: '#f79009' },
        APPROVED: { text: 'Опубликовано', className: 'approved', color: '#12b76a' },
        REJECTED: { text: 'Отклонено', className: 'rejected', color: '#d92d20' },
        CANCELED: { text: 'Отменено', className: 'canceled', color: '#d92d20' },
        COMPLETED: { text: 'Завершено', className: 'completed', color: '#155eef' },
        DRAFT: { text: 'Черновик', className: 'draft', color: '#98a2b3' }
    };
    const audienceLabels = { all: 'Все пользователи', class: 'Класс', parallel: 'Параллель', department: 'Кафедра', specific_users: 'Выбранные пользователи', multiple_classes: 'Несколько классов' };
    const levelLabels = { school: 'Школьный', city: 'Городской', regional: 'Региональный', national: 'Всероссийский', international: 'Международный' };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (symbol) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[symbol]));
    }

    function formatDate(value) {
        if (!value) return 'Не указано';
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? 'Не указано' : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
    }

    function commandButton(command, eventId, label, className = 'app-btn app-btn-secondary', extra = '') {
        return `<button type="button" class="${className}" data-workspace-command="${command}" data-event-id="${Number(eventId)}" ${extra}>${label}</button>`;
    }

    async function fetchJSON(url, options) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Не удалось получить данные');
        return data;
    }

    window.loadStats = async function loadStats() {
        try {
            const data = await fetchJSON('/api/workspace');
            window.workspaceBootstrap = data;
            const values = {
                totalEvents: data.counts.all,
                approvedEvents: data.counts.approved,
                pendingEvents: data.counts.pending,
                archiveEvents: data.counts.archive
            };
            Object.entries(values).forEach(([id, value]) => {
                const element = document.getElementById(id);
                if (element) element.textContent = value || 0;
            });
            const badge = document.getElementById('pendingBadge');
            if (badge) { badge.textContent = data.counts.pending || 0; badge.hidden = !data.counts.pending; }
            return data;
        } catch (error) {
            console.error('Не удалось загрузить сводку:', error);
            return null;
        }
    };

    function registrationMarkup(eventId) {
        const role = Number(window.currentUserRole || 0);
        if (![1, 6].includes(role)) return '';
        if (role === 6) {
            const children = window.workspaceBootstrap?.children || [];
            const choices = children.map((child) => `<option value="${Number(child.id)}">${escapeHtml(child.name)}${child.class_name ? ` · ${escapeHtml(child.class_name)}` : ''}</option>`).join('');
            return `<section class="app-detail-panel" id="registrationPanel"><h3>Запись ребёнка</h3>${choices ? `<label class="app-field"><span class="app-label">Участник</span><select class="app-select" id="registrationChild">${choices}</select></label><div class="app-actions-row" id="registrationAction"></div>` : '<p>В SSO нет детей, доступных для записи.</p>'}</section>`;
        }
        return '<section class="app-detail-panel" id="registrationPanel"><h3>Участие</h3><div class="app-actions-row" id="registrationAction"></div></section>';
    }

    function renderRegistrationAction(event) {
        const container = document.getElementById('registrationAction');
        if (!container) return;
        const role = Number(window.currentUserRole || 0);
        const selectedChild = document.getElementById('registrationChild');
        const update = async () => {
            const childId = role === 6 ? Number(selectedChild?.value || 0) : 0;
            if (role === 6 && !childId) return;
            container.innerHTML = '<span class="app-help">Проверяем запись…</span>';
            try {
                const query = childId ? `?child_id=${encodeURIComponent(childId)}` : '';
                const result = await fetchJSON(`/api/events/${encodeURIComponent(event.id)}/is-registered${query}`);
                const childAttribute = childId ? `data-child-id="${childId}"` : '';
                container.innerHTML = result.registered
                    ? commandButton('unregister', event.id, 'Отменить запись', 'app-btn app-btn-danger', childAttribute)
                    : commandButton('register', event.id, role === 6 ? 'Записать ребёнка' : 'Записаться', 'app-btn app-btn-primary', childAttribute);
            } catch (error) {
                container.innerHTML = '<span class="app-help">Не удалось проверить запись.</span>';
            }
        };
        selectedChild?.addEventListener('change', update);
        update();
    }

    async function loadParticipants(eventId) {
        const list = document.getElementById('participantsList');
        const count = document.getElementById('participantsCount');
        try {
            const participants = await fetchJSON(`/api/events/${encodeURIComponent(eventId)}/participants`);
            if (count) count.textContent = participants.length;
            if (list) list.innerHTML = participants.length ? participants.map((participant) => `<div>${escapeHtml(participant.user_name)}${participant.class_name ? ` · ${escapeHtml(participant.class_name)}` : ''}</div>`).join('') : '<span class="app-help">Пока нет участников</span>';
        } catch { if (list) list.innerHTML = '<span class="app-help">Не удалось загрузить список</span>'; }
    }

    async function loadApprovals(eventId) {
        const list = document.getElementById('approvalsList');
        try {
            const approvals = await fetchJSON(`/api/events/${encodeURIComponent(eventId)}/approvals`);
            const pending = approvals.filter((approval) => approval.status === 'pending').length;
            const heading = document.getElementById('approvalsHeading');
            if (heading) heading.textContent = pending ? `Согласование · ждём ${pending}` : 'Согласование завершено';
            if (list) list.innerHTML = approvals.length ? approvals.map((approval) => `<div><strong>${escapeHtml(approval.user_name)}</strong><br><span class="app-help">${approval.status === 'approved' ? 'Подтверждено' : approval.status === 'rejected' ? 'Отклонено' : 'Ожидает решения'}${approval.comment ? ` · ${escapeHtml(approval.comment)}` : ''}</span></div>`).join('') : '<span class="app-help">Нет данных по согласованию</span>';
        } catch { if (list) list.innerHTML = '<span class="app-help">Не удалось загрузить данные</span>'; }
    }

    function eventActions(event, isOwner, isAdmin) {
        const actions = [];
        const canEdit = isAdmin || (isOwner && ['WAITING_ADMIN', 'REJECTED'].includes(event.status));
        if (canEdit) actions.push(commandButton('edit', event.id, 'Редактировать', 'app-btn app-btn-primary'));
        if (isOwner && event.status === 'REJECTED') actions.push(commandButton('copy', event.id, 'Повторить', 'app-btn app-btn-warning'));
        if (isOwner && event.status === 'REJECTED') actions.push(commandButton('resend', event.id, 'Отправить повторно', 'app-btn app-btn-secondary'));
        if ((isOwner || isAdmin) && event.status === 'APPROVED') actions.push(commandButton('complete', event.id, 'Завершить', 'app-btn app-btn-primary'));
        if (isOwner && ['WAITING_ADMIN', 'REJECTED'].includes(event.status)) actions.push(commandButton('delete', event.id, 'Удалить', 'app-btn app-btn-danger'));
        if (event.can_approve_assigned && event.status === 'WAITING_ADMIN') actions.push(commandButton('approve', event.id, 'Подтвердить', 'app-btn app-btn-primary'));
        if (event.can_approve_assigned && event.status === 'WAITING_ADMIN') actions.push(commandButton('reject', event.id, 'Отклонить', 'app-btn app-btn-danger'));
        if (isAdmin && ['APPROVED', 'WAITING_ADMIN'].includes(event.status)) actions.push(commandButton('cancel', event.id, 'Отменить', 'app-btn app-btn-danger'));
        if ((isOwner || isAdmin) && event.status === 'COMPLETED') actions.push(commandButton('review', event.id, event.review_text ? 'Изменить отзыв' : 'Добавить отзыв', 'app-btn app-btn-secondary'));
        return actions.join('');
    }

    window.calendarUI = {
        status: STATUS,
        escapeHtml,
        formatDate,
        renderEvent(event) {
            const body = document.getElementById('eventModalBody');
            const footer = document.getElementById('eventModalFooter');
            const title = document.getElementById('eventModalLabel');
            if (!body || !footer || !title) return;
            const status = STATUS[event.status] || STATUS.DRAFT;
            const userId = Number(window.currentUserId || 0);
            const role = Number(window.currentUserRole || 0);
            const isOwner = Number(event.created_by) === userId;
            const isAdmin = role === 5;
            const registrationEnabled = event.is_registration_enabled === 1 || event.is_registration_enabled === true;
            title.textContent = String(event.title || 'Мероприятие').slice(0, 90);
            body.innerHTML = `
                <div class="app-detail-layout">
                    <section>
                        <div class="app-detail-statuses"><span class="app-status app-status-${status.className}">${status.text}</span><span class="app-type">${escapeHtml(event.type_name || 'Без типа')}</span>${event.is_admin_event ? '<span class="app-type">Административное</span>' : ''}${registrationEnabled ? '<span class="app-type">Запись открыта</span>' : ''}</div>
                        <dl class="app-detail-list">
                            <div><dt>Дата и время</dt><dd>${formatDate(event.start_datetime)} — ${formatDate(event.end_datetime)}</dd></div>
                            ${event.location ? `<div><dt>Место</dt><dd>${escapeHtml(event.location)}</dd></div>` : ''}
                            ${event.description ? `<div><dt>Описание</dt><dd>${escapeHtml(event.description)}</dd></div>` : ''}
                            <div><dt>Уровень</dt><dd>${levelLabels[event.level] || 'Не указан'}</dd></div>
                            <div><dt>Организатор</dt><dd>${escapeHtml(event.creator_name || 'Неизвестен')}</dd></div>
                            ${event.responsible_names?.length ? `<div><dt>Ответственные</dt><dd>${escapeHtml(event.responsible_names.join(', '))}</dd></div>` : ''}
                            <div><dt>Аудитория</dt><dd>${escapeHtml(event.audience_name || audienceLabels[event.target_audience_type] || 'Не указана')}</dd></div>
                        </dl>
                        ${event.rejection_reason ? `<p class="app-alert app-alert-danger">Причина отклонения: ${escapeHtml(event.rejection_reason)}</p>` : ''}
                        ${event.cancel_reason ? `<p class="app-alert app-alert-warning">Причина отмены: ${escapeHtml(event.cancel_reason)}</p>` : ''}
                        ${event.review_text ? `<section class="app-detail-panel app-section-gap"><h3>Отзыв</h3><p>${escapeHtml(event.review_text)}</p></section>` : ''}
                    </section>
                    <aside class="app-detail-aside">
                        <section class="app-detail-panel"><h3>Статус</h3><span class="app-status app-status-${status.className}">${status.text}</span>${event.status === 'WAITING_ADMIN' ? '<p>Публикация произойдёт после подтверждения всех назначенных администраторов.</p>' : ''}</section>
                        ${isOwner || isAdmin ? '<section class="app-detail-panel"><h3>Участники <span id="participantsCount">0</span></h3><div id="participantsList" class="app-detail-rows"><span class="app-help">Загрузка…</span></div></section>' : ''}
                        ${isAdmin ? '<section class="app-detail-panel"><h3 id="approvalsHeading">Согласование</h3><div id="approvalsList" class="app-detail-rows"><span class="app-help">Загрузка…</span></div></section>' : ''}
                        ${registrationEnabled && event.status === 'APPROVED' ? registrationMarkup(event.id) : ''}
                    </aside>
                </div>`;
            if (isOwner || isAdmin) loadParticipants(event.id);
            if (isAdmin) loadApprovals(event.id);
            if (registrationEnabled && event.status === 'APPROVED') renderRegistrationAction(event);
            footer.innerHTML = `<span></span><div class="app-actions-row">${eventActions(event, isOwner, isAdmin)}<button type="button" class="app-btn app-btn-secondary" data-dialog-close>Закрыть</button></div>`;
        }
    };

    function mountCalendar(calendarElement, options = {}) {
        if (!calendarElement || !window.FullCalendar) return null;
        window.currentUserId = document.querySelector('meta[name="user-id"]')?.content || 0;
        window.currentUserRole = document.querySelector('meta[name="user-role"]')?.content || 0;
        const compactCalendar = window.matchMedia('(max-width: 820px)');
        const calendar = new FullCalendar.Calendar(calendarElement, {
            initialView: compactCalendar.matches ? 'listWeek' : 'dayGridMonth', locale: 'ru', height: 'auto',
            headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' },
            buttonText: { prev: 'Назад', next: 'Вперёд', today: 'Сегодня', month: 'Месяц', week: 'Неделя', list: 'Список' },
            events(fetchInfo, successCallback, failureCallback) {
                const params = new URLSearchParams({
                    view: options.view || 'calendar',
                    search: options.filters?.search || '',
                    status: options.filters?.status || 'all',
                    type: options.filters?.type || 'all',
                    from: fetchInfo.startStr.slice(0, 10),
                    to: fetchInfo.endStr.slice(0, 10)
                });
                fetchJSON(`/api/workspace/events?${params}`)
                    .then((events) => {
                        const items = events.items || events;
                        successCallback(items.map((item) => ({
                            id: item.id,
                            title: options.view === 'children' && item.child_name ? `${item.title} · ${item.child_name}` : item.title,
                            start: item.start_datetime,
                            end: item.end_datetime,
                            classNames: [`app-calendar-event--${(item.status || 'DRAFT').toLowerCase()}`],
                            extendedProps: { status: item.status }
                        })));
                        options.onEvents?.(items);
                    })
                    .catch((error) => { console.error('Не удалось загрузить календарь:', error); failureCallback(error); });
            },
            eventClick(info) { window.openEventModal(info.event.id, info.el); },
            eventDidMount(info) { info.el.style.borderLeft = `3px solid ${(STATUS[info.event.extendedProps.status] || STATUS.DRAFT).color}`; },
            windowResize() { if (compactCalendar.matches && calendar.view.type !== 'listWeek') calendar.changeView('listWeek'); }
        });
        calendar.render();
        window.calendar = calendar;
        return calendar;
    }
    window.calendarUI.mountCalendar = mountCalendar;
})();
