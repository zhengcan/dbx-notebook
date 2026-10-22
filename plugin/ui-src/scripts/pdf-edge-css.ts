import { writeFileSync } from 'node:fs'
import { printCss } from '../src/export/printCss'

writeFileSync(process.argv[2], printCss({ orientation: 'portrait' }))
