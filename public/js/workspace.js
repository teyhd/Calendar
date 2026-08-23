(() => {
    const state = { bootstrap: null, formOptions: null, scope: 'all', charts: {} };
    const scopeTitles = {
        all: ['Календарь мероприятий', 'Все доступные события школы.'],
        mine: ['Мои мероприятия', 'Созданные события и записи, которые требуют вашего внимания.'],
        children: ['События детей', 'Расписание и записи, доступные вашим детям.'],
        archive: ['История мероприятий', 'Завершённые, отменённые и отклонённые события.'],
        reviews: ['Отзывы', 'Итоги завершённых мероприятий от организаторов.'],
        moderation: ['Модерация', 'Заявки ожидают решения всех назначенных администраторов.']
    };

    function escapeHtml(value) { return window.calendarUI?.escapeHtml?.(value) || String(value ?? ''); }
    function formatDate(value) { return window.calendarUI?.formatDate?.(value) || String(value || ''); }
    function dialog(id) { return document.getElementById(id); }
    function openDialog(id, opener) { window.appUI?.openDialog(id, opener); }
    function closeDialog(id) { window.appUI?.closeDialog(id); }
    function request(url, options = {}) { return window.appUI?.request(url, options); }
    function formRequest(url, payload = {}) {
        return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    function params(update = {}, { replace = true } = {}) {
        const url = new URL(window.location.href);
        Object.entries(update).forEach(([key, value]) => {
            if (value == null || value === '' || value === 'all') url.searchParams.delete(key);
            else url.searchParams.set(key, value);
        });
        window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}`);
    }
    function notify(message, tone = 'success') {
        const region = document.getElementById('toastRegion');
        if (!region) return;
        const item = document.createElement('div');
        item.className = `app-toast app-toast-${tone}`;
        item.textContent = message;
        region.append(item);
        setTimeout(() => item.remove(), 5000);
    }
    function afterMutation(message, { eventId = null, scope = null } = {}) {
        if (scope) setScope(scope, { updateURL: false });
        window.calendar?.refetchEvents(); window.loadStats?.().then((data) => { state.bootstrap = data || state.bootstrap; });
        notify(message);
        if (eventId) setTimeout(() => window.openEventModal?.(eventId), 150);
    }
    function setScope(scope, { updateURL = true } = {}) {
        state.scope = scopeTitles[scope] ? scope : 'all';
        window.workspaceScope = state.scope;
        if (updateURL) params({ scope: state.scope, panel: null, compose: null, event: null }, { replace: false });
        const [title, summary] = scopeTitles[state.scope];
        const heading = document.querySelector('.app-page-title');
        const description = document.getElementById('workspaceSummary');
        if (heading) heading.textContent = title;
        if (description) description.textContent = summary;
        document.querySelectorAll('[data-workspace-scope]').forEach((button) => button.classList.toggle('is-active', button.dataset.workspaceScope === state.scope));
        window.calendar?.refetchEvents();
    }
    function localDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.valueOf())) return String(value).replace(' ', 'T').slice(0, 16);
        const offset = date.getTimezoneOffset() * 60_000;
        return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
    }
    function optionList(items, selected = [], label = (item) => item.name) {
        const selectedIds = new Set(selected.map((value) => String(value)));
        return items.map((item) => `<option value="${Number(item.id)}"${selectedIds.has(String(item.id)) ? ' selected' : ''}>${escapeHtml(label(item))}</option>`).join('');
    }
    function eventFormMarkup(event = {}, mode = 'create') {
        const types = state.formOptions.types || [];
        const subjects = state.formOptions.subjects || [];
        const classes = state.formOptions.classes || [];
        const departments = state.formOptions.departments || [];
        const users = state.formOptions.users || [];
        const audienceType = event.target_audience_type || state.formOptions.defaults.target_audience_type || 'class';
        const audienceValues = String(event.target_audience_id || '').split(',').filter(Boolean);
        const responsible = String(event.responsible_ids || state.formOptions.defaults.responsible_ids.join(',')).split(',').filter(Boolean);
        const eventType = Number(event.event_type_id || 0);
        const selectedTypes = types.map((type) => `<option value="${Number(type.id)}"${Number(type.id) === eventType ? ' selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
        const levels = [['school', 'Школьный'], ['city', 'Городской'], ['regional', 'Региональный'], ['national', 'Всероссийский'], ['international', 'Международный']]
            .map(([value, label]) => `<option value="${value}"${(event.level || 'school') === value ? ' selected' : ''}>${label}</option>`).join('');
        const defaultTime = new Date(); defaultTime.setHours(9, 0, 0, 0);
        const defaultEnd = new Date(defaultTime.valueOf() + 60 * 60 * 1000);
        return `
            <form class="event-form app-composer-form" id="workspaceEventForm" data-mode="${mode}" data-event-id="${event.id || ''}">
                <div class="app-form-section"><h3>Основное</h3>
                    <label class="app-field"><span class="app-label">Название *</span><input class="app-input" name="title" maxlength="100" required value="${escapeHtml(event.title || '')}" placeholder="Например, олимпиада по математике"></label>
                    <div class="app-two-col">
                        <label class="app-field"><span class="app-label">Тип *</span><select class="app-select" name="event_type_id" required><option value="">Выберите тип</option>${selectedTypes}</select></label>
                        <label class="app-field"><span class="app-label">Уровень</span><select class="app-select" name="level">${levels}</select></label>
                    </div>
                    <div class="app-two-col">
                        <label class="app-field"><span class="app-label">Начало *</span><input class="app-input" type="datetime-local" name="start_datetime" required value="${localDateTime(event.start_datetime) || localDateTime(defaultTime)}"></label>
                        <label class="app-field"><span class="app-label">Окончание *</span><input class="app-input" type="datetime-local" name="end_datetime" required value="${localDateTime(event.end_datetime) || localDateTime(defaultEnd)}"></label>
                    </div>
                </div>
                <div class="app-form-section"><h3>Для кого</h3>
                    <label class="app-field"><span class="app-label">Аудитория *</span><select class="app-select" id="audienceType" name="target_audience_type">
                        <option value="class"${audienceType === 'class' ? ' selected' : ''}>Конкретный класс</option>
                        <option value="multiple_classes"${audienceType === 'multiple_classes' ? ' selected' : ''}>Несколько классов</option>
                        <option value="parallel"${audienceType === 'parallel' ? ' selected' : ''}>Целая параллель</option>
                        <option value="department"${audienceType === 'department' ? ' selected' : ''}>Кафедра</option>
                        <option value="specific_users"${audienceType === 'specific_users' ? ' selected' : ''}>Конкретные пользователи</option>
                        <option value="all"${audienceType === 'all' ? ' selected' : ''}>Все пользователи</option>
                    </select></label>
                    <div id="audienceValue"></div>
                </div>
                <div class="app-form-section"><h3>Ответственные *</h3>
                    <label class="app-field"><span class="app-label">Организаторы</span><select class="app-select" id="responsibleIds" multiple size="5" required>${optionList(users.filter((person) => [2, 3, 4, 5].includes(Number(person.type))), responsible, (person) => `${person.name} · ${person.role_name || 'сотрудник'}`)}</select><span class="app-help">Создатель уже выбран. Удерживайте Ctrl или ⌘, чтобы выбрать нескольких.</span></label>
                </div>
                <details class="app-form-advanced" ${event.description || event.location || event.is_registration_enabled || (event.reward_type && event.reward_type !== 'none') ? 'open' : ''}><summary>Дополнительные параметры</summary><div class="app-stack app-section-gap">
                    <label class="app-field"><span class="app-label">Описание</span><textarea class="app-textarea" name="description" rows="3" maxlength="500" placeholder="Коротко опишите событие">${escapeHtml(event.description || '')}</textarea></label>
                    <label class="app-field"><span class="app-label">Место проведения</span><input class="app-input" name="location" maxlength="255" value="${escapeHtml(event.location || '')}" placeholder="Актовый зал, кабинет 301"></label>
                    <div class="app-two-col"><label class="app-field"><span class="app-label">Предмет</span><select class="app-select" name="subject_id"><option value="">Не выбран</option>${optionList(subjects, event.subject_id ? [event.subject_id] : [])}</select></label><label class="app-field"><span class="app-label">Кафедра</span><select class="app-select" name="department_id"><option value="">Не выбрана</option>${optionList(departments, event.department_id ? [event.department_id] : [])}</select></label></div>
                    <label class="app-check"><input type="checkbox" name="is_registration_enabled" value="1"${event.is_registration_enabled ? ' checked' : ''}><span>Открыть самостоятельную запись</span></label>
                    <label class="app-check"><input type="checkbox" id="rewardsEnabled" name="enable_rewards" value="1"${event.reward_type && event.reward_type !== 'none' ? ' checked' : ''}><span>Начислять награды за участие</span></label>
                    <div class="app-two-col" id="rewardsFields"><label class="app-field"><span class="app-label">Тип награды</span><select class="app-select" name="reward_type"><option value="educational"${event.reward_type === 'educational' ? ' selected' : ''}>Учебная</option><option value="competitive"${event.reward_type === 'competitive' ? ' selected' : ''}>Соревновательная</option></select></label><label class="app-field"><span class="app-label">Призовых мест</span><input class="app-input" type="number" name="places_count" min="1" max="100" value="${escapeHtml(event.reward_places || 3)}"></label></div>
                    ${Number(state.bootstrap?.user?.type) === 5 ? `<label class="app-check"><input type="checkbox" name="is_admin_event" value="1"${event.is_admin_event ? ' checked' : ''}><span>Административное мероприятие</span></label>` : ''}
                </div></details>
                <div class="app-form-actions"><button class="app-btn app-btn-primary" type="submit">${mode === 'edit' ? 'Сохранить и отправить' : mode === 'copy' ? 'Создать повтор' : 'Создать мероприятие'}</button><button class="app-btn app-btn-secondary" type="button" data-dialog-close>Отмена</button></div>
            </form>`;
    }
    function audienceControl(event = {}) {
        const container = document.getElementById('audienceValue');
        const type = document.getElementById('audienceType')?.value;
        if (!container || !type) return;
        const classes = state.formOptions.classes || [];
        const departments = state.formOptions.departments || [];
        const users = state.formOptions.users || [];
        const values = String(event.target_audience_id || document.getElementById('audienceValue')?.dataset.value || '').split(',').filter(Boolean);
        const selected = new Set(values.map(String));
        container.dataset.value = values.join(',');
        if (type === 'all') { container.innerHTML = '<p class="app-help">Событие будет доступно всем пользователям системы.</p>'; return; }
        if (type === 'class') { container.innerHTML = `<label class="app-field"><span class="app-label">Класс *</span><select class="app-select" id="audienceValues"><option value="">Выберите класс</option>${optionList(classes, values)}</select></label>`; return; }
        if (type === 'parallel') {
            const parallels = [...new Set(classes.map((item) => String(item.name || '').match(/^\d+/)?.[0]).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
            container.innerHTML = `<label class="app-field"><span class="app-label">Параллель *</span><select class="app-select" id="audienceValues"><option value="">Выберите параллель</option>${parallels.map((value) => `<option value="${value}"${selected.has(value) ? ' selected' : ''}>${value} класс</option>`).join('')}</select></label>`; return;
        }
        if (type === 'department') { container.innerHTML = `<label class="app-field"><span class="app-label">Кафедра *</span><select class="app-select" id="audienceValues"><option value="">Выберите кафедру</option>${optionList(departments, values)}</select></label>`; return; }
        if (type === 'multiple_classes') { container.innerHTML = `<label class="app-field"><span class="app-label">Классы *</span><select class="app-select" id="audienceValues" multiple size="6">${optionList(classes, values)}</select><span class="app-help">Можно выбрать несколько классов.</span></label>`; return; }
        container.innerHTML = `<label class="app-field"><span class="app-label">Пользователи *</span><select class="app-select" id="audienceValues" multiple size="7">${optionList(users, values, (person) => `${person.name} · ${person.kaf_name || person.role_name || 'пользователь'}`)}</select><span class="app-help">Можно выбрать нескольких пользователей.</span></label>`;
    }
    async function openComposer(mode = 'create', eventId = null, opener = document.activeElement) {
        if (!state.bootstrap?.user?.permissions?.create_event) return notify('У вас нет права создавать мероприятия.', 'danger');
        const body = document.getElementById('eventComposerBody');
        body.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка формы…</div></div>';
        openDialog('eventComposer', opener);
        try {
            const [options, source] = await Promise.all([
                state.formOptions ? Promise.resolve(state.formOptions) : request('/api/event-form-options'),
                eventId ? request(`/api/events/${encodeURIComponent(eventId)}`) : Promise.resolve({})
            ]);
            state.formOptions = options;
            const event = mode === 'create' ? {} : source;
            document.getElementById('eventComposerLabel').textContent = mode === 'edit' ? 'Редактировать мероприятие' : mode === 'copy' ? 'Повторить мероприятие' : 'Создать мероприятие';
            document.getElementById('eventComposerKicker').textContent = mode === 'edit' ? 'Рабочая версия' : mode === 'copy' ? 'На основе существующего' : 'Новое событие';
            body.innerHTML = eventFormMarkup(event, mode);
            audienceControl(event);
            document.getElementById('audienceType')?.addEventListener('change', () => {
                const audience = document.getElementById('audienceValue');
                if (audience) audience.dataset.value = '';
                audienceControl({});
            });
            const rewards = document.getElementById('rewardsEnabled');
            const rewardFields = document.getElementById('rewardsFields');
            const syncRewards = () => { if (rewardFields) rewardFields.hidden = !rewards?.checked; };
            rewards?.addEventListener('change', syncRewards); syncRewards();
            document.getElementById('workspaceEventForm')?.addEventListener('submit', (formEvent) => submitEventForm(formEvent, mode, event.id));
            params({ compose: mode, event: eventId, panel: null }, { replace: true });
        } catch (error) { body.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить форму.')}</div>`; }
    }
    async function submitEventForm(formEvent, mode, eventId) {
        formEvent.preventDefault();
        const form = formEvent.currentTarget;
        const data = Object.fromEntries(new FormData(form).entries());
        const audienceType = data.target_audience_type;
        const audienceValues = [...(document.getElementById('audienceValues')?.selectedOptions || [])].map((option) => option.value);
        const responsible = [...(document.getElementById('responsibleIds')?.selectedOptions || [])].map((option) => option.value);
        data.target_audience_id = audienceValues[0] || '';
        data.target_audience_ids = audienceValues.join(',');
        data.responsible_ids = responsible.join(',');
        if (audienceType === 'all') data.target_audience_id = '';
        if (!responsible.length) return notify('Выберите хотя бы одного ответственного.', 'danger');
        if (['class', 'parallel', 'department'].includes(audienceType) && !data.target_audience_id) return notify('Выберите аудиторию мероприятия.', 'danger');
        if (['multiple_classes', 'specific_users'].includes(audienceType) && !data.target_audience_ids) return notify('Выберите аудиторию мероприятия.', 'danger');
        const submit = form.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = 'Сохраняем…';
        try {
            const url = mode === 'edit' ? `/events/edit/${encodeURIComponent(eventId)}` : '/events/create';
            const result = await formRequest(url, data);
            closeDialog('eventComposer');
            params({ compose: null, event: null }, { replace: true });
            afterMutation(mode === 'edit' ? 'Изменения сохранены и отправлены на согласование.' : 'Мероприятие создано и отправлено на согласование.', { eventId: result.event, scope: 'mine' });
        } catch (error) { notify(error.message || 'Не удалось сохранить мероприятие.', 'danger'); submit.disabled = false; submit.textContent = mode === 'edit' ? 'Сохранить и отправить' : 'Создать мероприятие'; }
    }
    function renderNotifications(rows) {
        const body = document.getElementById('workspacePanelBody');
        body.innerHTML = `<div class="app-panel-actions"><button class="app-btn app-btn-secondary" type="button" id="markAllRead"${rows.some((row) => !row.is_read) ? '' : ' disabled'}>Отметить всё прочитанным</button></div><section class="app-event-list">${rows.length ? rows.map((row) => `<button type="button" class="app-notification-row${row.is_read ? '' : ' is-unread'}" data-notification-id="${Number(row.id)}" data-notification-event="${Number(row.event_id || 0)}"><span><strong>${escapeHtml(row.message)}</strong><small>${formatDate(row.created_at)}</small></span>${row.is_read ? '<span class="app-help">Прочитано</span>' : '<span class="app-status app-status-approved">Новое</span>'}</button>`).join('') : '<section class="app-empty"><h2>Уведомлений нет</h2><p>Новые сообщения появятся здесь.</p></section>'}</section>`;
        document.getElementById('markAllRead')?.addEventListener('click', async () => { await formRequest('/api/notifications/mark-all-read'); openPanel('notifications'); window.loadStats?.(); });
        body.querySelectorAll('[data-notification-id]').forEach((button) => button.addEventListener('click', async () => {
            await formRequest(`/api/notifications/${button.dataset.notificationId}/read`);
            const eventId = Number(button.dataset.notificationEvent || 0);
            if (eventId) { closeDialog('workspacePanel'); params({ panel: null, event: eventId }, { replace: true }); window.openEventModal(eventId, button); }
            else openPanel('notifications');
        }));
    }
    function analyticsMarkup() {
        const types = state.bootstrap?.types || [];
        const teachers = state.bootstrap?.teachers || [];
        return `<section class="app-filter-bar app-panel-filter"><label class="app-field"><span class="app-label">Период</span><select class="app-select" id="analyticsPeriod"><option value="week">Неделя</option><option value="month" selected>Месяц</option><option value="quarter">Квартал</option><option value="year">Год</option><option value="all">Всё время</option></select></label><label class="app-field"><span class="app-label">Тип</span><select class="app-select" id="analyticsType"><option value="all">Все типы</option>${types.map((type) => `<option value="${Number(type.id)}">${escapeHtml(type.name)}</option>`).join('')}</select></label>${teachers.length ? `<label class="app-field"><span class="app-label">Организатор</span><select class="app-select" id="analyticsTeacher"><option value="all">Все организаторы</option>${teachers.map((teacher) => `<option value="${Number(teacher.id)}">${escapeHtml(teacher.name)}</option>`).join('')}</select></label>` : ''}</section><section class="app-stat-grid"><div class="app-stat"><span class="app-stat-label">Всего</span><span class="app-stat-value" id="analyticsTotal">—</span></div><div class="app-stat"><span class="app-stat-label">Утверждено</span><span class="app-stat-value" id="analyticsApproved">—</span></div><div class="app-stat"><span class="app-stat-label">Отклонено</span><span class="app-stat-value" id="analyticsRejected">—</span></div><div class="app-stat"><span class="app-stat-label">Участников</span><span class="app-stat-value" id="analyticsParticipants">—</span></div></section><section class="app-chart-grid app-section-gap"><article class="app-surface app-chart-panel"><h2>Активность педагогов</h2><canvas id="analyticsTeachers"></canvas></article><article class="app-surface app-chart-panel"><h2>Активность классов</h2><canvas id="analyticsClasses"></canvas></article><article class="app-surface app-chart-panel"><h2>Типы мероприятий</h2><canvas id="analyticsTypes"></canvas></article><article class="app-surface app-chart-panel"><h2>Динамика</h2><canvas id="analyticsTimeline"></canvas></article></section><section class="app-chart-grid app-section-gap"><article class="app-surface app-chart-panel"><h2>Топ учеников</h2><div id="analyticsStudents"></div></article><article class="app-surface app-chart-panel"><h2>Топ ответственных</h2><div id="analyticsResponsible"></div></article><article class="app-surface app-chart-panel"><h2>Топ организаторов</h2><div id="analyticsOrganizers"></div></article></section>`;
    }
    function drawChart(id, type, labels, datasets) {
        if (!window.Chart) return;
        state.charts[id]?.destroy();
        const canvas = document.getElementById(id); if (!canvas) return;
        state.charts[id] = new Chart(canvas.getContext('2d'), { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'top' } }, scales: type === 'doughnut' ? {} : { y: { beginAtZero: true } } } });
    }
    function table(rows, columns) {
        if (!rows?.length) return '<p class="app-help">Нет данных за выбранный период.</p>';
        return `<div class="app-table-wrap"><table class="app-table"><thead><tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr>${columns.map((column) => `<td>${escapeHtml(column.value(row, index))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    async function loadAnalytics() {
        const period = document.getElementById('analyticsPeriod')?.value || 'month';
        const type = document.getElementById('analyticsType')?.value || 'all';
        const teacher = document.getElementById('analyticsTeacher')?.value || 'all';
        try {
            const data = await request(`/api/analytics?${new URLSearchParams({ period, type, teacher })}`);
            document.getElementById('analyticsTotal').textContent = data.totals.total_events || 0;
            document.getElementById('analyticsApproved').textContent = data.totals.approved_count || 0;
            document.getElementById('analyticsRejected').textContent = data.totals.rejected_count || 0;
            document.getElementById('analyticsParticipants').textContent = data.totals.total_participants || 0;
            drawChart('analyticsTeachers', 'bar', data.teachers.map((item) => item.name), [{ label: 'Создано', data: data.teachers.map((item) => item.created_events), backgroundColor: '#155eef' }, { label: 'Участий', data: data.teachers.map((item) => item.participations), backgroundColor: '#f79009' }]);
            drawChart('analyticsClasses', 'bar', data.classes.map((item) => item.name), [{ label: 'Мероприятий', data: data.classes.map((item) => item.events_count), backgroundColor: '#0f766e' }, { label: 'Участников', data: data.classes.map((item) => item.participants_count), backgroundColor: '#5640b4' }]);
            drawChart('analyticsTypes', 'doughnut', data.event_types.map((item) => item.type_name), [{ data: data.event_types.map((item) => item.count), backgroundColor: ['#155eef', '#0f766e', '#f79009', '#b4232d', '#5640b4', '#475467'] }]);
            drawChart('analyticsTimeline', 'line', data.timeline.map((item) => item.date), [{ label: 'Мероприятий', data: data.timeline.map((item) => item.count), borderColor: '#155eef', backgroundColor: 'rgba(21,94,239,.14)', fill: true, tension: .1 }]);
            document.getElementById('analyticsStudents').innerHTML = table(data.students, [{ label: '#', value: (_, index) => index + 1 }, { label: 'Ученик', value: (row) => row.name }, { label: 'Класс', value: (row) => row.class_name || '—' }, { label: 'Участий', value: (row) => row.participations }]);
            document.getElementById('analyticsResponsible').innerHTML = table(data.responsible, [{ label: '#', value: (_, index) => index + 1 }, { label: 'Ответственный', value: (row) => row.name }, { label: 'Мероприятий', value: (row) => row.responsible_count }]);
            document.getElementById('analyticsOrganizers').innerHTML = table(data.organizers, [{ label: '#', value: (_, index) => index + 1 }, { label: 'Организатор', value: (row) => row.name }, { label: 'Создано', value: (row) => row.created_events }]);
        } catch (error) { notify(error.message || 'Не удалось загрузить аналитику.', 'danger'); }
    }
    function settingsMarkup(data) {
        const list = (title, rows) => `<article class="app-surface app-surface-pad"><h3 class="app-section-title">${title} <span class="app-type">${rows.length}</span></h3>${rows.length ? `<div class="app-table-wrap"><table class="app-table"><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>ID ${Number(row.id)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="app-help">Нет данных.</p>'}</article>`;
        return `<p class="app-page-summary">Справочники доступны для просмотра; управление учётными записями остаётся в SSO.</p><section class="app-stack app-section-gap">${list('Классы', data.classes)}${list('Кафедры', data.departments)}${list('Предметы', data.subjects)}${list('Типы мероприятий', data.event_types)}</section>`;
    }
    function importMarkup() {
        return `<p class="app-page-summary">Снимок вкладки «26-27» проверяется до записи; все созданные карточки попадут на модерацию.</p><section class="app-form-section app-section-gap"><label class="app-field"><span class="app-label">CSV-снимок вкладки «26-27»</span><input class="app-input" id="yearPlanCsv" type="file" accept=".csv,text/csv"><span class="app-help">Имя файла должно содержать «26-27».</span></label><div class="app-actions-row"><button class="app-btn app-btn-primary" type="button" id="previewImport">Проверить снимок</button></div></section><section class="app-surface app-surface-pad app-section-gap" id="importPreview" hidden></section>${titleNormalizationMarkup()}`;
    }
    function titleNormalizationMarkup() {
        return `<section class="app-surface app-surface-pad app-section-gap"><h3 class="app-section-title">Корректировка названий импорта</h3><p class="app-help">Проверяется только уже импортированный снимок «26-27». Будут изменены лишь однозначные орфографические и регистровые правки; автор, аудитории, описания, статусы и согласования сохранятся.</p><div class="app-actions-row"><button class="app-btn app-btn-secondary" type="button" id="previewTitleNormalization">Проверить названия</button></div><div class="app-section-gap" id="titleNormalizationPreview" hidden></div></section>`;
    }
    function titleNormalizationList(items, render) {
        if (!items.length) return '<p class="app-help">Нет записей.</p>';
        return `<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Дата</th><th>Было</th><th>Станет</th></tr></thead><tbody>${items.map(render).join('')}</tbody></table></div>`;
    }
    function initTitleNormalization() {
        const trigger = document.getElementById('previewTitleNormalization');
        const preview = document.getElementById('titleNormalizationPreview');
        trigger?.addEventListener('click', async () => {
            trigger.disabled = true;
            trigger.textContent = 'Проверяем…';
            try {
                const data = await formRequest('/api/events/import/year-plan/title-normalization/preview', {});
                preview.hidden = false;
                if (data.alreadyApplied) {
                    preview.innerHTML = '<div class="app-alert app-alert-success">Однозначные правки уже применены. Повторно ничего не изменено.</div>';
                    return;
                }
                const corrections = titleNormalizationList(data.corrections, (item) => `<tr><td>${escapeHtml(item.date.split('-').reverse().join('.'))}</td><td>${escapeHtml(item.from)}</td><td>${escapeHtml(item.to)}</td></tr>`);
                const review = data.editorialReview.length
                    ? `<h4 class="app-section-title app-section-gap">Нужна редакторская проверка · ${Number(data.editorialReview.length)}</h4><div class="app-table-wrap"><table class="app-table"><thead><tr><th>Дата</th><th>Название</th><th>Почему не меняем автоматически</th></tr></thead><tbody>${data.editorialReview.map((item) => `<tr><td>${escapeHtml(item.date.split('-').reverse().join('.'))}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table></div>`
                    : '';
                preview.innerHTML = `<h4 class="app-section-title">Однозначные исправления · ${Number(data.summary.corrections)}</h4><p class="app-help">Источник: ${escapeHtml(data.summary.source)}; SHA-256: ${escapeHtml(data.summary.sha256)}. Все ${Number(data.summary.importedEvents)} карточек по-прежнему имеют статус «${escapeHtml(data.summary.status)}».</p>${corrections}${review}<p class="app-alert app-alert-warning app-section-gap">Подтверждение применит только строки из таблицы выше одной транзакцией. Если хотя бы одна карточка изменилась после предпросмотра, весь пакет будет отменён.</p><div class="app-actions-row"><button class="app-btn app-btn-warning" type="button" id="commitTitleNormalization">Применить ${Number(data.summary.corrections)} правок</button></div>`;
                document.getElementById('commitTitleNormalization')?.addEventListener('click', async () => {
                    if (!window.confirm(`Применить ${Number(data.summary.corrections)} проверенных правок названий? Статусы и согласования останутся без изменений.`)) return;
                    const button = document.getElementById('commitTitleNormalization');
                    button.disabled = true;
                    button.textContent = 'Применяем…';
                    try {
                        const result = await formRequest('/api/events/import/year-plan/title-normalization/commit', {
                            expiresAt: data.preview.expiresAt,
                            signature: data.preview.signature
                        });
                        const manifest = URL.createObjectURL(new Blob([JSON.stringify(result.manifest, null, 2)], { type: 'application/json' }));
                        preview.innerHTML = `<div class="app-alert app-alert-success">Исправлено названий: ${Number(result.summary.corrections)}. Статус «${escapeHtml(result.summary.status)}» и согласования сохранены.</div><a class="app-btn app-btn-secondary" href="${manifest}" download="calendar-title-normalization-manifest.json">Скачать реестр правок</a>`;
                        afterMutation('Названия импортированных мероприятий исправлены.', { scope: 'mine' });
                    } catch (error) {
                        button.disabled = false;
                        button.textContent = `Применить ${Number(data.summary.corrections)} правок`;
                        notify(error.message || 'Не удалось применить правки.', 'danger');
                    }
                });
            } catch (error) {
                preview.hidden = false;
                preview.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось проверить названия.')}</div>`;
            } finally {
                trigger.disabled = false;
                trigger.textContent = 'Проверить названия';
            }
        });
    }
    function initImport() {
        const input = document.getElementById('yearPlanCsv'); const preview = document.getElementById('importPreview'); let current = null;
        document.getElementById('previewImport')?.addEventListener('click', async () => {
            const file = input.files?.[0]; if (!file) return input.focus();
            try {
                const csv = await file.text();
                const data = await formRequest('/api/events/import/year-plan/preview', { csv, fileName: file.name });
                current = { csv, fileName: file.name, preview: data.preview };
                const sourceCopy = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
                preview.hidden = false;
                preview.innerHTML = `<h3 class="app-section-title">Предпросмотр</h3><p class="app-help">${escapeHtml(data.snapshot.source)} · SHA-256: ${escapeHtml(data.snapshot.sha256)}</p><ul>${Object.entries(data.summary).map(([key, value]) => `<li>${escapeHtml(key)}: ${escapeHtml(value)}</li>`).join('')}</ul><p class="app-alert app-alert-warning">После подтверждения записи будут созданы и отправлены на модерацию.</p><div class="app-actions-row"><a class="app-btn app-btn-secondary" href="${sourceCopy}" download="${escapeHtml(file.name.replace(/\.csv$/i, ''))}-source-copy.csv">Скачать копию CSV</a><button class="app-btn app-btn-warning" type="button" id="commitImport">Создать мероприятия</button></div>`;
                document.getElementById('commitImport')?.addEventListener('click', async () => {
                    if (!window.confirm('Создать все проверенные мероприятия?')) return;
                    const result = await formRequest('/api/events/import/year-plan/commit', { ...current, expiresAt: current.preview.expiresAt, signature: current.preview.signature });
                    const manifest = URL.createObjectURL(new Blob([JSON.stringify(result.manifest, null, 2)], { type: 'application/json' }));
                    preview.innerHTML = `<h3 class="app-section-title">Импорт завершён</h3><p>Создано мероприятий: ${Number(result.summary.events)}.</p><a class="app-btn app-btn-secondary" href="${manifest}" download="calendar-import-manifest.json">Скачать реестр</a>`;
                    afterMutation('Импорт завершён: мероприятия отправлены на модерацию.', { scope: 'moderation' });
                });
            } catch (error) { preview.hidden = false; preview.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось проверить снимок.')}</div>`; }
        });
        initTitleNormalization();
    }
    async function openPanel(panel, opener = document.activeElement) {
        const title = { notifications: 'Уведомления', analytics: 'Аналитика', settings: 'Справочники календаря', import: 'Импорт годового графика' }[panel];
        if (!title) return;
        const body = document.getElementById('workspacePanelBody');
        document.getElementById('workspacePanelLabel').textContent = title;
        body.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка…</div></div>';
        openDialog('workspacePanel', opener);
        params({ panel, compose: null, event: null }, { replace: true });
        try {
            if (panel === 'notifications') renderNotifications(await request('/api/notifications'));
            if (panel === 'analytics') { body.innerHTML = analyticsMarkup(); body.querySelectorAll('select').forEach((select) => select.addEventListener('change', loadAnalytics)); loadAnalytics(); }
            if (panel === 'settings') body.innerHTML = settingsMarkup(await request('/api/workspace/settings'));
            if (panel === 'import') { body.innerHTML = importMarkup(); initImport(); }
        } catch (error) { body.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить раздел.')}</div>`; }
    }
    async function runCommand(button) {
        const command = button.dataset.workspaceCommand;
        const eventId = Number(button.dataset.eventId);
        if (!eventId) return;
        if (command === 'edit' || command === 'copy') { closeDialog('eventModal'); return openComposer(command, eventId, button); }
        if (command === 'reject' || command === 'cancel' || command === 'delete') return window.openReasonModal(eventId, command);
        if (command === 'review') {
            const event = await request(`/api/events/${eventId}`); return window.openReviewModal(eventId, event.review_text || '');
        }
        if (command === 'approve') {
            try { const result = await formRequest(`/events/admin-approve/${eventId}`); closeDialog('eventModal'); afterMutation(result.scope === 'moderation' ? 'Ваше подтверждение сохранено. Ожидаются остальные администраторы.' : 'Мероприятие опубликовано.', { eventId, scope: result.scope }); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'resend') {
            try { await formRequest(`/events/resend/${eventId}`); closeDialog('eventModal'); afterMutation('Мероприятие снова отправлено на согласование.', { eventId, scope: 'mine' }); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'complete') {
            if (!window.confirm('Подтвердить завершение мероприятия?')) return;
            try { await formRequest(`/api/events/${eventId}/complete`); closeDialog('eventModal'); afterMutation('Мероприятие перенесено в историю.', { eventId, scope: 'archive' }); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'register' || command === 'unregister') {
            const childId = Number(button.dataset.childId || document.getElementById('registrationChild')?.value || 0);
            try {
                await formRequest(`/api/events/${eventId}/${command === 'register' ? 'register' : 'unregister'}`, childId ? { child_id: childId } : {});
                const event = await request(`/api/events/${eventId}`); window.calendarUI?.renderEvent(event); window.calendar?.refetchEvents(); window.loadStats?.(); notify(command === 'register' ? 'Запись сохранена.' : 'Запись отменена.');
            } catch (error) { notify(error.message || 'Не удалось изменить запись.', 'danger'); }
        }
    }
    document.addEventListener('DOMContentLoaded', async () => {
        state.scope = window.workspaceInitialState?.scope || 'all';
        state.bootstrap = await window.loadStats?.();
        setScope(state.scope, { updateURL: false });
        document.querySelectorAll('[data-workspace-scope]').forEach((button) => button.addEventListener('click', () => setScope(button.dataset.workspaceScope)));
        document.addEventListener('click', (event) => {
            const command = event.target.closest('[data-workspace-command]');
            if (command) { event.preventDefault(); runCommand(command); }
        });
        const initial = window.workspaceInitialState || {};
        if (initial.compose) openComposer(initial.compose, initial.event || null);
        else if (initial.panel) openPanel(initial.panel);
        else if (initial.event) window.openEventModal?.(initial.event);
        dialog('workspacePanel')?.addEventListener('close', () => params({ panel: null }, { replace: true }));
        dialog('eventComposer')?.addEventListener('close', () => params({ compose: null, event: null }, { replace: true }));
    });
    window.workspace = { state, setScope, openPanel, openComposer, notify, afterMutation };
    window.openEventComposer = openComposer;
})();
