import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Sharp from "sharp";
import { startServer } from "../lib/server.js";
import { scanDirImages } from "../lib/picker.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-path-test-"));

const { server, port } = await startServer({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
process.on("exit", () => {
	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 造测试图：a.jpg + sub/b.png（带子目录）
fs.mkdirSync(path.join(tmp, "src", "sub"), { recursive: true });
async function makePhoto(p, w = 800, h = 600) {
	const noise = Buffer.alloc(w * h * 3);
	for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
	await Sharp(noise, { raw: { width: w, height: h, channels: 3 } })
		.jpeg({ quality: 100 })
		.toFile(p);
}
await makePhoto(path.join(tmp, "src", "a.jpg"));
await makePhoto(path.join(tmp, "src", "sub", "b.jpg"), 400, 300);

async function post(p, body, headers = {}) {
	return fetch(base + p, { method: "POST", body, headers });
}

test("scanDirImages：递归扫描 + 相对路径 + size", () => {
	const found = scanDirImages(path.join(tmp, "src"));
	assert.equal(found.length, 2);
	const rels = found.map((f) => f.relPath).sort();
	assert.deepEqual(rels, ["a.jpg", "sub/b.jpg"]);
	assert.ok(found.every((f) => f.size > 0 && path.isAbsolute(f.absPath)));
});

test("路径直读压缩：不经上传、体积下降、元信息完整", async () => {
	const absPath = path.join(tmp, "src", "a.jpg");
	const beforeStat = fs.statSync(absPath);

	const res = await post(
		"/api/compress-path",
		JSON.stringify({ path: absPath, quality: 75 }),
		{ "Content-Type": "application/json" }
	);
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.ok(data.afterBytes < data.beforeBytes);
	assert.equal(data.format, "jpeg");
	assert.equal(data.name, "a.jpg");
	assert.match(data.url, /^\/file\//);

	// 关键断言：原文件必须原封不动
	const afterStat = fs.statSync(absPath);
	assert.equal(afterStat.size, beforeStat.size, "原文件大小不得改变");
	assert.ok(afterStat.size > 0, "原文件必须仍然存在");
});

test("路径直读 + 格式转换 webp + 自定义 relPath", async () => {
	const absPath = path.join(tmp, "src", "sub", "b.jpg");
	const res = await post(
		"/api/compress-path",
		JSON.stringify({ path: absPath, relPath: "自定义/目录/b.jpg", quality: 80, format: "webp" }),
		{ "Content-Type": "application/json" }
	);
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.format, "webp");
	assert.equal(data.outName, "b.webp");
	assert.equal(data.relPath, "自定义/目录/b.jpg");
	// 原文件还在
	assert.ok(fs.existsSync(absPath));
});

test("路径直读：文件不存在 404、缺 path 400、坏文件 400", async () => {
	let res = await post("/api/compress-path", JSON.stringify({ path: "/no/such/file.jpg" }), { "Content-Type": "application/json" });
	assert.equal(res.status, 404);

	res = await post("/api/compress-path", JSON.stringify({}), { "Content-Type": "application/json" });
	assert.equal(res.status, 400);

	const bad = path.join(tmp, "bad.jpg");
	fs.writeFileSync(bad, "not an image at all");
	res = await post("/api/compress-path", JSON.stringify({ path: bad }), { "Content-Type": "application/json" });
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /不是有效的图片/);
	// 坏文件也不该被删
	assert.ok(fs.existsSync(bad));
});

test("缩略图接口：返回 webp 图片", async () => {
	const absPath = path.join(tmp, "src", "a.jpg");
	const res = await fetch(`${base}/api/thumb?path=${encodeURIComponent(absPath)}`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/webp");
	const meta = await Sharp(Buffer.from(await res.arrayBuffer())).metadata();
	assert.equal(meta.format, "webp");
});

test("路径直读结果可下载且可进 ZIP", async () => {
	const absPath = path.join(tmp, "src", "a.jpg");
	const r1 = await post("/api/compress-path", JSON.stringify({ path: absPath }), { "Content-Type": "application/json" });
	const { id, url } = await r1.json();

	// 单张下载
	const r2 = await fetch(base + url);
	assert.equal(r2.status, 200);

	// ZIP
	const r3 = await post("/api/zip", JSON.stringify({ ids: [id] }), { "Content-Type": "application/json" });
	assert.equal(r3.status, 200);
	const zip = Buffer.from(await r3.arrayBuffer());
	assert.equal(zip.readUInt32LE(0), 0x04034b50);
});

test("上传模式（拖拽兜底）仍然可用：回归", async () => {
	const buf = fs.readFileSync(path.join(tmp, "src", "a.jpg"));
	const q = new URLSearchParams({ name: "a.jpg", quality: "75" });
	const res = await post(`/api/compress?${q}`, buf);
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.ok(data.afterBytes < data.beforeBytes);
});
