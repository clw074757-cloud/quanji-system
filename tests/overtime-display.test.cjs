const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(match[1]);
}
const source = html.slice(html.indexOf('function getOvertimeDisplay('), html.indexOf('async function insertData('));
const context = vm.createContext({ allData: [] });
vm.runInContext(source, context);
let cases = 0;
function check(start, end, expected, admin = true, type = '下班') {
    const record = { employee_name: '測試員工', check_type: type, timestamp: `2026-10-03T${end}:00` };
    context.allData = start ? [{ type: 'clock', employee_name: '測試員工', check_type: '上班', timestamp: `2026-10-03T${start}:00` }] : [];
    const result = context.getOvertimeDisplay(record, admin);
    if (expected) assert.ok(result.includes(expected), `${start}–${end}: ${result}`);
    else assert.equal(result, '', `${start}–${end}`);
    cases++;
}
check('08:00', '17:00', '');
check('08:00', '17:01', '超時 0h1m');
check('08:00', '18:00', '超時 1h0m');
check('08:00', '19:30', '超時 2h30m');
check('08:00', '13:00', '');
check('08:00', '14:00', '');
check('08:00', '07:00', '');
check(null, '19:30', '');
check('08:00', '19:30', '', false);
check('08:00', '19:30', '', true, '上班');
console.log(`Inline scripts parse; ${cases} overtime display cases passed.`);
