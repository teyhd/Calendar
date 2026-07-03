// Основные скрипты для всех страниц
document.addEventListener('DOMContentLoaded', function() {
    // Автоматическое скрытие сообщений об ошибках через 5 секунд
    const alerts = document.querySelectorAll('.alert:not(.alert-permanent)');
    alerts.forEach(alert => {
        setTimeout(() => {
            alert.style.transition = 'opacity 0.5s';
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 500);
        }, 5000);
    });

    // Подтверждение действий
    document.querySelectorAll('[data-confirm]').forEach(el => {
        el.addEventListener('click', function(e) {
            if (!confirm(this.dataset.confirm)) {
                e.preventDefault();
            }
        });
    });
});

// ================================================================
// === ОТКРЫТИЕ МОДАЛЬНОГО ОКНА ПО ID МЕРОПРИЯТИЯ ===
// ================================================================
window.openEventModal = function(eventId) {
    console.log('openEventModal вызван с ID:', eventId);
    
    const modalBody = document.getElementById('eventModalBody');
    if (modalBody) {
        modalBody.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Загрузка...</span>
                </div>
                <p class="mt-2 text-muted">Загрузка информации о мероприятии...</p>
            </div>
        `;
    }

    fetch(`/api/events/${eventId}`)
        .then(response => {
            if (!response.ok) throw new Error('Мероприятие не найдено');
            return response.json();
        })
        .then(eventData => {
            console.log('Данные мероприятия загружены:', eventData);
            
            if (typeof renderEventModal === 'undefined') {
                console.error('renderEventModal не определена!');
                return;
            }

            const userId = parseInt(window.currentUserId || 0);
            const userType = parseInt(window.currentUserRole || 0);
            
            const isOwner = parseInt(eventData.created_by) === userId;
            const isAdmin = userType === 5;
            const isDirector = userType === 7;
            const canEdit = isAdmin || (isOwner && eventData.status === 'pending');

            const event = {
                id: eventData.id,
                title: eventData.title
            };

            const props = {
                id: eventData.id,
                description: eventData.description || '',
                location: eventData.location || '',
                status: eventData.status,
                creator: eventData.creator_name || 'Неизвестен',
                type: eventData.type_name || 'Не указан',
                created_by: eventData.created_by,
                start_datetime: eventData.start_datetime,
                end_datetime: eventData.end_datetime,
                level: eventData.level,
                target_audience_type: eventData.target_audience_type,
                target_audience_id: eventData.target_audience_id,
                is_admin_event: eventData.is_admin_event,
                is_registration_enabled: eventData.is_registration_enabled,
                created_at: eventData.created_at,
                updated_at: eventData.updated_at
            };

            renderEventModal(event, props, canEdit, isAdmin, isOwner, isDirector);
            const modal = new bootstrap.Modal(document.getElementById('eventModal'));
            modal.show();
        })
        .catch(error => {
            console.error('Ошибка загрузки мероприятия:', error);
            const modalBody = document.getElementById('eventModalBody');
            if (modalBody) {
                modalBody.innerHTML = `
                    <div class="alert alert-danger m-3">
                        <strong>Ошибка:</strong> Не удалось загрузить мероприятие.
                        <br><small>${error.message}</small>
                    </div>
                `;
            }
        });
};

// ================================================================
// === ОБРАБОТЧИК КЛИКОВ НА КАРТОЧКИ (делегирование) ===
// ================================================================
document.addEventListener('DOMContentLoaded', function() {
    document.addEventListener('click', function(e) {
        const card = e.target.closest('[data-event-id]');
        if (!card) return;
        
        if (e.target.closest('a') || e.target.closest('button') || e.target.closest('form')) {
            return;
        }
        
        const eventId = card.dataset.eventId;
        if (eventId) {
            console.log('Клик по карточке с ID:', eventId);
            window.openEventModal(eventId);
        }
    });
});

// ================================================================
// === МОДАЛКА ДЛЯ ПРИЧИНЫ ОТМЕНЫ/ОТКЛОНЕНИЯ ===
// ================================================================

// Открытие модалки с причиной
function openReasonModal(eventId, action) {
    document.getElementById('reasonEventId').value = eventId;
    document.getElementById('reasonAction').value = action;
    document.getElementById('reasonText').value = '';
    
    const modalTitle = document.getElementById('reasonModalLabel');
    const submitBtn = document.getElementById('submitReasonBtn');
    
    if (action === 'reject') {
        modalTitle.textContent = '❌ Отклонить мероприятие';
        submitBtn.innerHTML = '<i class="bi bi-x-lg me-1"></i> Отклонить';
        submitBtn.className = 'btn btn-danger';
    } else if (action === 'cancel') {
        modalTitle.textContent = '🚫 Отменить мероприятие';
        submitBtn.innerHTML = '<i class="bi bi-x-circle me-1"></i> Отменить';
        submitBtn.className = 'btn btn-danger';
    } else if (action === 'cancel_registration') {
        modalTitle.textContent = '❌ Отменить запись';
        submitBtn.innerHTML = '<i class="bi bi-x-circle me-1"></i> Отменить запись';
        submitBtn.className = 'btn btn-danger';
    } else if (action === 'delete') {
        modalTitle.textContent = '🗑️ Удалить мероприятие';
        submitBtn.innerHTML = '<i class="bi bi-trash me-1"></i> Удалить';
        submitBtn.className = 'btn btn-danger';
    }
    
    const modal = new bootstrap.Modal(document.getElementById('reasonModal'));
    modal.show();
}

// Обработчик отправки причины
document.addEventListener('DOMContentLoaded', function() {
    const submitBtn = document.getElementById('submitReasonBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', function() {
            const eventId = document.getElementById('reasonEventId').value;
            const action = document.getElementById('reasonAction').value;
            const reason = document.getElementById('reasonText').value.trim();
            
            const modal = bootstrap.Modal.getInstance(document.getElementById('reasonModal'));
            modal.hide();
            
            submitReason(eventId, action, reason);
        });
    }
    
    const reasonText = document.getElementById('reasonText');
    if (reasonText) {
        reasonText.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && e.ctrlKey) {
                document.getElementById('submitReasonBtn').click();
            }
        });
    }
});

// Отправка причины на сервер
function submitReason(eventId, action, reason) {
    const finalReason = reason || 'Причина не указана';
    
    if (action === 'reject') {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `/events/reject/${eventId}`;
        const reasonInput = document.createElement('input');
        reasonInput.type = 'hidden';
        reasonInput.name = 'rejection_reason';
        reasonInput.value = finalReason;
        form.appendChild(reasonInput);
        document.body.appendChild(form);
        form.submit();
        
    } else if (action === 'cancel') {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `/events/cancel/${eventId}`;
        const reasonInput = document.createElement('input');
        reasonInput.type = 'hidden';
        reasonInput.name = 'cancel_reason';
        reasonInput.value = finalReason;
        form.appendChild(reasonInput);
        document.body.appendChild(form);
        form.submit();
        
    } else if (action === 'cancel_registration') {
        fetch(`/api/events/${eventId}/unregister`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: finalReason })
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
                alert('❌ ' + (data.error || 'Ошибка при отмене записи'));
            }
        })
        .catch(error => {
            console.error('Ошибка:', error);
            alert('❌ Ошибка сервера');
        });
        
    } else if (action === 'delete') {
        if (!confirm('Вы уверены, что хотите удалить это мероприятие?')) return;
        fetch(`/events/delete/${eventId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(response => {
            if (response.redirected) {
                window.location.href = response.url;
            } else {
                return response.text();
            }
        })
        .catch(error => {
            console.error('Ошибка удаления:', error);
            alert('❌ Ошибка при удалении мероприятия');
        });
    }
}

// ================================================================
// === МОДАЛКА ДЛЯ ОТЗЫВА ===
// ================================================================

// Открытие модалки с отзывом
function openReviewModal(eventId, currentText) {
    document.getElementById('reviewEventId').value = eventId;
    document.getElementById('reviewText').value = currentText || '';
    const modal = new bootstrap.Modal(document.getElementById('reviewModal'));
    modal.show();
}

// Обработчик отправки отзыва
document.addEventListener('DOMContentLoaded', function() {
    const submitReviewBtn = document.getElementById('submitReviewBtn');
    if (submitReviewBtn) {
        submitReviewBtn.addEventListener('click', function() {
            const eventId = document.getElementById('reviewEventId').value;
            const reviewText = document.getElementById('reviewText').value.trim();
            
            if (!reviewText) {
                alert('Пожалуйста, введите текст отзыва');
                return;
            }
            
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = `/events/review/${eventId}`;
            
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'review_text';
            input.value = reviewText;
            
            form.appendChild(input);
            document.body.appendChild(form);
            form.submit();
        });
    }
});

console.log('main.js загружен, openEventModal доступна:', typeof window.openEventModal);