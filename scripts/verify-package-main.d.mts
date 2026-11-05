/** Type surface for the publish gate; the implementation is plain ESM JavaScript. */
export interface RequiredFile {
  /** Manifest field the path came from, e.g. `main`. */
  label: string
  /** Package-relative path the tarball must carry. */
  path: string
}
export function requiredEntryFiles(manifest: Record<string, unknown>): RequiredFile[]
export function verifyTarball(tarballPath: string): { name: string; version: string }
export function verifyPackageDirectory(directory: string): { name: string; version: string; tarball: string }
export function parseArguments(argv: readonly string[]): { tarball?: string; directory?: string }
