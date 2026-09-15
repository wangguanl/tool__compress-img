#!/usr/bin/env node
/**
 * 目录模式冒烟测试：造样本目录 → 跑 CLI → 校验输出结构
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Sharp from "sharp";

const root = path.resolve(process.cwd());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compress-img-smoke-"));
const srcDir = path.join(tmp, "images");

// 造多级目录样本：images/a.jpg, images/sub/b.png, images/sub/c.webp, images/ignore.txt
fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true });
const noise = (w, h) => {
	const buf = Buffer.alloc(w * h * 3);
	for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
	return Sharp(buf, { raw: { width: w, height: h, channels: 3 } });
};
await noise(800, 600).jpeg({ quality: 100 }).toFile(path.join(srcDir, "a.jpg"));
await noise(300, 300).png().toFile(path.join(srcDir, "sub", "b.png"));
await noise(500, 400).webp().toFile(path.join(srcDir, "sub", "c.webp"));
fs.writeFileSync(path.join(srcDir, "ignore.txt"), "not an image");

const outDir = path.join(tmp, "out");

// 跑 CLI
const cli = path.join(root, "bin", "cli.js");
console.log("=== 目录模式：递归压缩 ===");
execFileSync("node", [cli, srcDir, "--out-dir", outDir, "-q", "75"], { stdio: "inherit" });

// 校验结构
const expect = ["a.jpg", path.join("sub", "b.png"), path.join("sub", "c.webp")];
for (const rel of expect) {
	const p = path.join(outDir, rel);
	assert(fs.existsSync(p), `缺少输出：${rel}`);
}
assert(!fs.existsSync(path.join(outDir, "ignore.txt")), "非图片不应被处理");
console.log("\n=== 结构校验通过：目录结构保留、非图片跳过 ===");

// 单文件 + 功能组合冒烟
console.log("\n=== 单文件：crop + 文字水印 + 格式转换 ===");
execFileSync("node", [cli, path.join(srcDir, "a.jpg"), "-o", path.join(tmp, "combo.webp"), "--crop", "300x300", "--wm-text", "SMOKE", "--format", "webp"], { stdio: "inherit" });
const meta = await Sharp(path.join(tmp, "combo.webp")).metadata();
assert(meta.format === "webp" && meta.width === 300 && meta.height === 300, "crop+format 组合失败");
console.log("=== 组合校验通过 ===");

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n冒烟测试全部通过 ✔");

function assert(cond, msg) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exit(1);
	}
}
