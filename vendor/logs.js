import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// Получаем путь к папке проекта
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..'); // поднимаемся на уровень выше vendor

// Убеждаемся, что папка logs существует
const logsDir = path.join(projectRoot, 'logs');
fs.ensureDirSync(logsDir);

function padZero(num) {
    return num < 10 ? '0' + num : num;
}

export function mlog(...args) {
    const now = new Date();
    const timestamp = `${padZero(now.getHours())}:${padZero(now.getMinutes())}:${padZero(now.getSeconds())}`;
    const dateStr = `${padZero(now.getDate())}.${padZero(now.getMonth() + 1)}`;
    
    let logText = `\n[${timestamp}]`;
    
    for (const arg of args) {
        if (typeof arg === 'object') {
            logText += `\n${JSON.stringify(arg, null, 2)}`;
        } else {
            logText += ` ${arg}`;
        }
    }
    
    const logFilePath = path.join(logsDir, `${dateStr} log.txt`);
    
    try {
        fs.writeFileSync(logFilePath, logText, {
            encoding: 'utf8',
            flag: 'a+'
        });
    } catch (err) {
        console.error('Ошибка записи лога:', err);
    }
    
    console.log(logText);
    return logText;
}

// Оставляем say() для Telegram, но пока закомментируем, чтобы не было ошибок
export function say(msg, all = true) {
    // Пока просто логируем в консоль, без отправки в Telegram
    mlog(`[TELEGRAM] ${msg}`);
    
    // Если понадобится позже — раскомментируйте
    /*
    const tgnum = [304622290, 5662630619];
    const targets = all ? tgnum : [tgnum[0]];
    targets.forEach(id => {
        setTimeout(() => sendtg(id, msg), 1500);
    });
    */
}