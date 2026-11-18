import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import Busboy from 'busboy';
import { HttpError } from './config.js';
import { sessionPaths } from './runner.js';

const hidden = name => name.startsWith('.') || ['node_modules', '__pycache__'].includes(name);
const missing = () => new HttpError(404, 'FILE_NOT_FOUND', '文件不存在或不可访问');
const uploadLimit = 20 * 1024 * 1024;

async function requireDirectory(path) {
  const stat = await lstat(path).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw missing();
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw missing();
}

async function workspace(dataDir, id) {
  const paths = sessionPaths(dataDir, id);
  await requireDirectory(paths.root);
  await requireDirectory(paths.workspace);
  return paths;
}

export async function listFiles(dataDir, id, offset, limit) {
  const { workspace: root } = await workspace(dataDir, id);
  let found = 0;
  let inspected = 0;
  let limited = false;
  const items = [];
  async function visit(path, depth) {
    if (depth > 10) {
      limited = true;
      return;
    }
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++inspected > 10000) {
        limited = true;
        return;
      }
      if (hidden(entry.name) || entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      const stat = await lstat(child).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (stat?.isDirectory()) await visit(child, depth + 1);
      else if (stat?.isFile() && found++ >= offset) {
        items.push({ path: relative(root, child).split(sep).join('/'), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
      if (items.length > limit || inspected > 10000) return;
    }
  }
  await visit(root, 0);
  return { items: items.slice(0, limit), nextCursor: items.length > limit ? offset + limit : null, limited };
}

export async function downloadFile(dataDir, id, path) {
  if (typeof path !== 'string' || path.length > 2048 || path.includes('\\') || path.includes('\0') ||
      path.split('/').some(name => !name || hidden(name))) throw missing();
  const { workspace: root } = await workspace(dataDir, id);
  try {
    // 每级目录拒绝符号链接，打开时再校验真实路径和文件类型。
    let target = root;
    const parts = path.split('/');
    for (const directory of parts.slice(0, -1)) {
      target = join(target, directory);
      await requireDirectory(target);
    }
    target = join(target, parts.at(-1));
    if (!(await realpath(target)).startsWith(`${await realpath(root)}${sep}`)) throw missing();
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw missing();
      return { fd, size: stat.size, name: basename(target) };
    } catch (error) {
      await fd.close();
      throw error;
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) throw missing();
    throw error;
  }
}

async function removeIfPresent(path) {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

function filename(original) {
  let name = basename(original).replace(/[\u0000-\u001f\u007f]/g, '_');
  if (Buffer.byteLength(name) > 180) {
    const extension = name.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0] ?? '';
    let prefix = '';
    let bytes = Buffer.byteLength(extension);
    for (const character of name.slice(0, name.length - extension.length)) {
      bytes += Buffer.byteLength(character);
      if (bytes > 180) break;
      prefix += character;
    }
    name = prefix + extension;
  }
  return name;
}

export async function uploadFile(req, config, store, sessionId) {
  const paths = await workspace(config.dataDir, sessionId);
  const inputDir = join(paths.workspace, 'inputs');
  await requireDirectory(inputDir);
  const id = randomUUID();
  const temp = join(paths.root, `upload-${id}.part`);
  let parser;
  try {
    parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 0, parts: 2, fileSize: uploadLimit + 1 } });
  } catch {
    throw new HttpError(400, 'UPLOAD_INVALID', '请提交 multipart/form-data 文件');
  }
  let file;
  let failure;
  let write;
  const invalid = () => { failure ??= new HttpError(400, 'UPLOAD_INVALID', '每次上传一个 file 字段'); };
  parser.on('filesLimit', invalid);
  parser.on('fieldsLimit', invalid);
  parser.on('partsLimit', invalid);
  parser.on('file', (field, stream, info) => {
    if (field !== 'file' || !info.filename) {
      invalid();
      stream.resume();
      return;
    }
    const name = filename(info.filename);
    const safeName = name.replace(/[\\:*?"<>|]/g, '_');
    file = { id, name, path: `inputs/${id.slice(0, 8)}-${safeName}`, size: 0 };
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        file.size += chunk.length;
        callback(null, chunk);
      },
    });
    write = pipeline(stream, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 })).catch(error => {
      failure ??= error.code ? error : new HttpError(400, 'UPLOAD_INVALID', '上传内容不完整');
      parser.destroy(error);
    });
  });
  const aborted = () => parser.destroy(new HttpError(400, 'UPLOAD_ABORTED', '上传已中断'));
  try {
    // 先把上传流写入同卷临时文件，完整校验后再原子发布。
    const finished = once(parser, 'close');
    req.once('aborted', aborted);
    req.pipe(parser);
    await finished.catch(error => {
      failure ??= error instanceof HttpError ? error : new HttpError(400, 'UPLOAD_INVALID', '上传内容不完整');
    });
    await write;
    if (failure) throw failure;
    if (!file) throw new HttpError(400, 'UPLOAD_INVALID', '缺少文件');
    if (file.size > uploadLimit) throw new HttpError(413, 'FILE_TOO_LARGE', '文件超过 20 MiB');
    await requireDirectory(inputDir);
    const destination = join(paths.workspace, file.path);
    await rename(temp, destination);
    try {
      store.recordUpload(id, sessionId, file.path, file.name, file.size);
    } catch (error) {
      await removeIfPresent(destination);
      throw error;
    }
    return file;
  } finally {
    req.off('aborted', aborted);
    req.unpipe(parser);
    req.resume();
    await removeIfPresent(temp);
  }
}

export async function createWorkspace(dataDir, id) {
  const { workspace: root } = sessionPaths(dataDir, id);
  await mkdir(join(root, 'inputs'), { recursive: true });
  await mkdir(join(root, 'outputs'));
}
