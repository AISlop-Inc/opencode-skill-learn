const assert = require('node:assert/strict');
const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(p.name, '@aislop-inc/opencode-skill-learn');
assert.equal(p.repository.url, 'git+https://github.com/AISlop-Inc/opencode-skill-learn.git');
assert.notEqual(p.private, true);
assert.equal(p.publishConfig.access, 'public');
for (const entry of Object.values(p.exports || {}).flatMap(v => typeof v === 'string' ? [v] : Object.values(v))) {
  assert.ok(fs.existsSync(entry), 'missing entrypoint: ' + entry);
}
for (const entry of Object.values(p.bin || {})) assert.ok(fs.existsSync(entry), 'missing binary entry: ' + entry);
console.log(p.name + '@' + p.version + ': package identity and entrypoints OK');
