import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Sharp from "sharp";
import { startServer } from "../lib/server.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-adv-test-"));

const { server, port } = await startServer({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
process.on("exit", () => {
	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 1200x800 噪声照片
const noise = Buffer.alloc(1200 * 800 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
const PHOTO = await Sharp(noise, { raw: { width: 1200, height: 800, channels: 3 } })
	.jpeg({ quality: 100 })
	.toBuffer();
const PHOTO_PATH = path.join(tmp, "photo.jpg");
fs.writeFileSync(PHOTO_PATH, PHOTO);

async function postJson(p, obj) {
	return fetch(base + p, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(obj),
	});
}

test("旋转：90° 后宽高互换", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, rotate: 90 });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 800);
	assert.equal(data.height, 1200);
});

test("裁剪：居中 400x300", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, crop: "400x300" });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 400);
	assert.equal(data.height, 300);
});

test("缩放：等比到 600x600 以内", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, resize: "600x600" });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 600);
	assert.equal(data.height, 400);
});

test("文字水印：位置 + 不透明度", async () => {
	const res = await postJson("/api/compress-path", {
		path: PHOTO_PATH,
		watermark: { text: "© 测试水印", position: "northwest", opacity: 0.8 },
	});
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 1200); // 尺寸不变，只叠加
	assert.ok(data.afterBytes > 0);
});

test("比例裁剪：1:1 居中（1200x800 → 800x800）", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, crop: "1:1" });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 800);
	assert.equal(data.height, 800);
});

test("比例裁剪：16:9 横屏（1200x800 → 1200x675）", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, crop: "16:9" });
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 1200);
	assert.equal(data.height, 675);
});

test("比例裁剪：非法比例返回 400", async () => {
	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, crop: "x:y" });
	assert.equal(res.status, 400);
});

test("watermark 上传接口：合法图可暂存并被引用", async () => {
	const wmBuf = await Sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } } })
		.png()
		.toBuffer();
	const up = await fetch(`${base}/api/wm-upload?name=wm.png`, {
		method: "POST",
		headers: { "Content-Type": "image/png" },
		body: wmBuf,
	});
	assert.equal(up.status, 200);
	const { path: wmPath } = await up.json();
	assert.ok(/[\\/]wm-/.test(wmPath));

	const res = await postJson("/api/compress-path", { path: PHOTO_PATH, watermark: { img: wmPath, position: "center" } });
	assert.equal(res.status, 200);

	const bad = await fetch(`${base}/api/wm-upload?name=bad.txt`, {
		method: "POST",
		body: Buffer.from("not an image"),
	});
	assert.equal(bad.status, 415);
});

test("preview 接口：返回大尺寸 webp 预览图", async () => {
	const res = await fetch(`${base}/api/preview?path=${encodeURIComponent(PHOTO_PATH)}`);
	assert.equal(res.status, 200);
	const buf = Buffer.from(await res.arrayBuffer());
	const meta = await Sharp(buf).metadata();
	assert.equal(meta.format, "webp");
	assert.ok(meta.width <= 1400, "预览不超过 1400px");
});

test("图片水印（本地路径）", async () => {
	const wmPath = path.join(tmp, "wm.png");
	await Sharp({ create: { width: 100, height: 40, channels: 4, background: { r: 255, g: 80, b: 40, alpha: 0.9 } } })
		.png()
		.toFile(wmPath);

	const res = await postJson("/api/compress-path", {
		path: PHOTO_PATH,
		watermark: { img: wmPath, position: "center", opacity: 0.5 },
	});
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.equal(data.width, 1200);
});

test("组合：缩放 + 裁剪 + 旋转 + 水印", async () => {
	const res = await postJson("/api/compress-path", {
		path: PHOTO_PATH,
		resize: "800x800",
		crop: "400x400",
		rotate: 180,
		watermark: { text: "COMBO", position: "southeast" },
		quality: 80,
	});
	assert.equal(res.status, 200);
	const data = await res.json();
	// resize(800x533) → crop 400x400 → rotate 180 不变尺寸
	assert.equal(data.width, 400);
	assert.equal(data.height, 400);
});

test("keepMeta：保留元数据开关透传", async () => {
	// 原图带 EXIF
	const withMeta = await Sharp(PHOTO).withMetadata({ exif: { IFD0: { Copyright: "test-meta" } } }).toBuffer();
	const metaPath = path.join(tmp, "meta.jpg");
	fs.writeFileSync(metaPath, withMeta);

	const keep = await postJson("/api/compress-path", { path: metaPath, keepMeta: true }).then((r) => r.json());
	const strip = await postJson("/api/compress-path", { path: metaPath }).then((r) => r.json());

	const keepBuf = await fetch(base + keep.url).then((r) => r.arrayBuffer());
	const keepMeta = await Sharp(Buffer.from(keepBuf)).metadata();
	assert.ok(keepMeta.exif, "keepMeta=true 应保留 EXIF");

	const stripBuf = await fetch(base + strip.url).then((r) => r.arrayBuffer());
	const stripMeta = await Sharp(Buffer.from(stripBuf)).metadata();
	assert.ok(!stripMeta.exif, "默认应清除 EXIF");
});

test("非法参数：旋转值 / 裁剪格式 / 水印透明度", async () => {
	let res = await postJson("/api/compress-path", { path: PHOTO_PATH, rotate: 45 });
	assert.equal(res.status, 400);

	res = await postJson("/api/compress-path", { path: PHOTO_PATH, crop: "800" });
	assert.equal(res.status, 400);

	res = await postJson("/api/compress-path", { path: PHOTO_PATH, watermark: { text: "x", opacity: 2 } });
	assert.equal(res.status, 400);
});

test("拖拽模式 query 也能带高级参数（回归）", async () => {
	const q = new URLSearchParams({ name: "photo.jpg", crop: "300x300", rotate: "90" });
	const res = await fetch(`${base}/api/compress?${q}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: PHOTO,
	});
	assert.equal(res.status, 200);
	const data = await res.json();
	// crop 300x300 → rotate 90
	assert.equal(data.width, 300);
	assert.equal(data.height, 300);
});
