import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FIXTURE_REL, fixtureCases } from '../test/sqlFixtureCases'

const out = fileURLToPath(new URL(FIXTURE_REL, new URL('../test/', import.meta.url)))
writeFileSync(out, JSON.stringify(fixtureCases(), null, 2) + '\n')
console.log('wrote', out)
