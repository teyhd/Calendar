// Shared, dependency-free interaction layer for the server-rendered interface.
(() => {
    function dialogById(id) {
        return document.getElementById(id);
    }

    function openDialog(id, opener = document.activeElement) {
        const dialog = dialogById(id);
        if (!dialog || typeof dialog.showModal !== 'function') return;
        if (!dialog.open) {
            dialog._appOpener = opener instanceof HTMLElement ? opener : null;
            dialog.showModal();
        }
    }

    function closeDialog(id) {
        const dialog = dialogById(id);
        if (dialog?.open) dialog.close();
    }

    function closeAllPopovers(exceptId = null) {
        document.querySelectorAll('.app-popover.is-open').forEach((popover) => {
            if (popover.id !== exceptId) popover.classList.remove('is-open');
        });
        document.querySelectorAll('[data-popover-trigger][aria-expanded="true"]').forEach((button) => {
            if (button.dataset.popoverTrigger !== exceptId) button.setAttribute('aria-expanded', 'false');
        });
    }

    window.appUI = { openDialog, closeDialog };

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.app-alert:not(.alert-permanent), .alert:not(.alert-permanent)').forEach((alert) => {
            window.setTimeout(() => alert.remove(), 7000);
        });

        document.querySelectorAll('[data-confirm]').forEach((element) => {
            element.addEventListener('click', (event) => {
                if (!window.confirm(element.dataset.confirm)) event.preventDefault();
            });
        });

        document.addEventListener('click', (event) => {
            const closeButton = event.target.closest('[data-dialog-close]');
            if (closeButton) {
                closeButton.closest('dialog')?.close();
                return;
            }

            const drawerButton = event.target.closest('[data-drawer-open]');
            if (drawerButton) {
                openDialog(drawerButton.dataset.drawerOpen, drawerButton);
                return;
            }

            if (event.target.closest('[data-drawer-close]')) {
                event.target.closest('dialog')?.close();
                return;
            }

            const popoverButton = event.target.closest('[data-popover-trigger]');
            if (popoverButton) {
                const id = popoverButton.dataset.popoverTrigger;
                const popover = dialogById(id);
                const shouldOpen = !popover?.classList.contains('is-open');
                closeAllPopovers();
                if (popover && shouldOpen) {
                    popover.classList.add('is-open');
                    popoverButton.setAttribute('aria-expanded', 'true');
                }
                return;
            }

            if (!event.target.closest('.app-popover-root')) closeAllPopovers();

            const reviewTrigger = event.target.closest('[data-review-trigger]');
            if (reviewTrigger) {
                window.openReviewModal(reviewTrigger.dataset.reviewEventId, reviewTrigger.dataset.reviewText || '');
                return;
            }

            const eventCard = event.target.closest('[data-event-id]');
            if (eventCard && !event.target.closest('a, button, form, input, select, textarea')) {
                window.openEventModal(eventCard.dataset.eventId, eventCard);
            }
        });

        document.querySelectorAll('dialog').forEach((dialog) => {
            dialog.addEventListener('click', (event) => {
                if (event.target === dialog) dialog.close();
            });
            dialog.addEventListener('cancel', (event) => {
                event.preventDefault();
                dialog.close();
            });
            dialog.addEventListener('close', () => {
                const opener = dialog._appOpener;
                dialog._appOpener = null;
                if (opener?.isConnected) {
                    window.setTimeout(() => opener.focus(), 0);
                }
            });
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeAllPopovers();
        });

        document.getElementById('submitReasonBtn')?.addEventListener('click', () => {
            const eventId = document.getElementById('reasonEventId').value;
            const action = document.getElementById('reasonAction').value;
            const reason = document.getElementById('reasonText').value.trim();
            closeDialog('reasonModal');
            submitReason(eventId, action, reason);
        });

        document.getElementById('reasonText')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                document.getElementById('submitReasonBtn')?.click();
            }
        });

        document.getElementById('submitReviewBtn')?.addEventListener('click', () => {
            const eventId = document.getElementById('reviewEventId').value;
            const reviewText = document.getElementById('reviewText').value.trim();
            if (!reviewText) {
                document.getElementById('reviewText').focus();
                return;
            }
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = `/events/review/${encodeURIComponent(eventId)}`;
            const input = document.createElement('input');
            input.type = 'hidden'; input.name = 'review_text'; input.value = reviewText;
            form.appendChild(input); document.body.appendChild(form); form.submit();
        });
    });

    window.openEventModal = function openEventModal(eventId, opener) {
        const modalBody = document.getElementById('eventModalBody');
        if (modalBody) modalBody.innerHTML = '<div class="app-modal-loading"><span class="app-spinner" aria-hidden="true"></span><div>Загрузка информации…</div></div>';
        openDialog('eventModal', opener);

        fetch(`/api/events/${encodeURIComponent(eventId)}`)
            .then((response) => {
                if (!response.ok) throw new Error('Мероприятие не найдено');
                return response.json();
            })
            .then((eventData) => {
                if (typeof window.renderEventModal !== 'function') throw new Error('Модуль календаря недоступен');
                const userId = Number(window.currentUserId || 0);
                const userType = Number(window.currentUserRole || 0);
                const isOwner = Number(eventData.created_by) === userId;
                const isAdmin = userType === 5;
                const canEdit = isAdmin || (isOwner && eventData.status === 'WAITING_ADMIN');
                window.renderEventModal({ id: eventData.id, title: eventData.title }, eventData, canEdit, isAdmin, isOwner);
            })
            .catch((error) => {
                console.error('Не удалось загрузить мероприятие:', error);
                if (modalBody) modalBody.innerHTML = '<div class="app-alert app-alert-danger">Не удалось загрузить информацию о мероприятии. Попробуйте ещё раз.</div>';
            });
    };

    window.openReasonModal = function openReasonModal(eventId, action) {
        const titles = {
            reject: 'Отклонить мероприятие',
            cancel: 'Отменить мероприятие',
            cancel_registration: 'Отменить запись',
            delete: 'Удалить мероприятие'
        };
        document.getElementById('reasonEventId').value = eventId;
        document.getElementById('reasonAction').value = action;
        document.getElementById('reasonText').value = '';
        document.getElementById('reasonModalLabel').textContent = titles[action] || 'Укажите причину';
        const submitButton = document.getElementById('submitReasonBtn');
        submitButton.textContent = action === 'delete' ? 'Удалить' : action === 'cancel_registration' ? 'Отменить запись' : action === 'cancel' ? 'Отменить' : 'Отклонить';
        submitButton.className = 'app-btn app-btn-danger';
        openDialog('reasonModal');
        window.setTimeout(() => document.getElementById('reasonText')?.focus(), 0);
    };

    window.openReviewModal = function openReviewModal(eventId, currentText = '') {
        document.getElementById('reviewEventId').value = eventId;
        document.getElementById('reviewText').value = currentText;
        openDialog('reviewModal');
        window.setTimeout(() => document.getElementById('reviewText')?.focus(), 0);
    };

    function submitReason(eventId, action, reason) {
        const finalReason = reason || 'Причина не указана';
        if (action === 'reject' || action === 'cancel') {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = `/events/${action}/${encodeURIComponent(eventId)}`;
            const input = document.createElement('input');
            input.type = 'hidden'; input.name = action === 'reject' ? 'rejection_reason' : 'cancel_reason'; input.value = finalReason;
            form.appendChild(input); document.body.appendChild(form); form.submit();
            return;
        }
        if (action === 'cancel_registration') {
            fetch(`/api/events/${encodeURIComponent(eventId)}/unregister`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: finalReason }) })
                .then((response) => response.json())
                .then((data) => {
                    if (!data.success) throw new Error(data.error || 'Не удалось отменить запись');
                    closeDialog('eventModal'); window.calendar?.refetchEvents(); window.loadStats?.();
                })
                .catch((error) => window.alert(error.message || 'Ошибка сервера'));
            return;
        }
        if (action === 'delete' && window.confirm('Удалить мероприятие без возможности восстановления?')) {
            fetch(`/events/delete/${encodeURIComponent(eventId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
                .then((response) => { if (response.redirected) window.location.assign(response.url); else if (!response.ok) throw new Error('Не удалось удалить мероприятие'); })
                .catch((error) => window.alert(error.message || 'Ошибка удаления'));
        }
    }
})();
