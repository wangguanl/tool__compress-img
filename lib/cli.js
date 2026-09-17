import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IMAGE_EXTS, fmtKB, savedPct, parseSize, parseCrop, pool } from "./util.js";
import { compressImage } from "@wgl-m/compress";
import { downloadImage } from "@wgl-m/down-img";

const isUrl = (s) => /^https?:\/\//i.test(s);

export async function run(argv) {
	const { args, opts } = parseArgs(argv);

	// 无参数 / --help：打印帮助
	if (opts.help || args.length === 0) {
		printHelp();
		return;
	}

	const cfg = buildConfig(opts);

	// 多输入时 -o（单文件输出路径）无法逐个对应
	if (args.length > 1 && opts.output)
		throw new Error("多个输入不能使用 -o（单文件输出路径），请改用 --out-dir");

	// 支持一次传多个输入：本地文件/目录 与 http(s) URL 可混用
	for (const arg of args) {
		if (isUrl(arg)) {
			await runFromUrl(arg, cfg, opts);
			continue;
		}
		const input = path.resolve(arg);
		const stat = safeStat(input);
		if (stat && stat.isFile()) {
			await runSingleFile(input, cfg, opts);
		} else if (stat && stat.isDirectory()) {
			await runDirectory(input, cfg, opts);
		} else {
			throw new Error(`输入不存在：${input}\n用法：compress-img <文件|目录|URL> [选项]（--help 查看全部）`);
		}
	}
}

/* ------------------------------------------------------------------ */
/* URL 模式：down-img 下载到临时目录 → 单文件压缩 → 清理临时文件          */
/* ------------------------------------------------------------------ */
async function runFromUrl(url, cfg, opts) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compress-img-url-"));
	let dl;
	try {
		dl = await downloadImage(url, { output: tmpDir, overwrite: true, retries: 1 });
	} catch (err) {
		console.error(`  ✗ ${url} — 下载失败：${err.message}`);
		process.exitCode = 1;
		fs.rmSync(tmpDir, { recursive: true, force: true });
		return;
	}

	const name = path.basename(dl.path);
	let outFile;
	if (cfg.outputDir) {
		fs.mkdirSync(cfg.outputDir, { recursive: true });
		outFile = path.join(cfg.outputDir, name);
	} else if (opts.output) {
		outFile = path.resolve(opts.output);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
	} else {
		// 默认输出到当前目录：<name>.min.<ext>（不落在会被删除的临时目录里）
		const ext = path.extname(name);
		const outExt = cfg.format ? `.${cfg.format === "jpg" ? "jpg" : cfg.format}` : ext;
		outFile = path.join(process.cwd(), `${path.basename(name, ext)}.min${outExt}`);
	}

	try {
		const r = await compressImage(dl.path, { ...cfg, output: outFile, overwrite: opts.overwrite });
		console.log(`▸ 来源：${url}`);
		logLine(name, r.beforeBytes, r.info.size);
		printSummary(1, 1, 0, r.beforeBytes, r.info.size);
	} catch (err) {
		console.error(`  ✗ ${url} — ${err.message}`);
		process.exitCode = 1;
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true }); // 临时原图即用即删
	}
}

/* ------------------------------------------------------------------ */
/* 目录模式：递归扫描 → 并发压缩 → 保留相对目录结构                      */
/* ------------------------------------------------------------------ */
async function runDirectory(dir, cfg, opts) {
	const files = [];
	const walk = (d) => {
		for (const name of fs.readdirSync(d)) {
			const full = path.join(d, name);
			const st = fs.statSync(full);
			if (st.isDirectory()) walk(full);
			else if (IMAGE_EXTS.has(path.extname(name).toLowerCase())) files.push(full);
		}
	};
	walk(dir);

	if (files.length === 0) {
		console.log(`目录 ${dir} 中没有图片（支持 ${[...IMAGE_EXTS].join(" ")}）`);
		return;
	}

	const outDir = cfg.outputDir || path.join(dir, "compressed");
	console.log(`▸ 输入：${dir}`);
	console.log(`▸ 输出：${outDir}${cfg.outputDir ? "" : "（默认 <输入>/compressed）"}`);
	console.log(`▸ 模式：${describeMode(cfg)}\n`);

	let ok = 0, fail = 0, totalBefore = 0, totalAfter = 0;
	const concurrency = opts.concurrency || 8;

	await pool(files, concurrency, async (file) => {
		const rel = path.relative(dir, file);
		const outFile = path.join(outDir, rel);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		try {
			const r = await compressImage(file, { ...cfg, output: outFile, overwrite: true });
			ok++;
			totalBefore += r.beforeBytes;
			totalAfter += r.info.size;
			logLine(rel, r.beforeBytes, r.info.size);
		} catch (err) {
			fail++;
			console.error(`  ✗ ${rel} — ${err.message}`);
		}
	});

	printSummary(files.length, ok, fail, totalBefore, totalAfter);
}

/* ------------------------------------------------------------------ */
/* 单文件模式                                                          */
/* ------------------------------------------------------------------ */
async function runSingleFile(file, cfg, opts) {
	let outFile;
	if (cfg.outputDir) {
		fs.mkdirSync(cfg.outputDir, { recursive: true });
		outFile = path.join(cfg.outputDir, path.basename(file));
	} else if (opts.output) {
		outFile = path.resolve(opts.output);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
	} else {
		outFile = defaultOutFile(file, cfg);
	}
	const r = await compressImage(file, { ...cfg, output: outFile, overwrite: opts.overwrite });
	logLine(path.basename(file), r.beforeBytes, r.info.size);
	printSummary(1, 1, 0, r.beforeBytes, r.info.size);
}

function defaultOutFile(file, cfg) {
	const dir = path.dirname(file);
	const ext = path.extname(file);
	const base = path.basename(file, ext);
	const outExt = cfg.format ? `.${cfg.format === "jpg" ? "jpg" : cfg.format}` : ext;
	return path.join(dir, `${base}.min${outExt}`);
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */
const SHORT_OPTS = new Set(["q", "o", "f", "h"]);

function parseArgs(argv) {
	const args = [];
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq === -1) {
				// --key value 或 --flag
				const key = camelize(a.slice(2));
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					opts[key] = next;
					i++;
				} else {
					opts[key] = true;
				}
			} else {
				opts[camelize(a.slice(2, eq))] = a.slice(eq + 1);
			}
		} else if (a.startsWith("-") && a.length === 2 && SHORT_OPTS.has(a[1])) {
			// 短选项：-q value / -o value / -f value / -h
			const key = { q: "quality", o: "output", f: "format", h: "help" }[a[1]];
			const next = argv[i + 1];
			if (key === "help") {
				opts.help = true;
			} else if (next !== undefined && !next.startsWith("-")) {
				opts[key] = next;
				i++;
			} else {
				opts[key] = true;
			}
		} else {
			args.push(a);
		}
	}
	return { args, opts };
}

function camelize(k) {
	return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function buildConfig(opts) {
	const cfg = {
		quality: opts.quality ? Number(opts.quality) : undefined,
		effort: opts.effort ? Number(opts.effort) : undefined,
		rotate: opts.rotate ? Number(opts.rotate) : undefined,
		format: opts.format,
		outputDir: opts.outDir ? path.resolve(opts.outDir) : undefined,
		lossless: opts.lossless === true,
		progressive: opts.progressive === true,
		stripMeta: opts.keepMeta !== true,
	};
	if (opts.crop) cfg.crop = parseCrop(opts.crop);
	if (opts.resize) cfg.resize = parseSize(opts.resize);
	if (opts.wmText || opts.wmImg) {
		cfg.watermark = {
			text: opts.wmText,
			path: opts.wmImg ? path.resolve(opts.wmImg) : undefined,
			position: opts.wmPos || "southeast",
			opacity: opts.wmOpacity != null ? Number(opts.wmOpacity) : 0.6,
			fontSize: opts.wmSize != null ? Number(opts.wmSize) : 24,
			margin: 12,
		};
	}
	// 校验
	if (cfg.quality != null && (cfg.quality < 1 || cfg.quality > 100))
		throw new Error("质量范围 1-100");
	if (cfg.rotate && ![0, 90, 180, 270].includes(cfg.rotate))
		throw new Error("旋转角度仅支持 0/90/180/270");
	if (cfg.watermark?.path && !fs.existsSync(cfg.watermark.path))
		throw new Error(`水印图不存在：${cfg.watermark.path}`);
	if (opts.concurrency != null && (!(Number(opts.concurrency) >= 1) || Number(opts.concurrency) > 64))
		throw new Error("并发数范围 1-64");
	return cfg;
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
function logLine(name, before, after) {
	const pct = savedPct(before, after);
	const sign = before - after >= 0 ? "↓" : "↑";
	console.log(`  ✓ ${name}  ${fmtKB(before)} → ${fmtKB(after)}  (${sign}${pct})`);
}

function printSummary(total, ok, fail, before, after) {
	console.log("");
	if (ok > 0) {
		const pct = ((1 - after / before) * 100).toFixed(1);
		console.log(`Σ ${ok}/${total} 张成功，共 ${fmtKB(before)} → ${fmtKB(after)}（省 ${pct}%）`);
	}
	if (fail > 0) console.log(`! ${fail} 张失败（见上方 ✗ 行）`);
}

function describeMode(cfg) {
	const parts = [];
	if (cfg.format) parts.push(`转格式 ${cfg.format}`);
	parts.push(cfg.lossless ? "无损" : `质量 ${cfg.quality ?? 75}`);
	if (cfg.rotate) parts.push(`旋转 ${cfg.rotate}°`);
	if (cfg.crop) parts.push(`裁剪 ${cfg.crop.width}x${cfg.crop.height}`);
	if (cfg.resize) parts.push(`缩放 ${cfg.resize.width}x${cfg.resize.height}`);
	if (cfg.watermark) parts.push(cfg.watermark.text ? `文字水印" ${cfg.watermark.text} "` : "图片水印");
	if (cfg.stripMeta === false) parts.push("保留元数据");
	return parts.join("，");
}

function printHelp() {
	console.log(`compress-img — 本地批量图片压缩（sharp 驱动，无联网、无次数限制）

用法
  compress-img <文件|目录|URL> [选项]
  compress-img <输入...> [选项]          多个输入可混用（本地路径 + http(s) URL）

输入
  本地文件 / 目录：递归扫描目录下所有图片（jpg/jpeg/png/webp/avif/tif/tiff/gif），保留子目录结构
  http(s) URL：经 down-img 下载到临时目录 → 压缩 → 只保留压缩结果（临时原图即用即删）

主要选项
  -q,  --quality <1-100>     压缩质量，默认 75（png<100 时自动走调色板量化）
  -o,  --out <文件>          单文件输出的目标路径（仅单文件模式）
       --out-dir <目录>      目录模式输出目录（默认 <输入>/compressed）
  -f,  --format <格式>       转换格式：jpg png webp avif tiff gif
       --resize <WxH>        等比缩放到 WxH 以内（不放大）
       --crop <WxH[+X+Y]>    裁剪（不带偏移则居中裁剪）
       --rotate <0|90|180|270>  旋转（EXIF 方向自动矫正始终开启）
       --lossless            无损压缩（png 恒定无损；作用于 jpg/webp/avif）
       --progressive         渐进式 jpeg/png
       --wm-text <文字>      文字水印
       --wm-img <图片>       图片水印
       --wm-pos <位置>       水印位置：northwest/north/northeast/west/center/
                             east/southwest/south/southeast，默认 southeast
       --wm-opacity <0-1>    水印不透明度，默认 0.6
       --wm-size <px>        文字水印字号（自动随图宽自适应，此为上限），默认 24
       --keep-meta           保留 EXIF/GPS 等元数据（默认清除）
       --concurrency <1-64>  并发数，默认 8
       --overwrite           覆盖已存在的输出文件
  -h,  --help                显示本帮助

示例
  compress-img ./images
  compress-img photo.jpg -q 80
  compress-img ./images --out-dir ./dist -q 80 --format webp
  compress-img photo.jpg --crop 800x600 --wm-text "© 2026" --wm-pos southeast
  compress-img ./photos --resize 1920x1080 --format avif
  compress-img https://example.com/photo.jpg -q 80
  compress-img https://a.com/1.png https://a.com/2.png --out-dir ./dist
`);
}

function safeStat(p) {
	try {
		return fs.statSync(p);
	} catch {
		return null;
	}
}
