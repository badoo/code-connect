import { execSync } from 'child_process'

// Check if a file matching a search pattern exists, and return the first match if so
export function getCustomSwiftCLIPath(cwd: string) {
  return execSync(`pwd `, { cwd }).toString().trim().split('\n')[0]
}
