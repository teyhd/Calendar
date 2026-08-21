-- Calendar domain schema. Run this against the empty Calendar database only.
-- SSO identities remain read-only in the separate sso database; therefore no
-- foreign key below points outside the Calendar domain.

CREATE TABLE IF NOT EXISTS event_types (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subjects (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subjects_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
    id INT NOT NULL AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    event_type_id INT NOT NULL,
    department_id INT NULL COMMENT 'SSO kaf_name.id; validated in application',
    subject_id INT NULL,
    start_datetime DATETIME NOT NULL,
    end_datetime DATETIME NOT NULL,
    location VARCHAR(255) NULL,
    level ENUM('school','city','regional','national','international') NOT NULL DEFAULT 'school',
    status ENUM('DRAFT','WAITING_ADMIN','APPROVED','REJECTED','CANCELED','COMPLETED') NOT NULL DEFAULT 'DRAFT',
    target_audience_type ENUM('class','parallel','department','specific_users','all','multiple_classes') NOT NULL,
    target_audience_id VARCHAR(255) NULL COMMENT 'SSO identifiers; validated in application',
    is_admin_event TINYINT(1) NOT NULL DEFAULT 0,
    is_registration_enabled TINYINT(1) NOT NULL DEFAULT 0,
    reward_type ENUM('none','educational','competitive') NOT NULL DEFAULT 'none',
    reward_places INT NULL,
    created_by INT NOT NULL COMMENT 'SSO user id',
    responsible_ids VARCHAR(255) NULL COMMENT 'Comma-separated SSO user ids',
    approved_by INT NULL COMMENT 'SSO admin user id',
    rejection_reason VARCHAR(500) NULL,
    rejected_by INT NULL COMMENT 'SSO admin user id',
    rejected_at TIMESTAMP NULL DEFAULT NULL,
    cancel_reason VARCHAR(500) NULL,
    canceled_by INT NULL COMMENT 'SSO admin user id',
    canceled_at TIMESTAMP NULL DEFAULT NULL,
    review_text TEXT NULL,
    review_author_id INT NULL COMMENT 'SSO user id',
    review_created_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_events_status_start (status, start_datetime),
    KEY idx_events_created_by (created_by),
    KEY idx_events_event_type (event_type_id),
    CONSTRAINT fk_events_event_type FOREIGN KEY (event_type_id) REFERENCES event_types (id),
    CONSTRAINT fk_events_subject FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_approvals (
    id INT NOT NULL AUTO_INCREMENT,
    event_id INT NOT NULL,
    user_id INT NOT NULL COMMENT 'SSO admin user id',
    role_type ENUM('admin') NOT NULL DEFAULT 'admin',
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    comment TEXT NULL,
    order_index INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_approval_user (event_id, user_id),
    KEY idx_event_approval_status (event_id, status),
    KEY idx_approval_user (user_id),
    CONSTRAINT fk_event_approvals_event FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_participants (
    id INT NOT NULL AUTO_INCREMENT,
    event_id INT NOT NULL,
    user_id INT NOT NULL COMMENT 'SSO user id',
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attended TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_participation (event_id, user_id),
    KEY idx_participants_user (user_id),
    CONSTRAINT fk_event_participants_event FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
    id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL COMMENT 'SSO user id',
    event_id INT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_notifications_user_read (user_id, is_read, created_at),
    KEY idx_notifications_event (event_id),
    CONSTRAINT fk_notifications_event FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO event_types (name) VALUES
    ('Учебное'),
    ('Спортивное'),
    ('Творческое'),
    ('Досуговое')
ON DUPLICATE KEY UPDATE name = VALUES(name);
