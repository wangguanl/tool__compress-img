import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Sharp from "sharp";
import { compressImage } from "./compress.js";
import { IMAGE_EXTS, parseSize } from "./util.js";
import { pipeZip } from "./zip.js";
import { pickFiles, pickFolder, scanDirImages } from "./picker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..", "web");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
};

const OUT_MIME = {
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	avif: "image/avif",
	tiff: "image/tiff",
	gif: "image/gif",
};

const FORMATS = new Set(["auto", "jpeg", "jpg", "png", "webp", "avif", "tiff", "gif"]);
const EXT_TO_FORMAT = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", avif: "avif", tif: "tiff", tiff: "tiff", gif: "gif" };

/** 静态文件白名单（防任意读取） */
const STATIC_FILES = new Map([
	["/", "index.html"],
	["/index.html", "index.html"],
	["/app.js", "app.js"],
	["/app.css", "app.css"],
]);

export function startServer({ port = 7788, host = "127.0.0.1", maxMB = 100, allowPick = true } = {}) {
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "compress-img-web-"));
	const results = new Map(); // id → { relPath, outName, absPath, beforeBytes, afterBytes, format, width, height }
	const seqRef = { n: 0 };

	/** 会话内唯一 id */
	function newId() {
		return `${Date.now().toString(36)}-${(seqRef.n++).toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	}

	const cleanup = () => {
		try {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			/* 尽力清理 */
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
			const route = `${req.method} ${url.pathname}`;

			if (req.method === "GET" && STATIC_FILES.has(url.pathname)) return serveStatic(res, STATIC_FILES.get(url.pathname));
			if (route === "POST /api/compress") return await apiCompress(req, res, url);
			if (route === "POST /api/compress-path") return await apiCompressPath(req, res);
			if (route === "POST /api/pick") return await apiPick(req, res, url);
			if (req.method === "GET" && url.pathname === "/api/thumb") return apiThumb(res, url);
			if (route === "POST /api/zip") return await apiZip(req, res);
			if (route === "POST /api/clear") return apiClear(res, results, sessionDir);
			if (req.method === "GET" && url.pathname.startsWith("/file/")) return fileDownload(res, url.pathname.slice(6), results);

			res.writeHead(404, jsonHeaders());
			res.end(JSON.stringify({ error: "接口不存在" }));
		} catch (err) {
			if (!res.headersSent) {
				res.writeHead(500, jsonHeaders());
			}
			res.end(JSON.stringify({ error: err.message || "服务器内部错误" }));
		}
	});

	/* ---------------- 静态 ---------------- */
	function serveStatic(res, relFile) {
		const abs = path.join(WEB_ROOT, relFile);
		// 双保险：拼接结果必须在 web/ 内
		if (!path.normalize(abs).startsWith(path.normalize(WEB_ROOT))) {
			res.writeHead(403).end();
			return;
		}
		fs.readFile(abs, (err, data) => {
			if (err) {
				res.writeHead(404).end("Not Found");
				return;
			}
			res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
			res.end(data);
		});
	}

	/* ---------------- 上传压缩（拖拽兜底） ---------------- */
	async function apiCompress(req, res, url) {
		const q = url.searchParams;
		const name = q.get("name") || "";
		if (!name) return sendErr(res, 400, "缺少文件名（name）");
		const ext0 = path.extname(name).toLowerCase().replace(".", "");
		if (!IMAGE_EXTS.has(`.${ext0}`)) return sendErr(res, 415, `不支持的图片类型：.${ext0 || "（无扩展名）"}`);
		const params = readParams(q);
		if (params.error) return sendErr(res, params.code, params.error);

		// 落盘中转：限长管道写入
		const ext = path.extname(name).toLowerCase().replace(".", "");
		const id = newId();
		const inFile = path.join(sessionDir, `in-${id}.${ext || "bin"}`);
		await pipeToFile(req, inFile, maxMB * 1024 * 1024, () => sendErr(res, 413, `文件超过上限 ${maxMB}MB`));

		try {
			const r = await compressToResult(id, inFile, name, q.get("relPath") || name, params);
			res.writeHead(200, jsonHeaders());
			res.end(JSON.stringify(r));
		} catch (err) {
			sendErr(res, 400, friendlyErr(err));
		} finally {
			fs.rm(inFile, { force: true }, () => {}); // 用完即删（中转临时文件）
		}
	}

	/* ---------------- 路径直读压缩（不经浏览器上传） ---------------- */
	async function apiCompressPath(req, res) {
		const body = await readBody(req, 1024 * 1024);
		let payload;
		try {
			payload = JSON.parse(body.toString("utf8"));
		} catch {
			return sendErr(res, 400, "请求体应为 JSON");
		}
		const { path: absPath, relPath } = payload || {};
		if (!absPath || typeof absPath !== "string") return sendErr(res, 400, "缺少路径（path）");

		const st = safeStat(absPath);
		if (!st || !st.isFile()) return sendErr(res, 404, `文件不存在：${absPath}`);

		const params = readParamsFromObj(payload);
		if (params.error) return sendErr(res, params.code, params.error);

		const id = newId();
		try {
			const name = path.basename(absPath);
			const r = await compressToResult(id, absPath, name, relPath || name, params);
			res.writeHead(200, jsonHeaders());
			res.end(JSON.stringify(r));
		} catch (err) {
			sendErr(res, 400, friendlyErr(err));
		}
		// 注意：直读模式绝不删除原文件
	}

	/* ---------------- 系统选择对话框 ---------------- */
	async function apiPick(req, res, url) {
		if (!allowPick) return sendErr(res, 403, "本服务未启用系统选择框（--no-pick）");
		const kind = url.searchParams.get("kind") === "folder" ? "folder" : "files";

		try {
			if (kind === "folder") {
				const dirs = await pickFolder();
				if (dirs.length === 0) {
					res.writeHead(200, jsonHeaders());
					res.end(JSON.stringify({ canceled: true, files: [] }));
					return;
				}
				const found = scanDirImages(dirs[0]);
				if (found.length === 0) {
					sendErr(res, 404, "所选文件夹中没有图片");
					return;
				}
				res.writeHead(200, jsonHeaders());
				res.end(JSON.stringify({ files: found }));
				return;
			}

			const files = await pickFiles({ multiple: true });
			if (files.length === 0) {
				res.writeHead(200, jsonHeaders());
				res.end(JSON.stringify({ canceled: true, files: [] }));
				return;
			}
			res.writeHead(200, jsonHeaders());
			res.end(
				JSON.stringify({
					files: files
						.filter((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase()))
						.map((absPath) => ({ absPath, relPath: path.basename(absPath) })),
				})
			);
		} catch (err) {
			sendErr(res, 500, `系统选择框不可用：${err.message}（可改用拖拽上传）`);
		}
	}

	/* ---------------- 缩略图（路径直读模式） ---------------- */
	async function apiThumb(res, url) {
		const p = url.searchParams.get("path") || "";
		const st = safeStat(p);
		if (!st || !st.isFile()) {
			sendErr(res, 404, "文件不存在");
			return;
		}
		try {
			const buf = await Sharp(p)
				.rotate()
				.resize(80, 80, { fit: "cover" })
				.webp({ quality: 60 })
				.toBuffer();
			res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": buf.length, "Cache-Control": "no-store" });
			res.end(buf);
		} catch {
			sendErr(res, 400, "无法生成缩略图");
		}
	}

	/* ---------------- 共享：路径/中转文件 → 压缩 → 结果登记 ---------------- */
	async function compressToResult(id, inputPath, name, relPath, params) {
		const { quality, format, resize, lossless } = params;
		const ext = path.extname(name).toLowerCase().replace(".", "");
		const outFormat = format === "auto" ? EXT_TO_FORMAT[ext] : format === "jpg" ? "jpeg" : format;
		const outExt = outFormat === "jpeg" ? "jpg" : outFormat;
		const outName = path.basename(name, path.extname(name)) + "." + outExt;
		const outFile = path.join(sessionDir, `out-${id}.${outExt}`);

		const r = await compressImage(inputPath, {
			output: outFile,
			overwrite: true,
			quality,
			format: outFormat,
			resize,
			lossless,
		});

		results.set(id, {
			relPath,
			outName,
			absPath: outFile,
			beforeBytes: r.beforeBytes,
			afterBytes: r.info.size,
			format: outFormat,
			width: r.info.width,
			height: r.info.height,
		});

		return {
			id,
			name,
			relPath,
			outName,
			beforeBytes: r.beforeBytes,
			afterBytes: r.info.size,
			format: outFormat,
			width: r.info.width,
			height: r.info.height,
			url: `/file/${id}`,
		};
	}

	/* ---------------- 单张下载 ---------------- */
	function fileDownload(res, id, map) {
		if (!/^[a-z0-9-]+$/i.test(id) || !map.has(id)) {
			res.writeHead(404, jsonHeaders());
			res.end(JSON.stringify({ error: "文件不存在或已清空" }));
			return;
		}
		const r = map.get(id);
		res.writeHead(200, {
			"Content-Type": OUT_MIME[r.format] || "application/octet-stream",
			"Content-Length": r.afterBytes,
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.outName)}`,
		});
		fs.createReadStream(r.absPath).pipe(res);
	}

	/* ---------------- ZIP ---------------- */
	async function apiZip(req, res) {
		const body = await readBody(req, 1024 * 1024);
		let ids;
		try {
			ids = JSON.parse(body.toString("utf8")).ids;
		} catch {
			return sendErr(res, 400, "请求体应为 JSON：{\"ids\": [...]}");
		}
		if (!Array.isArray(ids) || ids.length === 0) return sendErr(res, 400, "ids 不能为空");

		const files = [];
		for (const id of ids) {
			const r = results.get(String(id));
			if (r) files.push({ name: r.relPath || r.outName, path: r.absPath });
		}
		if (files.length === 0) return sendErr(res, 400, "没有可打包的结果");

		res.writeHead(200, {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="compressed-${dateStamp()}.zip"`,
		});
		await pipeZip(files, res);
		res.end();
	}

	/* ---------------- 清空 ---------------- */
	function apiClear(res, map, dir) {
		for (const r of map.values()) fs.rm(r.absPath, { force: true }, () => {});
		map.clear();
		fs.readdirSync(dir)
			.filter((f) => f.startsWith("in-"))
			.forEach((f) => fs.rm(path.join(dir, f), { force: true }, () => {}));
		res.writeHead(200, jsonHeaders());
		res.end(JSON.stringify({ ok: true }));
	}

	// 端口探测：preferred 起顺延，全占回落随机
	return new Promise((resolve) => {
		const attempt = (p, left) => {
			server.once("error", (err) => {
				if (err.code === "EADDRINUSE" && left > 0) attempt(p + 1, left - 1);
				else if (err.code === "EADDRINUSE") attempt(0, 0);
				else throw err;
			});
			server.listen(p, host, () => resolve({ server, port: server.address().port, host, sessionDir }));
		};
		const preferred = Number(port) || 7788;
		attempt(preferred, 20);
	});
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function jsonHeaders() {
	return { "Content-Type": "application/json; charset=utf-8" };
}

function sendErr(res, code, msg) {
	res.writeHead(code, jsonHeaders());
	res.end(JSON.stringify({ error: msg }));
}

/** query 参数 → 校验后的压缩参数 */
function readParams(q) {
	return readParamsFromObj({
		quality: q.get("quality"),
		format: q.get("format"),
		resize: q.get("resize"),
		lossless: q.get("lossless"),
	});
}

function readParamsFromObj({ quality, format, resize: resizeStr, lossless }) {
	const out = {
		quality: quality != null && quality !== "" ? Number(quality) : 75,
		format: String(format || "auto").toLowerCase(),
		lossless: lossless === "1" || lossless === true,
		resize: undefined,
	};
	if (!(out.quality >= 1 && out.quality <= 100)) return { error: "质量必须在 1-100 之间", code: 400 };
	if (!FORMATS.has(out.format)) return { error: `不支持的格式：${out.format}`, code: 400 };
	if (resizeStr) {
		try {
			out.resize = parseSize(resizeStr);
		} catch {
			return { error: "resize 格式应为 WxH", code: 400 };
		}
	}
	return out;
}

function friendlyErr(err) {
	return /unsupported image format|Input buffer contains/i.test(err.message)
		? "不是有效的图片文件"
		: err.message || "压缩失败";
}

function safeStat(p) {
	try {
		return fs.statSync(p);
	} catch {
		return null;
	}
}

/** 请求体管道落盘，超限回调并销毁连接 */
function pipeToFile(req, filePath, limit, onOver) {
	return new Promise((resolve, reject) => {
		const ws = fs.createWriteStream(filePath);
		let size = 0;
		let over = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				over = true;
				req.destroy();
				ws.destroy();
				fs.rm(filePath, { force: true }, () => {});
				onOver();
				reject(new Error("over-limit"));
			}
		});
		req.on("error", (err) => {
			if (!over) {
				ws.destroy();
				reject(err);
			}
		});
		req.pipe(ws);
		ws.on("finish", () => !over && resolve());
		ws.on("error", (err) => {
			if (!over) {
				ws.destroy();
				reject(err);
			}
		});
	});
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				req.destroy();
				reject(new Error("请求体过大"));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function dateStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
