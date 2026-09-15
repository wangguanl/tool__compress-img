import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* CRC32（IEEE 802.3，多项式 0xEDB88320）标准查表法                      */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* ZIP(STORED) 结构                                                    */
/* local file header (0x04034b50) → 数据 ×N → central dir (0x02014b50)  */
/* → EOCD (0x06054b50)                                                 */
/* ------------------------------------------------------------------ */
const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800; // bit 11：文件名 UTF-8
const METHOD_STORED = 0;

/** mtime → DOS time/date（ZIP 起始 1980-01-01，更早的 clamp） */
function dosDateTime(d = new Date()) {
	const year = Math.max(1980, d.getFullYear());
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time: time & 0xffff, date: date & 0xffff };
}

/** entry 名 sanitize：剥盘符/绝对路径/.. 段，统一 / 分隔（防 zip-slip） */
export function sanitizeEntryName(name) {
	const norm = String(name).replace(/\\/g, "/");
	const parts = norm
		.split("/")
		.filter((p) => p && p !== "." && p !== ".." && !/^[a-zA-Z]:$/.test(p));
	return parts.join("/") || "file";
}

/**
 * 单条 local file header + 数据
 */
function buildLocalHeader(entryName, data, crc, { time, date }) {
	const nameBuf = Buffer.from(entryName, "utf8");
	const h = Buffer.alloc(30);
	h.writeUInt32LE(SIG_LFH, 0);
	h.writeUInt16LE(20, 4); // version needed
	h.writeUInt16LE(FLAG_UTF8, 6);
	h.writeUInt16LE(METHOD_STORED, 8);
	h.writeUInt16LE(time, 10);
	h.writeUInt16LE(date, 12);
	h.writeUInt32LE(crc, 14);
	h.writeUInt32LE(data.length, 18); // compressed size
	h.writeUInt32LE(data.length, 22); // uncompressed size
	h.writeUInt16LE(nameBuf.length, 26);
	h.writeUInt16LE(0, 28); // extra length
	return Buffer.concat([h, nameBuf, data]);
}

/**
 * 单条 central directory record
 */
function buildCentralHeader(entryName, crc, size, offset, { time, date }) {
	const nameBuf = Buffer.from(entryName, "utf8");
	const h = Buffer.alloc(46);
	h.writeUInt32LE(SIG_CDH, 0);
	h.writeUInt16LE(20, 4); // version made by
	h.writeUInt16LE(20, 6); // version needed
	h.writeUInt16LE(FLAG_UTF8, 8);
	h.writeUInt16LE(METHOD_STORED, 10);
	h.writeUInt16LE(time, 12);
	h.writeUInt16LE(date, 14);
	h.writeUInt32LE(crc, 16);
	h.writeUInt32LE(size, 20);
	h.writeUInt32LE(size, 24);
	h.writeUInt16LE(nameBuf.length, 28);
	// 30-45: extra/comment/disk/internal/external attrs 均为 0
	h.writeUInt32LE(offset, 42);
	return Buffer.concat([h, nameBuf]);
}

/**
 * 内存版：files = [{name, data(Buffer)|path(string)}] → Buffer
 * name 为文件名或含 / 的相对路径；path 时从磁盘读取
 */
export async function zipBuffer(files, { mtime } = {}) {
	const dos = dosDateTime(mtime);
	const chunks = [];
	const centrals = [];
	let offset = 0;

	for (const f of files) {
		const data = Buffer.isBuffer(f.data) ? f.data : await fs.promises.readFile(f.path);
		const name = sanitizeEntryName(f.name ?? path.basename(f.path));
		const crc = crc32(data);
		const local = buildLocalHeader(name, data, crc, dos);
		chunks.push(local);
		centrals.push(buildCentralHeader(name, crc, data.length, offset, dos));
		offset += local.length;
	}

	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(SIG_EOCD, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);

	return Buffer.concat([...chunks, cd, eocd]);
}

/**
 * 流式版：逐条写入 ServerResponse（图片已压缩，STORED 足够）
 * 每条先读文件算 CRC，再写 header + stream
 */
export async function pipeZip(files, res, { mtime } = {}) {
	const dos = dosDateTime(mtime);
	const centrals = [];
	let offset = 0;
	let n = 0;

	for (const f of files) {
		const data = await fs.promises.readFile(f.path); // 会话结果为图片，逐条驻留可控
		const name = sanitizeEntryName(f.name);
		const crc = crc32(data);
		const local = buildLocalHeader(name, data, crc, dos);
		await write(res, local);
		centrals.push(buildCentralHeader(name, crc, data.length, offset, dos));
		offset += local.length;
		n++;
	}

	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(SIG_EOCD, 0);
	eocd.writeUInt16LE(n, 8);
	eocd.writeUInt16LE(n, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	await write(res, cd);
	await write(res, eocd);
}

function write(res, chunk) {
	return new Promise((resolve, reject) => {
		res.write(chunk, (err) => (err ? reject(err) : resolve()));
	});
}
