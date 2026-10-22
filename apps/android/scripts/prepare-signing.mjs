import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
if (!process.env.ANDROID_KEYSTORE_BASE64)
  throw Error('Missing persistent Android release signing secret')
writeFileSync(
  join(process.env.RUNNER_TEMP, 'just-a-player-release.jks'),
  Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'),
  { mode: 0o600 }
)
console.log('Release signing key staged in runner temporary storage')
