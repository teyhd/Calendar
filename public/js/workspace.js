(() => {
    const VIEWS = {
        calendar: ['Календарь мероприятий', 'Планируйте неделю и быстро находите нужное событие.'],
        mine: ['Мои мероприятия', 'Созданные вами события и записи, требующие внимания.'],
        children: ['События детей', 'Расписание, события и записи ваших детей.'],
        moderation: ['Модерация', 'Заявки ждут решения всех назначенных администраторов.'],
        history: ['История мероприятий', 'Завершённые, отменённые и отклонённые события.'],
        reviews: ['Отзывы', 'Итоги завершённых мероприятий от организаторов.'],
        analytics: ['Аналитика', 'Динамика активности и участия в мероприятиях.'],
        import: ['Импорт годового графика', 'Проверьте CSV-снимок перед созданием заявок на модерацию.'],
        settings: ['Настройки календаря', 'Справочники календаря и доступные значения.'],
        notifications: ['Уведомления', 'Все решения, напоминания и изменения по вашим событиям.']
    };
    const LEGACY_VIEWS = { all: 'calendar', archive: 'history' };
    const state = {
        bootstrap: null,
        formOptions: null,
        view: 'calendar',
        filters: { search: '', status: 'all', type: 'all', from: '', to: '', sort: 'start_asc' },
        charts: {},
        calendar: null,
        selectedModerationEvent: null
    };

    const escapeHtml = (value) => window.calendarUI?.escapeHtml?.(value) || String(value ?? '');
    const formatDate = (value) => window.calendarUI?.formatDate?.(value) || String(value || '');
    const request = (url, options = {}) => window.appUI?.request(url, options);
    const formRequest = (url, payload = {}) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const dialog = (id) => document.getElementById(id);
    const openDialog = (id, opener) => window.appUI?.openDialog(id, opener);
    const closeDialog = (id) => window.appUI?.closeDialog(id);
    const root = () => document.getElementById('workspaceRoot');
    const content = () => document.getElementById('workspaceContent');
    const can = (permission) => Boolean(state.bootstrap?.user?.permissions?.[permission]);
    const draftKey = () => `calendar:composer:${Number(state.bootstrap?.user?.id || 0)}`;

    function notify(message, tone = 'success') {
        const region = document.getElementById('toastRegion');
        if (!region) return;
        const toast = document.createElement('div');
        toast.className = `app-toast app-toast-${tone}`;
        toast.textContent = message;
        region.append(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    function urlState() {
        const url = new URL(window.location.href);
        const legacy = url.searchParams.get('scope') || url.searchParams.get('panel');
        const rawView = url.searchParams.get('view') || LEGACY_VIEWS[legacy] || legacy || state.bootstrap?.default_view || 'calendar';
        const allowed = rawView === 'calendar' || state.bootstrap?.navigation?.some((item) => item.view === rawView);
        const view = allowed && VIEWS[rawView] ? rawView : 'calendar';
        return {
            view: VIEWS[view] ? view : 'calendar',
            event: url.searchParams.get('event'),
            compose: url.searchParams.get('compose'),
            filters: {
                search: url.searchParams.get('search') || '',
                status: url.searchParams.get('status') || 'all',
                type: url.searchParams.get('type') || 'all',
                from: url.searchParams.get('from') || '',
                to: url.searchParams.get('to') || '',
                sort: url.searchParams.get('sort') || 'start_asc'
            }
        };
    }

    function setURL(next = {}, { replace = false } = {}) {
        const url = new URL(window.location.href);
        Object.entries(next).forEach(([key, value]) => {
            if (value == null || value === '' || value === 'all' || (key === 'view' && value === 'calendar')) url.searchParams.delete(key);
            else url.searchParams.set(key, String(value));
        });
        url.searchParams.delete('scope');
        url.searchParams.delete('panel');
        window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}`);
    }

    function updateNavigation() {
        document.querySelectorAll('[data-workspace-view]').forEach((link) => {
            const active = link.dataset.workspaceView === state.view;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        });
    }

    function renderHeader() {
        const [title, summary] = VIEWS[state.view] || VIEWS.calendar;
        const titleNode = document.getElementById('workspaceTitle');
        const summaryNode = document.getElementById('workspaceSummary');
        if (titleNode) titleNode.textContent = title;
        if (summaryNode) summaryNode.textContent = summary;
        const actions = document.getElementById('workspaceActions');
        if (!actions) return;
        const create = can('create_event') ? '<button class="app-btn app-btn-primary" type="button" data-compose="create">Создать мероприятие</button>' : '';
        const contextual = state.view === 'notifications' && state.bootstrap?.unread_count
            ? '<button class="app-btn app-btn-secondary" type="button" data-mark-notifications>Прочитать всё</button>'
            : '';
        actions.innerHTML = `${contextual}${create}`;
    }

    function renderOverview() {
        const overview = document.getElementById('workspaceOverview');
        if (!overview || !state.bootstrap) return;
        const counts = state.bootstrap.counts || {};
        const pending = Number(counts.pending || 0);
        if (['analytics', 'settings', 'import', 'notifications'].includes(state.view)) { overview.innerHTML = ''; return; }
        const cards = state.view === 'moderation'
            ? [['Ожидают решения', pending], ['Опубликовано', counts.approved || 0], ['В истории', counts.archive || 0]]
            : [['Доступно', counts.all || 0], ['Опубликовано', counts.approved || 0], ['На модерации', pending], ['В истории', counts.archive || 0]];
        overview.innerHTML = `<div class="app-stat-grid">${cards.map(([label, value]) => `<div class="app-stat"><span class="app-stat-label">${label}</span><span class="app-stat-value">${Number(value)}</span></div>`).join('')}</div>`;
    }

    function filterMarkup() {
        const types = state.bootstrap?.types || [];
        return `<section class="app-filter-bar" aria-label="Фильтры событий">
            <label class="app-field"><span class="app-label">Поиск</span><input class="app-input" type="search" data-filter="search" value="${escapeHtml(state.filters.search)}" placeholder="Название, место или организатор"></label>
            <label class="app-field"><span class="app-label">Статус</span><select class="app-select" data-filter="status"><option value="all">Все статусы</option><option value="APPROVED">Опубликованные</option><option value="WAITING_ADMIN">На модерации</option><option value="REJECTED">Отклонённые</option><option value="CANCELED">Отменённые</option><option value="COMPLETED">Завершённые</option></select></label>
            <label class="app-field"><span class="app-label">Тип</span><select class="app-select" data-filter="type"><option value="all">Все типы</option>${types.map((type) => `<option value="${Number(type.id)}">${escapeHtml(type.name)}</option>`).join('')}</select></label>
            <label class="app-field"><span class="app-label">Порядок</span><select class="app-select" data-filter="sort"><option value="start_asc">Сначала ближайшие</option><option value="start_desc">Сначала поздние</option><option value="title">По названию</option></select></label>
            <button class="app-btn app-btn-secondary" type="button" data-reset-filters>Сбросить</button>
        </section>`;
    }

    function selectFilters(container) {
        ['status', 'type', 'sort'].forEach((key) => {
            const field = container.querySelector(`[data-filter="${key}"]`);
            if (field) field.value = state.filters[key] || 'all';
        });
    }

    function statusClass(status) { return String(status || 'DRAFT').toLowerCase().replace('_admin', ''); }
    function statusText(status) { return window.calendarUI?.status?.[status]?.text || 'Черновик'; }
    function eventRow(event, { selected = false } = {}) {
        const child = event.child_name ? `<span class="app-row-meta">${escapeHtml(event.child_name)}</span>` : '';
        return `<button type="button" class="app-event-row${selected ? ' is-selected' : ''}" data-open-event="${Number(event.id)}">
            <span class="app-status-dot app-status-dot-${statusClass(event.status)}" aria-hidden="true"></span>
            <span class="app-event-row-main"><strong>${escapeHtml(event.title)}</strong><span>${formatDate(event.start_datetime)}${event.location ? ` · ${escapeHtml(event.location)}` : ''}</span></span>
            <span class="app-event-row-side"><span class="app-status app-status-${statusClass(event.status)}">${statusText(event.status)}</span>${child}</span>
        </button>`;
    }

    function calendarApprovalQueueMarkup(data) {
        const items = data.items || [];
        const total = Number(data.total || 0);
        if (!items.length) return '';
        const rows = items.map((event) => `<article class="calendar-approval-item">
            <button class="calendar-approval-open" type="button" data-open-event="${Number(event.id)}">
                <span><strong>${escapeHtml(event.title)}</strong><small>${formatDate(event.start_datetime)}${event.creator_name ? ` · ${escapeHtml(event.creator_name)}` : ''}</small></span>
                <span class="app-status app-status-waiting">На модерации</span>
            </button>
            <button class="app-btn app-btn-primary" type="button" data-workspace-command="approve" data-event-id="${Number(event.id)}" aria-label="Утвердить: ${escapeHtml(event.title)}">Утвердить</button>
        </article>`).join('');
        const more = total > items.length
            ? `<a class="app-btn app-btn-secondary" href="/?view=moderation" data-workspace-view="moderation">Вся очередь · ${total}</a>`
            : '';
        return `<div class="calendar-approval-head"><div><p class="app-page-kicker">Быстрое решение</p><h2>Ожидают вашего подтверждения</h2><p>Все статусы видны в календаре. Утверждение учитывается вместе с решениями остальных администраторов.</p></div><span class="app-nav-count">${total}</span></div><div class="calendar-approval-list">${rows}</div>${more ? `<div class="calendar-approval-more">${more}</div>` : ''}`;
    }

    async function renderCalendarApprovalQueue() {
        const queue = document.getElementById('calendarApprovalQueue');
        if (!queue || !can('moderate_event')) return;
        try {
            const data = await request('/api/workspace/events?view=calendar&status=WAITING_ADMIN&page=1&page_size=6&sort=start_asc');
            const markup = calendarApprovalQueueMarkup(data);
            queue.hidden = !markup;
            queue.innerHTML = markup;
        } catch (error) {
            queue.hidden = false;
            queue.innerHTML = '<p class="app-help">Не удалось загрузить заявки, ожидающие решения. Обновите страницу или откройте модерацию.</p>';
        }
    }

    function emptyMarkup(title = 'Ничего не найдено', text = 'Попробуйте изменить фильтры или вернитесь позже.') {
        return `<section class="app-empty"><h2>${title}</h2><p>${text}</p></section>`;
    }

    async function fetchEvents({ page = 1, pageSize = 30, view = state.view } = {}) {
        const params = new URLSearchParams({ view, page: String(page), page_size: String(pageSize), ...state.filters });
        return request(`/api/workspace/events?${params}`);
    }

    async function renderCalendar() {
        const area = content();
        area.innerHTML = `${filterMarkup()}<section class="calendar-approval-queue app-surface" id="calendarApprovalQueue" aria-live="polite" hidden></section><section class="calendar-workspace"><div class="calendar-workspace-grid"><div class="app-surface app-surface-pad"><div id="calendar"></div></div><aside class="app-surface app-agenda" aria-label="Ближайшие события"><div class="app-section-head"><h2>Ближайшее</h2><span id="agendaCount" class="app-help"></span></div><div id="agendaList" class="app-event-list"><div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка…</div></div></div></aside></div></section>`;
        selectFilters(area);
        const onEvents = (items) => {
            const agenda = document.getElementById('agendaList');
            const count = document.getElementById('agendaCount');
            if (count) count.textContent = items.length ? `${items.length} в периоде` : '';
            if (agenda) agenda.innerHTML = items.length ? items.slice(0, 8).map((event) => eventRow(event)).join('') : emptyMarkup('Событий пока нет');
        };
        state.calendar?.destroy();
        state.calendar = window.calendarUI?.mountCalendar(document.getElementById('calendar'), { view: state.view, filters: state.filters, onEvents }) || null;
        window.calendar = state.calendar;
        await renderCalendarApprovalQueue();
    }

    async function renderList() {
        const area = content();
        area.innerHTML = `${filterMarkup()}<section class="app-surface app-list-surface" id="eventList"><div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка событий…</div></div></section>`;
        selectFilters(area);
        try {
            const data = await fetchEvents();
            const list = document.getElementById('eventList');
            if (!list) return;
            list.innerHTML = data.items.length ? `<div class="app-list-head"><span>${data.total} ${data.total === 1 ? 'событие' : 'событий'}</span></div><div class="app-event-list">${data.items.map((event) => eventRow(event)).join('')}</div>` : emptyMarkup();
        } catch (error) { area.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить события.')}</div>`; }
    }

    async function renderModeration() {
        const area = content();
        area.innerHTML = `${filterMarkup()}<section class="moderation-workspace"><div class="app-surface moderation-queue" id="moderationQueue"><div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка заявок…</div></div></div><aside class="app-surface moderation-detail" id="moderationDetail"><div class="moderation-placeholder"><h2>Выберите заявку</h2><p>Детали и действия появятся здесь без перехода на отдельную страницу.</p></div></aside></section>`;
        selectFilters(area);
        try {
            const data = await fetchEvents({ view: 'moderation' });
            const queue = document.getElementById('moderationQueue');
            if (!queue) return;
            queue.innerHTML = data.items.length ? `<div class="app-section-head"><h2>Очередь</h2><span>${data.total}</span></div><div class="app-event-list">${data.items.map((event) => eventRow(event, { selected: Number(event.id) === state.selectedModerationEvent })).join('')}</div>` : emptyMarkup('Заявок нет', 'Все доступные заявки обработаны.');
            if (data.items.length && !state.selectedModerationEvent && !window.matchMedia('(max-width: 760px)').matches) selectModeration(data.items[0].id);
        } catch (error) { area.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить очередь.')}</div>`; }
    }

    async function selectModeration(eventId) {
        state.selectedModerationEvent = Number(eventId);
        const detail = document.getElementById('moderationDetail');
        if (!detail) return window.openEventModal?.(eventId);
        detail.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка заявки…</div></div>';
        try {
            const event = await request(`/api/events/${encodeURIComponent(eventId)}`);
            detail.innerHTML = `<div class="moderation-detail-head"><div><button class="app-btn app-btn-quiet moderation-back" type="button" data-close-moderation>К очереди</button><span class="app-status app-status-${statusClass(event.status)}">${statusText(event.status)}</span><h2>${escapeHtml(event.title)}</h2></div><button class="app-btn app-btn-secondary" type="button" data-open-event="${Number(event.id)}">Открыть</button></div><dl class="app-detail-list"><div><dt>Когда</dt><dd>${formatDate(event.start_datetime)}</dd></div><div><dt>Организатор</dt><dd>${escapeHtml(event.creator_name || 'Неизвестен')}</dd></div><div><dt>Аудитория</dt><dd>${escapeHtml(event.audience_name || 'Не указана')}</dd></div>${event.description ? `<div><dt>Описание</dt><dd>${escapeHtml(event.description)}</dd></div>` : ''}</dl><div class="app-actions-row moderation-actions"><button class="app-btn app-btn-primary" type="button" data-workspace-command="approve" data-event-id="${Number(event.id)}">Подтвердить</button><button class="app-btn app-btn-danger" type="button" data-workspace-command="reject" data-event-id="${Number(event.id)}">Отклонить</button></div>`;
            document.querySelectorAll('#moderationQueue [data-open-event]').forEach((row) => row.classList.toggle('is-selected', Number(row.dataset.openEvent) === state.selectedModerationEvent));
        } catch (error) { detail.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить заявку.')}</div>`; }
    }

    function analyticsMarkup() {
        const types = state.bootstrap?.types || [];
        const teachers = state.bootstrap?.teachers || [];
        return `<section class="app-filter-bar"><label class="app-field"><span class="app-label">Период</span><select class="app-select" id="analyticsPeriod"><option value="week">Неделя</option><option value="month" selected>Месяц</option><option value="quarter">Квартал</option><option value="year">Год</option><option value="all">Всё время</option></select></label><label class="app-field"><span class="app-label">Тип</span><select class="app-select" id="analyticsType"><option value="all">Все типы</option>${types.map((type) => `<option value="${Number(type.id)}">${escapeHtml(type.name)}</option>`).join('')}</select></label>${teachers.length ? `<label class="app-field"><span class="app-label">Организатор</span><select class="app-select" id="analyticsTeacher"><option value="all">Все организаторы</option>${teachers.map((teacher) => `<option value="${Number(teacher.id)}">${escapeHtml(teacher.name)}</option>`).join('')}</select></label>` : ''}</section><section class="app-stat-grid" id="analyticsStats"><div class="app-stat"><span class="app-stat-label">Всего</span><span class="app-stat-value">—</span></div><div class="app-stat"><span class="app-stat-label">Утверждено</span><span class="app-stat-value">—</span></div><div class="app-stat"><span class="app-stat-label">Участников</span><span class="app-stat-value">—</span></div></section><section class="app-chart-grid"><article class="app-surface app-chart-panel"><h2>Активность педагогов</h2><canvas id="analyticsTeachers"></canvas></article><article class="app-surface app-chart-panel"><h2>Типы мероприятий</h2><canvas id="analyticsTypes"></canvas></article><article class="app-surface app-chart-panel"><h2>Динамика</h2><canvas id="analyticsTimeline"></canvas></article></section><section class="app-surface app-surface-pad"><h2 class="app-section-title">Топ организаторов</h2><div id="analyticsOrganizers"></div></section>`;
    }

    function drawChart(id, type, labels, datasets) {
        if (!window.Chart) return;
        state.charts[id]?.destroy();
        const canvas = document.getElementById(id); if (!canvas) return;
        state.charts[id] = new Chart(canvas.getContext('2d'), { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'top' } }, scales: type === 'doughnut' ? {} : { y: { beginAtZero: true } } } });
    }

    function resultsTable(rows) {
        if (!rows?.length) return '<p class="app-help">Нет данных за выбранный период.</p>';
        return `<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Организатор</th><th>Создано</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${Number(row.created_events || 0)}</td></tr>`).join('')}</tbody></table></div>`;
    }

    async function loadAnalytics() {
        try {
            const query = new URLSearchParams({ period: document.getElementById('analyticsPeriod')?.value || 'month', type: document.getElementById('analyticsType')?.value || 'all', teacher: document.getElementById('analyticsTeacher')?.value || 'all' });
            const data = await request(`/api/analytics?${query}`);
            document.getElementById('analyticsStats').innerHTML = [['Всего', data.totals.total_events], ['Утверждено', data.totals.approved_count], ['Участников', data.totals.total_participants]].map(([label, value]) => `<div class="app-stat"><span class="app-stat-label">${label}</span><span class="app-stat-value">${Number(value || 0)}</span></div>`).join('');
            drawChart('analyticsTeachers', 'bar', data.teachers.map((item) => item.name), [{ label: 'Создано', data: data.teachers.map((item) => item.created_events), backgroundColor: '#155eef' }]);
            drawChart('analyticsTypes', 'doughnut', data.event_types.map((item) => item.type_name), [{ data: data.event_types.map((item) => item.count), backgroundColor: ['#155eef', '#12b76a', '#f79009', '#d92d20', '#7f56d9', '#475467'] }]);
            drawChart('analyticsTimeline', 'line', data.timeline.map((item) => item.date), [{ label: 'Мероприятий', data: data.timeline.map((item) => item.count), borderColor: '#155eef', backgroundColor: 'rgba(21,94,239,.12)', fill: true, tension: .2 }]);
            document.getElementById('analyticsOrganizers').innerHTML = resultsTable(data.organizers);
        } catch (error) { notify(error.message || 'Не удалось загрузить аналитику.', 'danger'); }
    }

    function settingsMarkup(data) {
        const rows = (title, values) => `<article class="app-surface app-surface-pad"><h2 class="app-section-title">${title}</h2>${values.length ? `<div class="app-table-wrap"><table class="app-table"><tbody>${values.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>ID ${Number(item.id)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="app-help">Нет данных.</p>'}</article>`;
        return `<section class="settings-list"><p class="app-page-summary">Учётные записи и роли управляются в SSO; здесь доступны только справочники календаря.</p>${rows('Классы', data.classes)}${rows('Кафедры', data.departments)}${rows('Предметы', data.subjects)}${rows('Типы мероприятий', data.event_types)}</section>`;
    }

    function importMarkup() {
        return `<section class="app-surface app-surface-pad import-workspace"><p>Снимок вкладки «26-27» проверяется до записи: созданные карточки попадут на модерацию.</p><label class="app-field"><span class="app-label">CSV-снимок</span><input class="app-input" id="yearPlanCsv" type="file" accept=".csv,text/csv"><span class="app-help">Имя файла должно содержать «26-27».</span></label><button class="app-btn app-btn-primary" type="button" id="previewImport">Проверить снимок</button><section id="importPreview" class="app-section-gap" hidden></section>${titleNormalizationMarkup()}</section>`;
    }
    function titleNormalizationMarkup() {
        return `<section class="app-surface app-surface-pad app-section-gap"><h2 class="app-section-title">Корректировка названий импорта</h2><p class="app-help">Проверяются только однозначные орфографические и регистровые правки; статусы, согласования и аудитории сохраняются.</p><button class="app-btn app-btn-secondary" type="button" id="previewTitleNormalization">Проверить названия</button><div class="app-section-gap" id="titleNormalizationPreview" hidden></div></section>`;
    }
    function initTitleNormalization() {
        const trigger = document.getElementById('previewTitleNormalization');
        const preview = document.getElementById('titleNormalizationPreview');
        trigger?.addEventListener('click', async () => {
            trigger.disabled = true; trigger.textContent = 'Проверяем…';
            try {
                const data = await formRequest('/api/events/import/year-plan/title-normalization/preview', {});
                preview.hidden = false;
                if (data.alreadyApplied) { preview.innerHTML = '<div class="app-alert app-alert-success">Однозначные правки уже применены. Повторно ничего не изменено.</div>'; return; }
                const corrections = data.corrections?.length ? `<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Дата</th><th>Было</th><th>Станет</th></tr></thead><tbody>${data.corrections.map((item) => `<tr><td>${escapeHtml(item.date.split('-').reverse().join('.'))}</td><td>${escapeHtml(item.from)}</td><td>${escapeHtml(item.to)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="app-help">Нет однозначных исправлений.</p>';
                const review = data.editorialReview?.length ? `<h3 class="app-section-title app-section-gap">Нужна редакторская проверка</h3><div class="app-table-wrap"><table class="app-table"><tbody>${data.editorialReview.map((item) => `<tr><td>${escapeHtml(item.date.split('-').reverse().join('.'))}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table></div>` : '';
                preview.innerHTML = `<h3 class="app-section-title">Однозначные исправления · ${Number(data.summary.corrections)}</h3><p class="app-help">Источник: ${escapeHtml(data.summary.source)}; SHA-256: ${escapeHtml(data.summary.sha256)}.</p>${corrections}${review}<p class="app-alert app-alert-warning app-section-gap">Подтверждение применит только показанные правки одной транзакцией.</p><button class="app-btn app-btn-warning" type="button" id="commitTitleNormalization">Применить ${Number(data.summary.corrections)} правок</button>`;
                document.getElementById('commitTitleNormalization')?.addEventListener('click', async () => {
                    if (!window.confirm(`Применить ${Number(data.summary.corrections)} проверенных правок названий?`)) return;
                    const button = document.getElementById('commitTitleNormalization'); button.disabled = true; button.textContent = 'Применяем…';
                    try {
                        const result = await formRequest('/api/events/import/year-plan/title-normalization/commit', { expiresAt: data.preview.expiresAt, signature: data.preview.signature });
                        preview.innerHTML = `<div class="app-alert app-alert-success">Исправлено названий: ${Number(result.summary.corrections)}. Статусы и согласования сохранены.</div>`;
                        await refreshBootstrap(); await renderCurrent(); notify('Названия импортированных мероприятий исправлены.');
                    } catch (error) { button.disabled = false; button.textContent = `Применить ${Number(data.summary.corrections)} правок`; notify(error.message || 'Не удалось применить правки.', 'danger'); }
                });
            } catch (error) { preview.hidden = false; preview.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось проверить названия.')}</div>`; }
            finally { trigger.disabled = false; trigger.textContent = 'Проверить названия'; }
        });
    }

    function initImport() {
        let candidate = null;
        document.getElementById('previewImport')?.addEventListener('click', async () => {
            const file = document.getElementById('yearPlanCsv')?.files?.[0];
            if (!file) return document.getElementById('yearPlanCsv')?.focus();
            const preview = document.getElementById('importPreview');
            try {
                const csv = await file.text();
                const data = await formRequest('/api/events/import/year-plan/preview', { csv, fileName: file.name });
                candidate = { csv, fileName: file.name, preview: data.preview };
                preview.hidden = false;
                preview.innerHTML = `<h2 class="app-section-title">Предпросмотр</h2><p class="app-help">${escapeHtml(data.snapshot.source)} · SHA-256: ${escapeHtml(data.snapshot.sha256)}</p><ul class="app-summary-list">${Object.entries(data.summary).map(([key, value]) => `<li>${escapeHtml(key)}: <strong>${escapeHtml(value)}</strong></li>`).join('')}</ul><p class="app-alert app-alert-warning">После подтверждения заявки будут созданы и отправлены на модерацию.</p><button class="app-btn app-btn-warning" type="button" id="commitImport">Создать мероприятия</button>`;
                document.getElementById('commitImport')?.addEventListener('click', async () => {
                    if (!window.confirm('Создать все проверенные мероприятия?')) return;
                    const result = await formRequest('/api/events/import/year-plan/commit', candidate);
                    preview.innerHTML = `<h2 class="app-section-title">Импорт завершён</h2><p>Создано мероприятий: ${Number(result.summary.events || 0)}.</p>`;
                    await refreshBootstrap();
                    notify('Импорт завершён: заявки отправлены на модерацию.');
                });
            } catch (error) { preview.hidden = false; preview.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось проверить снимок.')}</div>`; }
        });
        initTitleNormalization();
    }

    async function renderNotifications() {
        const area = content();
        area.innerHTML = '<section class="app-surface app-list-surface"><div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка уведомлений…</div></div></section>';
        try {
            const rows = await request('/api/notifications');
            area.innerHTML = `<section class="app-surface app-list-surface"><div class="app-list-head"><span>${rows.length} уведомлений</span>${rows.some((row) => !row.is_read) ? '<button class="app-btn app-btn-secondary" type="button" data-mark-notifications>Прочитать всё</button>' : ''}</div><div class="app-event-list">${rows.length ? rows.map((row) => `<button class="app-notification-row${row.is_read ? '' : ' is-unread'}" type="button" data-notification-id="${Number(row.id)}" data-notification-event="${Number(row.event_id || 0)}"><span><strong>${escapeHtml(row.message)}</strong><small>${formatDate(row.created_at)}</small></span><span>${row.is_read ? 'Прочитано' : 'Новое'}</span></button>`).join('') : emptyMarkup('Уведомлений нет', 'Новые сообщения появятся здесь.')}</div></section>`;
        } catch (error) { area.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить уведомления.')}</div>`; }
    }

    function localDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.valueOf())) return String(value).replace(' ', 'T').slice(0, 16);
        return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    }

    function readDraft() {
        try { return JSON.parse(sessionStorage.getItem(draftKey()) || '{}'); } catch { return {}; }
    }
    function saveDraft(form) {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.responsible_ids = checkedValues('#responsiblePicker input:checked').join(',');
        payload.target_audience_ids = checkedValues('#audiencePicker input:checked').join(',');
        try { sessionStorage.setItem(draftKey(), JSON.stringify(payload)); } catch { /* session storage is optional */ }
    }
    function clearDraft() { try { sessionStorage.removeItem(draftKey()); } catch { /* session storage is optional */ } }
    function checkedValues(selector) { return [...document.querySelectorAll(selector)].map((input) => input.value); }

    function entityPicker(id, label, values, selected = [], { multiple = true, subtitle = () => '' } = {}) {
        const selectedIds = new Set(selected.map(String));
        return `<section class="entity-picker" id="${id}"><span class="app-label">${label}</span><input class="app-input entity-picker-search" type="search" placeholder="Поиск" aria-label="Поиск: ${label}"><div class="entity-picker-list">${values.map((item) => `<label class="entity-picker-option"><input type="${multiple ? 'checkbox' : 'radio'}" name="${id}" value="${Number(item.id)}"${selectedIds.has(String(item.id)) ? ' checked' : ''}><span><strong>${escapeHtml(item.name)}</strong>${subtitle(item) ? `<small>${escapeHtml(subtitle(item))}</small>` : ''}</span></label>`).join('')}</div><div class="entity-picker-chips" aria-live="polite"></div></section>`;
    }

    function syncPicker(picker) {
        if (!picker) return;
        const search = picker.querySelector('.entity-picker-search');
        const update = () => {
            const term = search?.value.trim().toLocaleLowerCase('ru-RU') || '';
            picker.querySelectorAll('.entity-picker-option').forEach((option) => { option.hidden = term && !option.textContent.toLocaleLowerCase('ru-RU').includes(term); });
            const chips = picker.querySelector('.entity-picker-chips');
            const selected = [...picker.querySelectorAll('input:checked')].map((input) => input.closest('label')?.querySelector('strong')?.textContent).filter(Boolean);
            if (chips) chips.innerHTML = selected.map((name) => `<span>${escapeHtml(name)}</span>`).join('');
        };
        picker.addEventListener('input', update); picker.addEventListener('change', update); update();
    }

    function audienceOptions(type, selected = []) {
        const options = state.formOptions || {};
        if (type === 'all') return '<p class="app-help">Событие будет доступно всем пользователям системы.</p>';
        if (type === 'parallel') {
            const parallels = [...new Set((options.classes || []).map((item) => String(item.name || '').match(/^\d+/)?.[0]).filter(Boolean))].sort((a, b) => Number(a) - Number(b)).map((name) => ({ id: name, name: `${name} класс` }));
            return entityPicker('audiencePicker', 'Параллель *', parallels, selected, { multiple: false });
        }
        const mapping = { class: ['Класс *', options.classes, false], multiple_classes: ['Классы *', options.classes, true], department: ['Кафедра *', options.departments, false], specific_users: ['Пользователи *', options.users, true] };
        const [label, values, multiple] = mapping[type] || mapping.class;
        return entityPicker('audiencePicker', label, values || [], selected, { multiple, subtitle: (item) => item.kaf_name || item.role_name || '' });
    }

    function eventFormMarkup(source = {}, mode = 'create') {
        const draft = mode === 'create' ? readDraft() : {};
        const event = { ...draft, ...source };
        const options = state.formOptions || {};
        const types = options.types || [];
        const audienceType = event.target_audience_type || options.defaults?.target_audience_type || 'class';
        const audience = String(event.target_audience_ids || event.target_audience_id || '').split(',').filter(Boolean);
        const responsible = String(event.responsible_ids || options.defaults?.responsible_ids?.join(',') || '').split(',').filter(Boolean);
        const now = new Date(); now.setHours(9, 0, 0, 0);
        const end = new Date(now.valueOf() + 60 * 60 * 1000);
        return `<form class="event-form app-composer-form" id="workspaceEventForm" data-mode="${mode}" data-event-id="${Number(event.id || 0)}">
            <section class="app-form-section"><h3>Основное</h3><label class="app-field"><span class="app-label">Название *</span><input class="app-input" name="title" maxlength="100" required value="${escapeHtml(event.title || '')}" placeholder="Например, олимпиада по математике"></label><div class="app-two-col"><label class="app-field"><span class="app-label">Тип *</span><select class="app-select" name="event_type_id" required><option value="">Выберите тип</option>${types.map((type) => `<option value="${Number(type.id)}"${Number(type.id) === Number(event.event_type_id) ? ' selected' : ''}>${escapeHtml(type.name)}</option>`).join('')}</select></label><label class="app-field"><span class="app-label">Уровень</span><select class="app-select" name="level">${[['school', 'Школьный'], ['city', 'Городской'], ['regional', 'Региональный'], ['national', 'Всероссийский'], ['international', 'Международный']].map(([value, label]) => `<option value="${value}"${(event.level || 'school') === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="app-two-col"><label class="app-field"><span class="app-label">Начало *</span><input class="app-input" type="datetime-local" name="start_datetime" required value="${localDateTime(event.start_datetime) || localDateTime(now)}"></label><label class="app-field"><span class="app-label">Окончание *</span><input class="app-input" type="datetime-local" name="end_datetime" required value="${localDateTime(event.end_datetime) || localDateTime(end)}"></label></div></section>
            <section class="app-form-section"><h3>Для кого</h3><label class="app-field"><span class="app-label">Аудитория *</span><select class="app-select" name="target_audience_type" id="audienceType"><option value="class">Конкретный класс</option><option value="multiple_classes">Несколько классов</option><option value="parallel">Целая параллель</option><option value="department">Кафедра</option><option value="specific_users">Конкретные пользователи</option><option value="all">Все пользователи</option></select></label><div id="audienceValue">${audienceOptions(audienceType, audience)}</div></section>
            <section class="app-form-section"><h3>Ответственные *</h3>${entityPicker('responsiblePicker', 'Организаторы', (options.users || []).filter((person) => [2, 3, 4, 5].includes(Number(person.type))), responsible, { subtitle: (person) => person.role_name || 'сотрудник' })}</section>
            <details class="app-form-advanced"${event.description || event.location || event.is_registration_enabled ? ' open' : ''}><summary>Дополнительные параметры</summary><div class="app-stack app-section-gap"><label class="app-field"><span class="app-label">Описание</span><textarea class="app-textarea" name="description" rows="3" maxlength="500" placeholder="Коротко опишите событие">${escapeHtml(event.description || '')}</textarea></label><label class="app-field"><span class="app-label">Место проведения</span><input class="app-input" name="location" maxlength="255" value="${escapeHtml(event.location || '')}" placeholder="Актовый зал, кабинет 301"></label><div class="app-two-col"><label class="app-field"><span class="app-label">Предмет</span><select class="app-select" name="subject_id"><option value="">Не выбран</option>${(options.subjects || []).map((item) => `<option value="${Number(item.id)}"${Number(item.id) === Number(event.subject_id) ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label class="app-field"><span class="app-label">Кафедра</span><select class="app-select" name="department_id"><option value="">Не выбрана</option>${(options.departments || []).map((item) => `<option value="${Number(item.id)}"${Number(item.id) === Number(event.department_id) ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label></div><label class="app-check"><input type="checkbox" name="is_registration_enabled" value="1"${event.is_registration_enabled ? ' checked' : ''}><span>Открыть самостоятельную запись</span></label><label class="app-check"><input type="checkbox" name="enable_rewards" value="1"${event.reward_type && event.reward_type !== 'none' ? ' checked' : ''}><span>Начислять награды за участие</span></label><div class="app-two-col"><label class="app-field"><span class="app-label">Тип награды</span><select class="app-select" name="reward_type"><option value="educational">Учебная</option><option value="competitive">Соревновательная</option></select></label><label class="app-field"><span class="app-label">Призовых мест</span><input class="app-input" type="number" name="places_count" min="1" max="100" value="${escapeHtml(event.reward_places || 3)}"></label></div>${Number(state.bootstrap?.user?.type) === 5 ? `<label class="app-check"><input type="checkbox" name="is_admin_event" value="1"${event.is_admin_event ? ' checked' : ''}><span>Административное мероприятие</span></label>` : ''}</div></details>
            <footer class="app-form-actions"><button class="app-btn app-btn-primary" type="submit">${mode === 'edit' ? 'Сохранить и отправить' : mode === 'copy' ? 'Создать повтор' : 'Создать мероприятие'}</button><button class="app-btn app-btn-secondary" type="button" data-dialog-close>Отмена</button></footer></form>`;
    }

    function initializeComposer(event = {}) {
        document.getElementById('audienceType').value = event.target_audience_type || readDraft().target_audience_type || state.formOptions.defaults?.target_audience_type || 'class';
        [document.getElementById('responsiblePicker'), document.getElementById('audiencePicker')].forEach(syncPicker);
        document.getElementById('audienceType')?.addEventListener('change', (change) => {
            const selected = [];
            document.getElementById('audienceValue').innerHTML = audienceOptions(change.target.value, selected);
            syncPicker(document.getElementById('audiencePicker'));
        });
        document.getElementById('workspaceEventForm')?.addEventListener('input', (event) => saveDraft(event.currentTarget));
        document.getElementById('workspaceEventForm')?.addEventListener('change', (event) => saveDraft(event.currentTarget));
    }

    async function openComposer(mode = 'create', eventId = null, opener = document.activeElement) {
        if (!can('create_event')) return notify('У вас нет права создавать мероприятия.', 'danger');
        const body = document.getElementById('eventComposerBody');
        body.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка формы…</div></div>';
        openDialog('eventComposer', opener);
        try {
            const [options, source] = await Promise.all([state.formOptions ? Promise.resolve(state.formOptions) : request('/api/event-form-options'), eventId ? request(`/api/events/${encodeURIComponent(eventId)}`) : Promise.resolve({})]);
            state.formOptions = options;
            const event = mode === 'create' ? {} : source;
            document.getElementById('eventComposerLabel').textContent = mode === 'edit' ? 'Редактировать мероприятие' : mode === 'copy' ? 'Повторить мероприятие' : 'Создать мероприятие';
            document.getElementById('eventComposerKicker').textContent = mode === 'edit' ? 'Рабочая версия' : mode === 'copy' ? 'На основе существующего' : 'Новое событие';
            body.innerHTML = eventFormMarkup(event, mode);
            initializeComposer(event);
            document.getElementById('workspaceEventForm')?.addEventListener('submit', (submit) => submitEventForm(submit, mode, event.id));
            setURL({ compose: mode, event: eventId }, { replace: true });
        } catch (error) { body.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить форму.')}</div>`; }
    }

    async function submitEventForm(submit, mode, eventId) {
        submit.preventDefault();
        const form = submit.currentTarget;
        const data = Object.fromEntries(new FormData(form).entries());
        const audience = checkedValues('#audiencePicker input:checked');
        const responsible = checkedValues('#responsiblePicker input:checked');
        data.target_audience_ids = audience.join(',');
        data.target_audience_id = audience[0] || '';
        data.responsible_ids = responsible.join(',');
        if (data.target_audience_type === 'all') data.target_audience_id = '';
        if (!responsible.length) return notify('Выберите хотя бы одного ответственного.', 'danger');
        if (data.target_audience_type !== 'all' && !audience.length) return notify('Выберите аудиторию мероприятия.', 'danger');
        const button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = 'Сохраняем…';
        try {
            const result = await formRequest(mode === 'edit' ? `/events/edit/${encodeURIComponent(eventId)}` : '/events/create', data);
            clearDraft(); closeDialog('eventComposer'); setURL({ compose: null, event: null }, { replace: true });
            await refreshBootstrap();
            navigate('mine', { replace: true });
            if (result.event) setTimeout(() => window.openEventModal?.(result.event), 100);
            notify(mode === 'edit' ? 'Изменения сохранены и отправлены на согласование.' : 'Мероприятие создано и отправлено на согласование.');
        } catch (error) { notify(error.message || 'Не удалось сохранить мероприятие.', 'danger'); button.disabled = false; button.textContent = mode === 'edit' ? 'Сохранить и отправить' : 'Создать мероприятие'; }
    }

    async function runCommand(button) {
        const command = button.dataset.workspaceCommand;
        const eventId = Number(button.dataset.eventId);
        if (!eventId) return;
        if (command === 'edit' || command === 'copy') { closeDialog('eventModal'); return openComposer(command, eventId, button); }
        if (command === 'reject' || command === 'cancel' || command === 'delete') return window.openReasonModal?.(eventId, command);
        if (command === 'review') { const event = await request(`/api/events/${eventId}`); return window.openReviewModal?.(eventId, event.review_text || ''); }
        if (command === 'approve') {
            try { const result = await formRequest(`/events/admin-approve/${eventId}`); closeDialog('eventModal'); await refreshBootstrap(); await renderCurrent(); notify(result.scope === 'moderation' ? 'Подтверждение сохранено. Ожидаются остальные администраторы.' : 'Мероприятие опубликовано.'); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'resend') {
            try { await formRequest(`/events/resend/${eventId}`); closeDialog('eventModal'); await refreshBootstrap(); navigate('mine', { replace: true }); notify('Мероприятие снова отправлено на согласование.'); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'complete') {
            if (!window.confirm('Подтвердить завершение мероприятия?')) return;
            try { await formRequest(`/api/events/${eventId}/complete`); closeDialog('eventModal'); await refreshBootstrap(); navigate('history', { replace: true }); notify('Мероприятие перенесено в историю.'); } catch (error) { notify(error.message, 'danger'); }
            return;
        }
        if (command === 'register' || command === 'unregister') {
            const childId = Number(button.dataset.childId || document.getElementById('registrationChild')?.value || 0);
            try { await formRequest(`/api/events/${eventId}/${command === 'register' ? 'register' : 'unregister'}`, childId ? { child_id: childId } : {}); window.openEventModal?.(eventId, button); state.calendar?.refetchEvents(); notify(command === 'register' ? 'Запись сохранена.' : 'Запись отменена.'); } catch (error) { notify(error.message || 'Не удалось изменить запись.', 'danger'); }
        }
    }

    async function refreshBootstrap() {
        state.bootstrap = await request('/api/workspace');
        window.workspaceBootstrap = state.bootstrap;
        return state.bootstrap;
    }

    async function renderCurrent() {
        const area = content();
        if (!area) return;
        state.calendar?.destroy(); state.calendar = null; window.calendar = null;
        area.setAttribute('aria-busy', 'true');
        renderHeader(); renderOverview(); updateNavigation();
        if (state.view === 'calendar') await renderCalendar();
        else if (state.view === 'moderation') await renderModeration();
        else if (['mine', 'children', 'history', 'reviews'].includes(state.view)) await renderList();
        else if (state.view === 'notifications') await renderNotifications();
        else if (state.view === 'analytics') { area.innerHTML = analyticsMarkup(); area.querySelectorAll('select').forEach((select) => select.addEventListener('change', loadAnalytics)); await loadAnalytics(); }
        else if (state.view === 'settings') { area.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка справочников…</div></div>'; try { area.innerHTML = settingsMarkup(await request('/api/workspace/settings')); } catch (error) { area.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message)}</div>`; } }
        else if (state.view === 'import') { area.innerHTML = importMarkup(); initImport(); }
        area.setAttribute('aria-busy', 'false');
    }

    async function navigate(view, { replace = false } = {}) {
        const allowed = state.bootstrap?.navigation?.some((item) => item.view === view) || view === 'calendar';
        state.view = allowed && VIEWS[view] ? view : 'calendar';
        setURL({ view: state.view, event: null, compose: null }, { replace });
        await renderCurrent();
    }

    async function routeFromLocation({ replace = true } = {}) {
        const next = urlState();
        state.view = next.view;
        state.filters = next.filters;
        if (replace) setURL({ view: state.view, ...state.filters }, { replace: true });
        await renderCurrent();
        if (next.compose) openComposer(next.compose, next.event || null);
        else if (next.event) window.openEventModal?.(next.event);
    }

    function attachEvents() {
        document.addEventListener('click', async (event) => {
            const navigation = event.target.closest('[data-workspace-view]');
            if (navigation && navigation.tagName === 'A') { event.preventDefault(); await navigate(navigation.dataset.workspaceView); return; }
            const compose = event.target.closest('[data-compose]'); if (compose) return openComposer(compose.dataset.compose, null, compose);
            const open = event.target.closest('[data-open-event]');
            if (open) { const eventId = Number(open.dataset.openEvent); if (state.view === 'moderation' && open.closest('#moderationQueue')) selectModeration(eventId); else window.openEventModal?.(eventId, open); return; }
            const command = event.target.closest('[data-workspace-command]'); if (command) { event.preventDefault(); runCommand(command); return; }
            if (event.target.closest('[data-close-moderation]')) { state.selectedModerationEvent = null; await renderModeration(); return; }
            if (event.target.closest('[data-reset-filters]')) { state.filters = { search: '', status: 'all', type: 'all', from: '', to: '', sort: 'start_asc' }; setURL(state.filters, { replace: true }); await renderCurrent(); return; }
            if (event.target.closest('[data-mark-notifications]')) { await formRequest('/api/notifications/mark-all-read'); await refreshBootstrap(); await renderCurrent(); return; }
            const notification = event.target.closest('[data-notification-id]');
            if (notification) { await formRequest(`/api/notifications/${notification.dataset.notificationId}/read`); await refreshBootstrap(); const eventId = Number(notification.dataset.notificationEvent); if (eventId) window.openEventModal?.(eventId, notification); else renderCurrent(); }
        });
        document.addEventListener('input', (event) => {
            const field = event.target.closest('[data-filter]');
            if (!field || field.dataset.filter !== 'search') return;
            state.filters.search = field.value; clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { setURL({ search: state.filters.search }, { replace: true }); state.calendar ? state.calendar.refetchEvents() : renderCurrent(); }, 250);
        });
        document.addEventListener('change', (event) => {
            const field = event.target.closest('[data-filter]');
            if (!field) return;
            state.filters[field.dataset.filter] = field.value;
            setURL({ [field.dataset.filter]: field.value }, { replace: true });
            state.calendar ? state.calendar.refetchEvents() : renderCurrent();
        });
        window.addEventListener('popstate', () => routeFromLocation({ replace: false }));
        dialog('eventComposer')?.addEventListener('close', () => setURL({ compose: null, event: null }, { replace: true }));
    }

    document.addEventListener('DOMContentLoaded', async () => {
        try { await refreshBootstrap(); await routeFromLocation(); attachEvents(); }
        catch (error) { const area = content(); if (area) area.innerHTML = `<div class="app-alert app-alert-danger">${escapeHtml(error.message || 'Не удалось загрузить рабочее пространство.')}</div>`; }
    });

    window.workspace = { state, notify, openComposer, runCommand, refreshBootstrap, navigate, renderCurrent };
    window.openEventComposer = openComposer;
})();
