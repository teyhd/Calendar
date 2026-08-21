import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

function createPool(options, label) {
    const pool = mysql.createPool({
        ...options,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000
    });

    pool.on('error', (error) => {
        // Credentials and connection strings must never reach application logs.
        console.error(`Ошибка пула MySQL (${label}):`, error.code || error.message);
    });

    return pool;
}

/** Calendar owns and writes only its domain database. */
export const calendarPool = createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306)
}, 'calendar');

/**
 * Identity data is deliberately isolated in a separate, read-only pool.
 * The production account for these variables must only have SELECT on sso.*.
 */
export const ssoPool = createPool({
    host: process.env.SSO_DB_HOST || process.env.DB_HOST,
    user: process.env.SSO_DB_USER,
    password: process.env.SSO_DB_PASSWORD,
    database: process.env.SSO_DB_NAME || 'sso',
    port: Number(process.env.SSO_DB_PORT || process.env.DB_PORT || 3306)
}, 'sso-readonly');

export default calendarPool;
