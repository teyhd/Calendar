import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { buildYearPlanImportRecords, canImportYearPlan, parseCsvSnapshot, sourceDateToIso } = await import('../app.js');

const header = 'Уч. нед.,Дата,Начальная школа,5-6 классы,7-9 классы,10-11 классы,комментарии';

test('year-plan import keeps the source note, groups exact titles and crosses into 2027', () => {
    const csv = [
        header,
        ',сб 22 августа,,,,,мероприятия детей',
        ',вт 1 сентября,Праздник,Праздник,Праздник,Праздник,КВЕСТ ПО КЛАССАМ',
        ',чт 8 января,,Лис,Лис,,'
    ].join('\n');

    const { snapshotHash, records } = buildYearPlanImportRecords(csv, 'График года - 26-27.csv');
    const note = records.find((record) => record.sourceColumns[0] === 'комментарии');
    const holiday = records.find((record) => record.title === 'Праздник');
    const january = records.find((record) => record.title === 'Лис');

    assert.match(snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(note.sourceDate, '2026-08-22');
    assert.equal(note.title, 'Служебная заметка — 22.08.2026');
    assert.match(note.description, /мероприятия детей/);
    assert.equal(holiday.sourceDate, '2026-09-01');
    assert.equal(holiday.audienceAll, true);
    assert.deepEqual(holiday.grades, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.match(holiday.description, /КВЕСТ ПО КЛАССАМ/);
    assert.equal(january.sourceDate, '2027-01-08');
    assert.deepEqual(january.grades, [5, 6, 7, 8, 9]);
});

test('year-plan import skips rows before 22 August and does not merge different source text', () => {
    const csv = [
        header,
        ',пт 21 августа,Не переносить,,,,',
        ',сб 22 августа,Праздник,праздник,,,',
    ].join('\n');

    const { records } = buildYearPlanImportRecords(csv, '26-27.csv');
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.title).sort(), ['Праздник', 'праздник']);
    assert.equal(records.some((record) => record.title === 'Не переносить'), false);
});

test('year-plan import validates the date and CSV source identity', () => {
    assert.equal(sourceDateToIso('пн 31 августа'), '2026-08-31');
    assert.equal(sourceDateToIso('чт 1 января'), '2027-01-01');
    assert.equal(sourceDateToIso('не дата'), null);
    assert.throws(() => buildYearPlanImportRecords(`${header}\n,сб 22 августа,Тест,,,,`, 'other.csv'), /26-27/);
    assert.throws(() => buildYearPlanImportRecords('wrong,header\n', '26-27.csv'), /заголовков/);
});

test('CSV parser keeps quoted commas and escaped quotes in source comments', () => {
    assert.deepEqual(parseCsvSnapshot('Дата,комментарии\n"вт 1 сентября","Точка, сборки: ""вестибюль"""'), [
        ['Дата', 'комментарии'],
        ['вт 1 сентября', 'Точка, сборки: "вестибюль"']
    ]);
});

test('year-plan import accepts only the confirmed full SSO identity of Marina', () => {
    const baseActor = { type: 2, permissions: { create_event: true } };
    assert.equal(canImportYearPlan({ ...baseActor, name: 'Юникова Марина Витальевна' }), true);
    assert.equal(canImportYearPlan({ ...baseActor, name: 'Юникова Марина' }), false);
    assert.equal(canImportYearPlan({ ...baseActor, name: 'Другой пользователь' }), false);
});
