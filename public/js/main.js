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

            // Получаем текущего пользователя из сессии (передаётся через мета-теги)
            const userId = parseInt(window.currentUserId || 0);
            const userType = parseInt(window.currentUserRole || 0); // теперь число
            
            const isOwner = parseInt(eventData.created_by) === userId;
            const isAdmin = userType === 5;
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

            renderEventModal(event, props, canEdit, isAdmin, isOwner);
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

// ===== УДАЛЕНИЕ МЕРОПРИЯТИЯ (pending) =====
function deleteEvent(eventId) {
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
        alert('Ошибка при удалении мероприятия');
    });
}

// ===== ОТМЕНА МЕРОПРИЯТИЯ (approved) =====
function cancelEvent(eventId) {
    const reason = prompt('Укажите причину отмены мероприятия:', '');
    if (reason === null) return;
    
    if (!confirm('Вы уверены, что хотите отменить это мероприятие?')) return;
    
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `/events/cancel/${eventId}`;
    
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'cancel_reason';
    input.value = reason || 'Причина не указана';
    
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
}

console.log('main.js загружен, openEventModal доступна:', typeof window.openEventModal);