import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Sharp from "sharp";
import { startServer } from "../lib/server.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-test-"));

const { server, port } = await startServer({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
process.on("exit", () => {
	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 造一张 800x600 噪声 jpg
async function makePhoto(name = "photo.jpg") {
	const p = path.join(tmp, name);
	const noise = Buffer.alloc(800 * 600 * 3);
	for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
	await Sharp(noise, { raw: { width: 800, height: 600, channels: 3 } })
		.jpeg({ quality: 100 })
		.toFile(p);
	return p;
}

async function post(pathname, body, headers = {}) {
	return fetch(base + pathname, { method: "POST", body, headers });
}

test("静态页：GET / 返回 HTML", async () => {
	const res = await fetch(base + "/");
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.match(html, /图片压缩/);
});

test("压缩接口：上传 jpg → 体积下降、返回元信息", async () => {
	const p = await makePhoto();
	const buf = fs.readFileSync(p);
	const q = new URLSearchParams({ name: "photo.jpg", relPath: "photos/photo.jpg", quality: "75" });
	const res = await post(`/api/compress?${q}`, buf);
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.ok(data.afterBytes < data.beforeBytes, `after(${data.afterBytes}) < before(${data.beforeBytes})`);
	assert.equal(data.format, "jpeg");
	assert.equal(data.width, 800);
	assert.equal(data.name, "photo.jpg");
	assert.match(data.url, /^\/file\//);
});

test("格式转换：format=webp 返回 webp", async () => {
	const p = await makePhoto("w.jpg");
	const q = new URLSearchParams({ name: "w.jpg", quality: "75", format: "webp" });
	const res = await post(`/api/compress?${q}`, fs.readFileSync(p));
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.format, "webp");
	assert.equal(data.outName, "w.webp");
});

test("单张下载：200 + Content-Type + 可被 sharp 解码", async () => {
	const p = await makePhoto("d.jpg");
	const q = new URLSearchParams({ name: "d.jpg" });
	const res1 = await post(`/api/compress?${q}`, fs.readFileSync(p));
	const { url } = await res1.json();

	const res2 = await fetch(base + url);
	assert.equal(res2.status, 200);
	assert.match(res2.headers.get("content-type"), /^image\//);
	assert.match(res2.headers.get("content-disposition"), /attachment/);
	// 内容可解码
	const buf = Buffer.from(await res2.arrayBuffer());
	const meta = await Sharp(buf).metadata();
	assert.equal(meta.format, "jpeg");
});

test("ZIP 打包：签名 PK + 条目结构", async () => {
	const p1 = await makePhoto("z1.jpg");
	const p2 = await makePhoto("z2.jpg");
	const ids = [];
	for (const n of ["z1.jpg", "z2.jpg"]) {
		const r = await post(`/api/compress?${new URLSearchParams({ name: n, relPath: `子目录/${n}` })}`, fs.readFileSync(path.join(tmp, n)));
		ids.push((await r.json()).id);
	}

	const res = await post("/api/zip", JSON.stringify({ ids }), { "Content-Type": "application/json" });
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type"), /zip/);
	const zip = Buffer.from(await res.arrayBuffer());
	assert.equal(zip.readUInt32LE(0), 0x04034b50); // PK\x03\x04
	assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD
	assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2); // 2 条
});

test("坏文件：伪装 jpg 返回 4xx 与中文错误", async () => {
	const q = new URLSearchParams({ name: "fake.jpg" });
	const res = await post(`/api/compress?${q}`, "this is not an image, just plain text bytes");
	assert.ok(res.status >= 400 && res.status < 500, `status=${res.status}`);
	const data = await res.json();
	assert.ok(data.error, "应有 error 字段");
});

test("参数校验：缺 name / 非法 quality / 不支持扩展名", async () => {
	let res = await post(`/api/compress`, Buffer.alloc(10));
	assert.equal(res.status, 400);

	res = await post(`/api/compress?${new URLSearchParams({ name: "a.jpg", quality: "999" })}`, Buffer.alloc(10));
	assert.equal(res.status, 400);

	res = await post(`/api/compress?${new URLSearchParams({ name: "a.txt" })}`, Buffer.alloc(10));
	assert.equal(res.status, 415);
});

test("clear：清空后下载 404", async () => {
	const p = await makePhoto("c.jpg");
	const r = await post(`/api/compress?${new URLSearchParams({ name: "c.jpg" })}`, fs.readFileSync(p));
	const { url } = await r.json();

	const res = await post("/api/clear", "");
	assert.equal(res.status, 200);

	const res2 = await fetch(base + url);
	assert.equal(res2.status, 404);
});

test("未知路径 404", async () => {
	const res = await fetch(base + "/api/nothing");
	assert.equal(res.status, 404);
});
