const fs = require('node:fs')
const text = fs.readFileSync('src/client/locales.ts', 'utf8')
const keys = [
  'importFolders', 'importTitle', 'importIntro', 'importEmpty', 'importPick',
  'importRemove', 'importConfirm', 'importSummary', 'noticeImported',
  'importStatusImported', 'importStatusConflict', 'importStatusInvalid', 'importStatusError',
]
let bad = false
for (const key of keys) {
  const count = (text.match(new RegExp(`\\b${key}\\b`, 'g')) || []).length
  // Expect: 1 union entry + 1 en + 1 zh (3 occurrences)
  if (count !== 3) {
    bad = true
    console.log(`MISMATCH ${key}: ${count}`)
  }
}
console.log(bad ? 'locale keys INCOMPLETE' : `locale keys OK (${keys.length} keys x3)`)
