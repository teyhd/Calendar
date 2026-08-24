-- Per-user Google Calendar connections. SSO identities remain external and are
-- intentionally stored as scalar IDs without cross-database foreign keys.

CREATE TABLE IF NOT EXISTS google_calendar_connections (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL COMMENT 'SSO user id',
    google_subject VARCHAR(255) NOT NULL,
    google_email VARCHAR(320) NOT NULL,
    calendar_id VARCHAR(512) NOT NULL,
    calendar_name VARCHAR(255) NOT NULL,
    token_key_version VARCHAR(32) NULL,
    refresh_token_ciphertext MEDIUMTEXT NULL,
    refresh_token_iv VARCHAR(64) NULL,
    refresh_token_tag VARCHAR(64) NULL,
    status ENUM('active','paused','reauth_required','disconnected','error') NOT NULL DEFAULT 'active',
    sync_interval_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,
    daily_sync_time TIME NULL,
    time_zone VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow',
    sync_requested_at DATETIME NULL,
    next_sync_at DATETIME NULL,
    sync_lock_until DATETIME NULL,
    last_sync_started_at DATETIME NULL,
    last_sync_at DATETIME NULL,
    last_error_code VARCHAR(64) NULL,
    last_error_message VARCHAR(500) NULL,
    retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_google_calendar_connection_user (user_id, status, updated_at),
    KEY idx_google_calendar_connection_due (status, next_sync_at),
    KEY idx_google_calendar_connection_requested (status, sync_requested_at),
    KEY idx_google_calendar_connection_lock (status, sync_lock_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Parents may choose which of their children is represented by this connection.
CREATE TABLE IF NOT EXISTS google_calendar_connection_subjects (
    connection_id BIGINT UNSIGNED NOT NULL,
    subject_user_id INT NOT NULL COMMENT 'SSO user id',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (connection_id, subject_user_id),
    KEY idx_google_calendar_subject_user (subject_user_id),
    CONSTRAINT fk_google_calendar_subject_connection
        FOREIGN KEY (connection_id) REFERENCES google_calendar_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only events represented here are ever changed in Google Calendar.
CREATE TABLE IF NOT EXISTS google_calendar_event_links (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    connection_id BIGINT UNSIGNED NOT NULL,
    event_id INT NOT NULL,
    google_event_id VARCHAR(512) NOT NULL,
    payload_hash CHAR(64) NULL,
    state ENUM('synced','canceled','orphaned','error') NOT NULL DEFAULT 'synced',
    last_synced_at DATETIME NULL,
    last_error_message VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_google_calendar_connection_event (connection_id, event_id),
    UNIQUE KEY uq_google_calendar_connection_google_event (connection_id, google_event_id),
    KEY idx_google_calendar_link_event (event_id),
    CONSTRAINT fk_google_calendar_link_connection
        FOREIGN KEY (connection_id) REFERENCES google_calendar_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_google_calendar_link_event
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS google_calendar_sync_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    connection_id BIGINT UNSIGNED NOT NULL,
    trigger_type ENUM('event_change','schedule','manual','reconnect') NOT NULL,
    status ENUM('running','success','partial','failed') NOT NULL DEFAULT 'running',
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    created_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_count INT UNSIGNED NOT NULL DEFAULT 0,
    canceled_count INT UNSIGNED NOT NULL DEFAULT 0,
    skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_code VARCHAR(64) NULL,
    error_message VARCHAR(500) NULL,
    PRIMARY KEY (id),
    KEY idx_google_calendar_runs_connection (connection_id, started_at),
    CONSTRAINT fk_google_calendar_run_connection
        FOREIGN KEY (connection_id) REFERENCES google_calendar_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
