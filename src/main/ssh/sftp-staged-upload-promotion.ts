import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'

// Why: stage under a SHORT fixed-length sibling name in the destination's parent
// directory, derived independently of the destination basename length. Appending
// a suffix to remotePath (the old scheme) inflated the final path COMPONENT and,
// for a valid basename near the ~255-byte NAME_MAX, pushed the staged component
// past the limit — regressing valid uploads. A short name in the same parent
// stays well under NAME_MAX for any valid destination and keeps rename atomic.
export function stagingTempPath(remotePath: string): string {
  const lastSlash = remotePath.lastIndexOf('/')
  const shortId = randomUUID().replace(/-/g, '').slice(0, 20)
  const base = `.orca-tmp-${shortId}`
  return lastSlash >= 0 ? `${remotePath.slice(0, lastSlash + 1)}${base}` : base
}

// Why: promote a fully-written temp file to its destination. Exclusive uploads
// use plain rename (SFTP v3 fails if the target exists, preserving no-clobber);
// overwrite uploads prefer posix-rename@openssh.com for an atomic replace.
export async function promoteTempToFinal(
  sftp: SFTPWrapper,
  tempPath: string,
  remotePath: string,
  exclusive: boolean
): Promise<void> {
  if (exclusive) {
    await renameSftp(sftp, tempPath, remotePath)
    return
  }
  try {
    await new Promise<void>((resolve, reject) => {
      // ext_openssh_rename throws synchronously when the server lacks the
      // extension, so the try/catch also covers the unsupported case.
      sftp.ext_openssh_rename(tempPath, remotePath, (err) => (err ? reject(err) : resolve()))
    })
    return
  } catch {
    /* extension unsupported or failed — fall back to unlink + rename */
  }
  await unlinkQuietSftp(sftp, remotePath)
  await renameSftp(sftp, tempPath, remotePath)
}

export function unlinkQuietSftp(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(remotePath, () => resolve())
  })
}

function renameSftp(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  })
}
