import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Добавляем параметры для устойчивости
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// Обработка ошибок пула
pool.on('error', (err) => {
    console.error('❌ Ошибка в пуле соединений MySQL:', err);
});

export default pool;