import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ServiceUnavailableException } from '@nestjs/common';

/** Isolated LibreOffice profile prevents concurrent conversions sharing a process. */
export async function documentToPdf(buffer: Buffer, extension: string, executable = 'libreoffice'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'bio-document-'));
  try {
    const source = join(dir, `document.${extension}`);
    await writeFile(source, buffer, { mode: 0o600 });
    await promisify(execFile)(executable, [`-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, source], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const pdf = await readFile(join(dir, 'document.pdf'));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid conversion');
    return pdf;
  } catch { throw new ServiceUnavailableException('文档暂时无法转换，请稍后重试，或先上传 PDF 版本。'); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
