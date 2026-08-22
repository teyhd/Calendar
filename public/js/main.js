(() => {
    function dialogById(id) { return document.getElementById(id); }
    function openDialog(id, opener = document.activeElement) {
        const dialog = dialogById(id);
        if (!dialog || typeof dialog.showModal !== 'function') return;
        if (!dialog.open) { dialog._appOpener = opener instanceof HTMLElement ? opener : null; dialog.showModal(); }
    }
    function closeDialog(id) { if (dialogById(id)?.open) dialogById(id).close(); }
    function closeAllPopovers(exceptId = null) {
        document.querySelectorAll('.app-popover.is-open').forEach((popover) => { if (popover.id !== exceptId) popover.classList.remove('is-open'); });
        document.querySelectorAll('[data-popover-trigger][aria-expanded="true"]').forEach((button) => {
            if (button.dataset.popoverTrigger !== exceptId) button.setAttribute('aria-expanded', 'false');
        });
    }
    async function request(url, options = {}) {
        const response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) throw new Error(data.error || 'Не удалось выполнить действие');
        return data;
    }
    function notify(message, tone = 'success') { window.workspace?.notify?.(message, tone); }
    function refreshAfterAction(message) {
        closeDialog('reasonModal'); closeDialog('eventModal');
        window.calendar?.refetchEvents(); window.loadStats?.();
        notify(message);
    }

    window.appUI = { openDialog, closeDialog, request, notify };

    document.addEventListener('DOMContentLoaded', () => {
        document.addEventListener('click', (event) => {
            const closeButton = event.target.closest('[data-dialog-close]');
            if (closeButton) { closeButton.closest('dialog')?.close(); return; }
            const drawerButton = event.target.closest('[data-drawer-open]');
            if (drawerButton) { openDialog(drawerButton.dataset.drawerOpen, drawerButton); return; }
            if (event.target.closest('[data-drawer-close]')) { event.target.closest('dialog')?.close(); return; }
            const popoverButton = event.target.closest('[data-popover-trigger]');
            if (popoverButton) {
                const id = popoverButton.dataset.popoverTrigger;
                const popover = dialogById(id);
                const shouldOpen = !popover?.classList.contains('is-open');
                closeAllPopovers();
                if (popover && shouldOpen) { popover.classList.add('is-open'); popoverButton.setAttribute('aria-expanded', 'true'); }
                return;
            }
            if (!event.target.closest('.app-popover-root')) closeAllPopovers();
            const eventCard = event.target.closest('[data-event-id]');
            if (eventCard && !event.target.closest('a, button, form, input, select, textarea')) window.openEventModal(eventCard.dataset.eventId, eventCard);
        });
        document.querySelectorAll('dialog').forEach((dialog) => {
            dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
            dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close(); });
            dialog.addEventListener('close', () => { const opener = dialog._appOpener; dialog._appOpener = null; if (opener?.isConnected) setTimeout(() => opener.focus(), 0); });
        });
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAllPopovers(); });
        document.getElementById('submitReasonBtn')?.addEventListener('click', () => {
            const eventId = document.getElementById('reasonEventId').value;
            const action = document.getElementById('reasonAction').value;
            submitReason(eventId, action, document.getElementById('reasonText').value.trim());
        });
        document.getElementById('submitReviewBtn')?.addEventListener('click', () => submitReview());
    });

    window.openEventModal = function openEventModal(eventId, opener) {
        const modalBody = document.getElementById('eventModalBody');
        if (modalBody) modalBody.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка информации…</div></div>';
        openDialog('eventModal', opener);
        request(`/api/events/${encodeURIComponent(eventId)}`)
            .then((eventData) => {
                if (!window.calendarUI) throw new Error('Модуль календаря недоступен');
                window.calendarUI.renderEvent(eventData);
            })
            .catch((error) => { if (modalBody) modalBody.innerHTML = `<div class="app-alert app-alert-danger">${error.message || 'Не удалось загрузить информацию.'}</div>`; });
    };

    window.openReasonModal = function openReasonModal(eventId, action) {
        const titles = { reject: 'Отклонить мероприятие', cancel: 'Отменить мероприятие', cancel_registration: 'Отменить запись', delete: 'Удалить мероприятие' };
        document.getElementById('reasonEventId').value = eventId;
        document.getElementById('reasonAction').value = action;
        document.getElementById('reasonText').value = '';
        document.getElementById('reasonModalLabel').textContent = titles[action] || 'Укажите причину';
        const submit = document.getElementById('submitReasonBtn');
        submit.textContent = action === 'delete' ? 'Удалить' : action === 'cancel_registration' ? 'Отменить запись' : action === 'cancel' ? 'Отменить' : 'Отклонить';
        openDialog('reasonModal');
        setTimeout(() => document.getElementById('reasonText')?.focus(), 0);
    };

    window.openReviewModal = function openReviewModal(eventId, currentText = '') {
        document.getElementById('reviewEventId').value = eventId;
        document.getElementById('reviewText').value = currentText;
        openDialog('reviewModal');
        setTimeout(() => document.getElementById('reviewText')?.focus(), 0);
    };

    async function submitReason(eventId, action, reason) {
        const body = action === 'reject' ? { rejection_reason: reason } : action === 'cancel' ? { cancel_reason: reason } : {};
        const url = action === 'reject' ? `/events/reject/${encodeURIComponent(eventId)}`
            : action === 'cancel' ? `/events/cancel/${encodeURIComponent(eventId)}`
            : action === 'cancel_registration' ? `/api/events/${encodeURIComponent(eventId)}/unregister`
            : `/events/delete/${encodeURIComponent(eventId)}`;
        if (action === 'delete' && !window.confirm('Удалить мероприятие без возможности восстановления?')) return;
        try {
            await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            refreshAfterAction(action === 'reject' ? 'Мероприятие отклонено.' : action === 'cancel' ? 'Мероприятие отменено.' : action === 'delete' ? 'Мероприятие удалено.' : 'Запись отменена.');
        } catch (error) { notify(error.message || 'Не удалось выполнить действие', 'danger'); }
    }

    async function submitReview() {
        const eventId = document.getElementById('reviewEventId').value;
        const review = document.getElementById('reviewText').value.trim();
        if (!review) { document.getElementById('reviewText').focus(); return; }
        try {
            await request(`/events/review/${encodeURIComponent(eventId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_text: review }) });
            closeDialog('reviewModal'); closeDialog('eventModal'); window.calendar?.refetchEvents(); window.loadStats?.(); notify('Отзыв сохранён.');
        } catch (error) { notify(error.message || 'Не удалось сохранить отзыв', 'danger'); }
    }
})();
