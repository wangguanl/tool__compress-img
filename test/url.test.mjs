import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Sharp from "sharp";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compress-img-url-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

/** 造一张 800x600 带噪声的真实 JPEG（噪声让压缩率真实） */
const noise = Buffer.alloc(800 * 600 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
const PHOTO = await Sharp(noise, { raw: { width: 800, height: 600, channels: 3 } })
	.jpeg({ quality: 100 })
	.toBuffer();

/** 本地 HTTP 服务（避免外网依赖） */
function serve(routes) {
	const server = http.createServer((req, res) => {
		const key = req.url.split("?")[0];
		const route = routes[key];
		if (!route) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		res.writeHead(200, { "content-type": route.type });
		res.end(route.data);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function runCli(args, opts = {}) {
	try {
		const { stdout, stderr } = await execFileAsync("node", [cli, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code, stdout: err.stdout || "", stderr: err.stderr || "" };
	}
}

test("URL 输入：默认输出 <name>.min.<ext> 到当前目录", async () => {
	const server = await serve({ "/photo.jpg": { type: "image/jpeg", data: PHOTO } });
	const port = server.address().port;
	const cwd = fs.mkdirSync(path.join(tmp, "t1"), { recursive: true });

	const { code, stdout } = await runCli([`http://127.0.0.1:${port}/photo.jpg`, "-q", "60"], { cwd });
	assert.equal(code, 0);
	assert.match(stdout, /来源/);

	const out = path.join(cwd, "photo.min.jpg");
	assert.ok(fs.existsSync(out), "应输出 photo.min.jpg 到当前目录");
	const after = fs.statSync(out).size;
	assert.ok(after < PHOTO.length, `压缩后 ${after} 应小于 ${PHOTO.length}`);
	server.close();
});

test("URL 输入：--out-dir 指定输出目录", async () => {
	const server = await serve({ "/photo.jpg": { type: "image/jpeg", data: PHOTO } });
	const port = server.address().port;
	const outDir = path.join(tmp, "t2", "dist");

	const { code } = await runCli([`http://127.0.0.1:${port}/photo.jpg`, "--out-dir", outDir, "-q", "75"]);
	assert.equal(code, 0);
	assert.ok(fs.existsSync(path.join(outDir, "photo.jpg")));
	server.close();
});

test("URL 输入：-o 输出路径 + 转格式 webp", async () => {
	const server = await serve({ "/img": { type: "image/jpeg", data: PHOTO } }); // 无扩展名 URL
	const port = server.address().port;
	const outFile = path.join(tmp, "t3", "from-url.webp");

	const { code } = await runCli([
		`http://127.0.0.1:${port}/img`,
		"-o",
		outFile,
		"--format",
		"webp",
		"-q",
		"70",
	]);
	assert.equal(code, 0);
	const meta = await Sharp(outFile).metadata();
	assert.equal(meta.format, "webp");
	server.close();
});

test("URL 404：退出码 1，无残留输出", async () => {
	const server = await serve({});
	const port = server.address().port;
	const cwd = fs.mkdirSync(path.join(tmp, "t4"), { recursive: true });

	const { code, stderr } = await runCli([`http://127.0.0.1:${port}/nope.jpg`], { cwd });
	assert.equal(code, 1);
	assert.match(stderr, /下载失败.*HTTP 404/);
	assert.equal(fs.readdirSync(cwd).length, 0, "失败时不应留下输出文件");
	server.close();
});

test("多个 URL：一张 404 不影响其他，退出码 1", async () => {
	const server = await serve({
		"/a.jpg": { type: "image/jpeg", data: PHOTO },
		"/b.png": { type: "image/png", data: await Sharp(PHOTO).png().toBuffer() },
	});
	const port = server.address().port;
	const outDir = path.join(tmp, "t5", "dist");

	const { code, stderr } = await runCli(
		[
			`http://127.0.0.1:${port}/a.jpg`,
			`http://127.0.0.1:${port}/404.jpg`,
			`http://127.0.0.1:${port}/b.png`,
			"--out-dir",
			outDir,
		],
		{ cwd: tmp }
	);
	assert.equal(code, 1);
	assert.match(stderr, /HTTP 404/);
	assert.ok(fs.existsSync(path.join(outDir, "a.jpg")));
	assert.ok(fs.existsSync(path.join(outDir, "b.png")));
	server.close();
});

test("URL 与本地文件混用", async () => {
	const server = await serve({ "/c.jpg": { type: "image/jpeg", data: PHOTO } });
	const port = server.address().port;
	const local = path.join(tmp, "local.jpg");
	await Sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).jpeg().toFile(local);
	const outDir = path.join(tmp, "t6", "dist");

	const { code } = await runCli(
		[`http://127.0.0.1:${port}/c.jpg`, local, "--out-dir", outDir],
		{ cwd: tmp }
	);
	assert.equal(code, 0);
	assert.ok(fs.existsSync(path.join(outDir, "c.jpg")));
	assert.ok(fs.existsSync(path.join(outDir, "local.jpg")));
	server.close();
});
