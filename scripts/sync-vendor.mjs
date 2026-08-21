import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const assets = [
    ['node_modules/fullcalendar/index.global.min.js', 'public/vendor/fullcalendar/index.global.min.js'],
    ['node_modules/chart.js/dist/chart.umd.js', 'public/vendor/chart.js/chart.umd.js']
];

await Promise.all(assets.map(async ([from, to]) => {
    const source = resolve(root, from);
    const target = resolve(root, to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
}));

console.log(`Synced ${assets.length} local browser vendor assets.`);
