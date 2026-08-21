document.addEventListener('DOMContentLoaded', function() {
    // Фильтры
    const periodSelect = document.getElementById('period');
    const eventTypeSelect = document.getElementById('eventType');
    const teacherFilter = document.getElementById('teacherFilter');
    const resetBtn = document.getElementById('resetFiltersBtn');

    // Графики
    let teachersChart = null;
    let classesChart = null;
    let typesChart = null;
    let timelineChart = null;

    function loadAnalytics() {
        const params = new URLSearchParams({
            period: periodSelect.value,
            type: eventTypeSelect.value,
            teacher: teacherFilter ? teacherFilter.value : 'all'
        });

        fetch(`/api/analytics?${params.toString()}`)
            .then(response => {
                if (!response.ok) throw new Error('Ошибка загрузки');
                return response.json();
            })
            .then(data => {
                updateStats(data.totals);
                updateTeachersChart(data.teachers);
                updateClassesChart(data.classes);
                updateTypesChart(data.event_types);
                updateTimelineChart(data.timeline);
                updateStudentsTable(data.students);
                updateResponsibleTable(data.responsible);
                updateOrganizersTable(data.organizers);
            })
            .catch(err => {
                console.error('Ошибка загрузки аналитики:', err);
                alert('Не удалось загрузить данные аналитики');
            });
    }

    function updateStats(totals) {
        document.getElementById('totalEvents').textContent = totals.total_events || 0;
        document.getElementById('approvedEvents').textContent = totals.approved_count || 0;
        document.getElementById('rejectedEvents').textContent = totals.rejected_count || 0;
        document.getElementById('totalParticipants').textContent = totals.total_participants || 0;
    }

    function updateTeachersChart(data) {
        const canvas = document.getElementById('teachersChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const labels = data.map(d => d.name);
        const created = data.map(d => d.created_events);
        const participations = data.map(d => d.participations);

        if (teachersChart) teachersChart.destroy();

        teachersChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Создано мероприятий',
                        data: created,
                        backgroundColor: 'rgba(21, 94, 239, 0.76)',
                        borderColor: 'rgba(21, 94, 239, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Участий',
                        data: participations,
                        backgroundColor: 'rgba(247, 144, 9, 0.72)',
                        borderColor: 'rgba(247, 144, 9, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    function updateClassesChart(data) {
        const canvas = document.getElementById('classesChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const labels = data.map(d => d.name);
        const eventsCount = data.map(d => d.events_count);
        const participants = data.map(d => d.participants_count);

        if (classesChart) classesChart.destroy();

        classesChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Мероприятий',
                        data: eventsCount,
                        backgroundColor: 'rgba(15, 118, 110, 0.72)',
                        borderColor: 'rgba(15, 118, 110, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Участников',
                        data: participants,
                        backgroundColor: 'rgba(86, 64, 180, 0.72)',
                        borderColor: 'rgba(86, 64, 180, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    function updateTypesChart(data) {
        const canvas = document.getElementById('typesChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const labels = data.map(d => d.type_name);
        const counts = data.map(d => d.count);

        if (typesChart) typesChart.destroy();

        typesChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: counts,
                    backgroundColor: [
                        'rgba(21, 94, 239, 0.74)',
                        'rgba(15, 118, 110, 0.74)',
                        'rgba(247, 144, 9, 0.74)',
                        'rgba(180, 35, 45, 0.74)',
                        'rgba(86, 64, 180, 0.74)',
                        'rgba(71, 84, 103, 0.74)'
                    ],
                    borderColor: [
                        'rgba(21, 94, 239, 1)',
                        'rgba(15, 118, 110, 1)',
                        'rgba(247, 144, 9, 1)',
                        'rgba(180, 35, 45, 1)',
                        'rgba(86, 64, 180, 1)',
                        'rgba(71, 84, 103, 1)'
                    ],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'right' }
                }
            }
        });
    }

    function updateTimelineChart(data) {
        const canvas = document.getElementById('timelineChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const labels = data.map(d => d.date);
        const counts = data.map(d => d.count);

        if (timelineChart) timelineChart.destroy();

        timelineChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Количество мероприятий',
                    data: counts,
                    backgroundColor: 'rgba(21, 94, 239, 0.13)',
                    borderColor: 'rgba(21, 94, 239, 1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    // ----- Таблицы -----
    function updateStudentsTable(data) {
        const container = document.getElementById('studentsTable');
        if (!container) return;
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="app-help">Нет данных по ученикам</p>';
            return;
        }
        let html = '<table class="app-table"><thead><tr><th>#</th><th>Ученик</th><th>Класс</th><th>Участий</th><th>Создано</th></tr></thead><tbody>';
        data.forEach((item, index) => {
            html += `<tr>
                <td>${index + 1}</td>
                <td>${item.name}</td>
                <td>${item.class_name || '—'}</td>
                <td>${item.participations}</td>
                <td>${item.created_events}</td>
            </tr>`;
        });
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    function updateResponsibleTable(data) {
        const container = document.getElementById('responsibleTable');
        if (!container) return;
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="app-help">Нет данных по ответственным</p>';
            return;
        }
        let html = '<table class="app-table"><thead><tr><th>#</th><th>Ответственный</th><th>Кол-во мероприятий</th></tr></thead><tbody>';
        data.forEach((item, index) => {
            html += `<tr>
                <td>${index + 1}</td>
                <td>${item.name}</td>
                <td>${item.responsible_count}</td>
            </tr>`;
        });
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    function updateOrganizersTable(data) {
        const container = document.getElementById('organizersTable');
        if (!container) return;
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="app-help">Нет данных по организаторам</p>';
            return;
        }
        let html = '<table class="app-table"><thead><tr><th>#</th><th>Организатор</th><th>Создано мероприятий</th></tr></thead><tbody>';
        data.forEach((item, index) => {
            html += `<tr>
                <td>${index + 1}</td>
                <td>${item.name}</td>
                <td>${item.created_events}</td>
            </tr>`;
        });
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    // ----- Сброс фильтров -----
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            periodSelect.value = 'month';
            eventTypeSelect.value = 'all';
            if (teacherFilter) teacherFilter.value = 'all';
            loadAnalytics();
        });
    }

    // Подписка на изменения фильтров
    periodSelect.addEventListener('change', loadAnalytics);
    eventTypeSelect.addEventListener('change', loadAnalytics);
    if (teacherFilter) {
        teacherFilter.addEventListener('change', loadAnalytics);
    }

    // Первая загрузка
    loadAnalytics();
});
