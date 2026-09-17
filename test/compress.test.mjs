import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Sharp from "sharp";
import { compressImage } from "@wgl-m/compress";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compress-img-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// 造一张 1200x800 带噪声的照片（噪声让压缩率真实）
const PHOTO = path.join(tmp, "photo.jpg");
const noise = Buffer.alloc(1200 * 800 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
await Sharp(noise, { raw: { width: 1200, height: 800, channels: 3 } })
	.jpeg({ quality: 100 })
	.toFile(PHOTO);

// 造一张带 alpha 的 PNG（水印/格式转换用）
const PNG_ALPHA = path.join(tmp, "alpha.png");
await Sharp({
	create: { width: 400, height: 300, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 0.5 } },
})
	.png()
	.toFile(PNG_ALPHA);

test("基础压缩：默认 q75，体积应明显下降", async () => {
	const out = path.join(tmp, "basic.jpg");
	const r = await compressImage(PHOTO, { output: out });
	assert.ok(fs.existsSync(out));
	assert.ok(r.info.size < r.beforeBytes * 0.5, `压缩后 ${r.info.size} 应远小于 ${r.beforeBytes}`);
	assert.equal(r.info.format, "jpeg");
});

test("质量参数：q30 比 q90 更小", async () => {
	const out30 = path.join(tmp, "q30.jpg");
	const out90 = path.join(tmp, "q90.jpg");
	await compressImage(PHOTO, { output: out30, quality: 30 });
	await compressImage(PHOTO, { output: out90, quality: 90 });
	const s30 = fs.statSync(out30).size;
	const s90 = fs.statSync(out90).size;
	assert.ok(s30 < s90, `q30(${s30}) 应小于 q90(${s90})`);
});

test("格式转换：jpg → webp / avif / png", async () => {
	for (const fmt of ["webp", "avif", "png"]) {
		const out = path.join(tmp, `conv.${fmt}`);
		const r = await compressImage(PHOTO, { output: out, format: fmt });
		assert.equal(r.info.format, fmt);
		assert.ok(fs.existsSync(out));
	}
});

test("缩放：1200x800 → 600x400 以内", async () => {
	const out = path.join(tmp, "resized.jpg");
	await compressImage(PHOTO, { output: out, resize: { width: 600, height: 600 } });
	const meta = await Sharp(out).metadata();
	assert.equal(meta.width, 600);
	assert.equal(meta.height, 400);
});

test("裁剪：居中 400x400 与指定偏移 400x300+100+50", async () => {
	const out1 = path.join(tmp, "crop-center.jpg");
	await compressImage(PHOTO, { output: out1, crop: { width: 400, height: 400 } });
	const m1 = await Sharp(out1).metadata();
	assert.equal(m1.width, 400);
	assert.equal(m1.height, 400);

	const out2 = path.join(tmp, "crop-offset.jpg");
	await compressImage(PHOTO, { output: out2, crop: { width: 400, height: 300, left: 100, top: 50 } });
	const m2 = await Sharp(out2).metadata();
	assert.equal(m2.width, 400);
	assert.equal(m2.height, 300);
});

test("旋转：90° 后宽高互换", async () => {
	const out = path.join(tmp, "rotated.jpg");
	await compressImage(PHOTO, { output: out, rotate: 90 });
	const meta = await Sharp(out).metadata();
	assert.equal(meta.width, 800);
	assert.equal(meta.height, 1200);
});

test("文字水印：输出存在且可解码，尺寸不变", async () => {
	const out = path.join(tmp, "wm-text.jpg");
	const r = await compressImage(PHOTO, {
		output: out,
		watermark: { text: "© 2026 测试水印", position: "southeast", opacity: 0.8 },
	});
	const meta = await Sharp(out).metadata();
	assert.equal(meta.width, 1200);
	assert.equal(meta.height, 800);
	assert.ok(r.info.size > 0);
});

test("图片水印：PNG 水印叠加到照片上", async () => {
	const out = path.join(tmp, "wm-img.jpg");
	await compressImage(PHOTO, {
		output: out,
		watermark: { path: PNG_ALPHA, position: "center", opacity: 0.5 },
	});
	const meta = await Sharp(out).metadata();
	assert.equal(meta.width, 1200);
	assert.equal(meta.height, 800);
});

test("PNG 调色板量化：q75 时应显著变小", async () => {
	const out = path.join(tmp, "quant.png");
	const r = await compressImage(PNG_ALPHA, { output: out, quality: 75 });
	assert.equal(r.info.format, "png");
	assert.ok(r.info.size < r.beforeBytes);
});

test("不覆盖保护：输出已存在时报错", async () => {
	const out = path.join(tmp, "exists.jpg");
	await compressImage(PHOTO, { output: out });
	await assert.rejects(() => compressImage(PHOTO, { output: out }), /已存在/);
	await compressImage(PHOTO, { output: out, overwrite: true }); // overwrite 放行
});

test("Buffer 模式：不传 output 返回 Buffer", async () => {
	const r = await compressImage(PHOTO, {});
	assert.ok(Buffer.isBuffer(r.data));
	assert.ok(r.data.length > 0);
});

test("无损 webp：与原图解像素一致（或极接近）", async () => {
	const out = path.join(tmp, "lossless.webp");
	await compressImage(PHOTO, { output: out, format: "webp", lossless: true });
	const a = await Sharp(PHOTO).raw().toBuffer();
	const b = await Sharp(out).raw().toBuffer();
	// JPEG 源 → webp 无损，字节应完全一致
	assert.equal(Buffer.compare(a, b), 0);
});
