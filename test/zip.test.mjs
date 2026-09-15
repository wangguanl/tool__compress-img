import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipBuffer, crc32, sanitizeEntryName } from "../lib/zip.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zip-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

test("CRC32 标准测试向量", () => {
	// "123456789" 的 CRC32 恒为 0xCBF43926
	assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
	assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("sanitizeEntryName 防 zip-slip", () => {
	assert.equal(sanitizeEntryName("../../etc/passwd"), "etc/passwd");
	assert.equal(sanitizeEntryName("/abs/path/a.png"), "abs/path/a.png");
	assert.equal(sanitizeEntryName("C:\\win\\evil.png"), "win/evil.png");
	assert.equal(sanitizeEntryName("sub/../ok.jpg"), "sub/ok.jpg"); // 剥离 .. 段即安全
	assert.equal(sanitizeEntryName("正常/文件.png"), "正常/文件.png");
});

test("zipBuffer 结构：签名 / EOCD / 条目数", async () => {
	const files = [
		{ name: "照片.jpg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
		{ name: "sub/猫.png", data: Buffer.from("png-data-here") },
		{ name: "plain.webp", data: Buffer.alloc(2048, 7) },
	];
	const zip = await zipBuffer(files);

	// local file header 签名
	assert.equal(zip.readUInt32LE(0), 0x04034b50);
	// EOCD 在末尾 22 字节
	const eocdOff = zip.length - 22;
	assert.equal(zip.readUInt32LE(eocdOff), 0x06054b50);
	// 条目数
	assert.equal(zip.readUInt16LE(eocdOff + 10), 3);
	// central directory 签名（在 EOCD 记录的偏移处）
	const cdOff = zip.readUInt32LE(eocdOff + 16);
	assert.equal(zip.readUInt32LE(cdOff), 0x02014b50);
});

test("zipBuffer 产出可被 unzip 校验（若系统有 unzip）", async () => {
	const zipPath = path.join(tmp, "t.zip");
	const files = [
		{ name: "中文 名字.jpg", data: Buffer.from("image-bytes-✓") },
		{ name: "nested/dir/b.png", data: Buffer.alloc(1000, 9) },
	];
	fs.writeFileSync(zipPath, await zipBuffer(files));

	let hasUnzip = true;
	try {
		execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
	} catch (err) {
		hasUnzip = false;
		if (err.status !== null && err.status !== undefined && !/No such file/.test(err.message)) {
			throw err; // unzip 存在但校验失败 → 真 bug
		}
	}
	if (hasUnzip) console.log("  unzip -t 通过");
	else console.log("  （系统无 unzip，跳过校验）");
});

test("zipBuffer 从磁盘路径打包", async () => {
	const p = path.join(tmp, "from-disk.png");
	fs.writeFileSync(p, Buffer.from("disk-data"));
	const zip = await zipBuffer([{ path: p }]);
	assert.equal(zip.readUInt32LE(0), 0x04034b50);
	// entry 名取 basename
	const nameLen = zip.readUInt16LE(26);
	assert.equal(zip.subarray(30, 30 + nameLen).toString("utf8"), "from-disk.png");
});
