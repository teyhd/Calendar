(() => {
    const form = document.getElementById('yearPlanImportForm');
    if (!form) return;

    const fileInput = document.getElementById('yearPlanCsv');
    const previewPanel = document.getElementById('yearPlanPreview');
    const previewButton = document.getElementById('yearPlanPreviewButton');
    const commitButton = document.getElementById('yearPlanCommitButton');
    const snapshotText = document.getElementById('yearPlanSnapshot');
    const summary = document.getElementById('yearPlanSummary');
    const examples = document.getElementById('yearPlanExamples');
    const result = document.getElementById('yearPlanResult');
    const snapshotDownload = document.getElementById('yearPlanSnapshotDownload');
    const manifestDownload = document.getElementById('yearPlanManifestDownload');
    let currentImport = null;
    let snapshotUrl = null;
    let manifestUrl = null;

    function resetPreview() {
        currentImport = null;
        commitButton.disabled = true;
        previewPanel.hidden = true;
        result.textContent = '';
        summary.replaceChildren();
        examples.replaceChildren();
        snapshotDownload.hidden = true;
        manifestDownload.hidden = true;
        if (snapshotUrl) URL.revokeObjectURL(snapshotUrl);
        if (manifestUrl) URL.revokeObjectURL(manifestUrl);
        snapshotUrl = null;
        manifestUrl = null;
    }

    function showResult(message, isError = false) {
        result.textContent = message;
        result.className = isError ? 'text-danger small mt-3 mb-0' : 'text-success small mt-3 mb-0';
    }

    async function callApi(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.success) throw new Error(body.error || 'Не удалось обработать запрос.');
        return body;
    }

    function setDownload(link, content, name, type) {
        const objectUrl = URL.createObjectURL(new Blob([content], { type }));
        link.href = objectUrl;
        link.download = name;
        link.hidden = false;
        return objectUrl;
    }

    function renderPreview(data) {
        previewPanel.hidden = false;
        snapshotText.textContent = `${data.snapshot.source}; SHA-256: ${data.snapshot.sha256}`;
        const list = document.createElement('ul');
        list.className = 'mb-0';
        [
            `Будет создано мероприятий: ${data.summary.events}.`,
            `Служебных заметок: ${data.summary.notes}.`,
            `Для всех пользователей: ${data.summary.allAudience}; для наборов классов: ${data.summary.multipleClasses}.`,
            `Дата начала: ${data.summary.startsAt.split('-').reverse().join('.')}; время: ${data.summary.defaultTime}.`
        ].forEach((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            list.append(item);
        });
        summary.replaceChildren(list);

        const heading = document.createElement('p');
        heading.className = 'fw-semibold mb-1';
        heading.textContent = 'Первые записи:';
        const exampleList = document.createElement('ul');
        exampleList.className = 'mb-0';
        data.examples.forEach((item) => {
            const row = document.createElement('li');
            row.textContent = `${item.date.split('-').reverse().join('.')}: ${item.title} (${item.audience}; CSV: ${item.sourceRows.join(', ')})`;
            exampleList.append(row);
        });
        examples.replaceChildren(heading, exampleList);
    }

    fileInput.addEventListener('change', resetPreview);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = fileInput.files?.[0];
        if (!file) {
            fileInput.focus();
            return;
        }
        resetPreview();
        previewButton.disabled = true;
        previewButton.textContent = 'Проверяем…';
        try {
            const csv = await file.text();
            const data = await callApi('/api/events/import/year-plan/preview', { csv, fileName: file.name });
            currentImport = { csv, fileName: file.name, preview: data.preview };
            renderPreview(data);
            snapshotUrl = setDownload(snapshotDownload, csv, `${file.name.replace(/\.csv$/i, '')}-source-copy.csv`, 'text/csv;charset=utf-8');
            commitButton.disabled = false;
            showResult('Снимок проверен. Сначала сохраните копию CSV, затем подтвердите создание.');
        } catch (error) {
            previewPanel.hidden = false;
            showResult(error.message || 'Не удалось проверить снимок.', true);
        } finally {
            previewButton.disabled = false;
            previewButton.textContent = 'Проверить снимок';
        }
    });

    commitButton.addEventListener('click', async () => {
        if (!currentImport || !window.confirm('Создать все проверенные мероприятия и отправить их на модерацию?')) return;
        commitButton.disabled = true;
        commitButton.textContent = 'Создаём…';
        try {
            const data = await callApi('/api/events/import/year-plan/commit', {
                csv: currentImport.csv,
                fileName: currentImport.fileName,
                expiresAt: currentImport.preview.expiresAt,
                signature: currentImport.preview.signature
            });
            manifestUrl = setDownload(manifestDownload, JSON.stringify(data.manifest, null, 2), `calendar-import-${data.manifest.sha256.slice(0, 12)}.json`, 'application/json');
            showResult(`Создано ${data.summary.events} мероприятий. Скачайте реестр переноса и перейдите к модерации.`);
            commitButton.textContent = 'Импорт завершён';
        } catch (error) {
            commitButton.disabled = false;
            commitButton.textContent = 'Создать мероприятия';
            showResult(error.message || 'Не удалось создать мероприятия.', true);
        }
    });
})();
