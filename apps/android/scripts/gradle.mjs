import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env }
const signing = join(homedir(), '.just-a-player/android-signing.json')
if (!env.ANDROID_KEYSTORE_PATH && existsSync(signing))
  Object.assign(env, JSON.parse(readFileSync(signing, 'utf8')))
if (process.platform === 'win32' && existsSync('C:/Program Files/Java/jdk-21'))
  env.JAVA_HOME = 'C:/Program Files/Java/jdk-21'
const cached = join(
  homedir(),
  '.gradle/wrapper/dists/gradle-8.11.1-bin/bpt9gzteqjrbo1mjrsomdt32c/gradle-8.11.1/bin/gradle.bat'
)
const command =
  process.platform === 'win32' && existsSync(cached)
    ? cached
    : process.platform === 'win32'
      ? 'gradlew.bat'
      : 'bash'
const args =
  process.platform === 'win32' ? process.argv.slice(2) : ['./gradlew', ...process.argv.slice(2)]
const r = spawnSync(command, args, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(r.status ?? 1)
