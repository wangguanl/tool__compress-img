import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Sharp from "sharp";
import { startServer } from "../lib/server.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-url-test-"));

const { server, port } = await startServer({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
process.on("exit", () => {
	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 造噪声照片
const noise = Buffer.alloc(800 * 600 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
const PHOTO = await Sharp(noise, { raw: { width: 800, height: 600, channels: 3 } })
	.jpeg({ quality: 100 })
	.toBuffer();

/** 本地 HTTP 图片服务（模拟远程图床，无外网依赖） */
function serve(routes) {
	const s = http.createServer((req, res) => {
		const route = routes[req.url.split("?")[0]];
		if (!route) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		res.writeHead(200, { "content-type": route.type });
		res.end(route.data);
	});
	return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

async function postJson(p, obj) {
	return fetch(base + p, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(obj),
	});
}

test("URL 压缩：下载 → 压缩 → 体积下降 + sourceUrl 回传", async () => {
	const s = await serve({ "/photo.jpg": { type: "image/jpeg", data: PHOTO } });
	const u = `http://127.0.0.1:${s.address().port}/photo.jpg`;

	const res = await postJson("/api/compress-url", { url: u, quality: 75 });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.ok(data.afterBytes < data.beforeBytes, `after(${data.afterBytes}) < before(${data.beforeBytes})`);
	assert.equal(data.format, "jpeg");
	assert.equal(data.name, "photo.jpg");
	assert.equal(data.sourceUrl, u);
	assert.match(data.url, /^\/file\//);

	// 下载结果可解码
	const r2 = await fetch(base + data.url);
	assert.equal(r2.status, 200);
	const meta = await Sharp(Buffer.from(await r2.arrayBuffer())).metadata();
	assert.equal(meta.format, "jpeg");
	s.close();
});

test("URL + 格式转换 webp", async () => {
	const s = await serve({ "/pic": { type: "image/jpeg", data: PHOTO } }); // 无扩展名
	const res = await postJson("/api/compress-url", {
		url: `http://127.0.0.1:${s.address().port}/pic`,
		quality: 80,
		format: "webp",
	});
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.format, "webp");
	assert.equal(data.outName.endsWith(".webp"), true);
	s.close();
});

test("URL 404：返回 502 与中文错误", async () => {
	const s = await serve({});
	const res = await postJson("/api/compress-url", { url: `http://127.0.0.1:${s.address().port}/nope.jpg` });
	assert.equal(res.status, 502);
	assert.match((await res.json()).error, /下载失败/);
	s.close();
});

test("非法 URL：400", async () => {
	let res = await postJson("/api/compress-url", { url: "ftp://example.com/a.jpg" });
	assert.equal(res.status, 400);

	res = await postJson("/api/compress-url", {});
	assert.equal(res.status, 400);
});

test("URL 结果可进 ZIP", async () => {
	const s = await serve({ "/z.jpg": { type: "image/jpeg", data: PHOTO } });
	const r1 = await postJson("/api/compress-url", { url: `http://127.0.0.1:${s.address().port}/z.jpg` });
	const { id } = await r1.json();

	const r2 = await postJson("/api/zip", { ids: [id] });
	assert.equal(r2.status, 200);
	const zip = Buffer.from(await r2.arrayBuffer());
	assert.equal(zip.readUInt32LE(0), 0x04034b50);
	s.close();
});
