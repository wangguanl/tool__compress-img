import Sharp from "sharp";
import fs from "node:fs";

const GRAVITY = {
	northwest: "northwest",
	north: "north",
	northeast: "northeast",
	west: "west",
	center: "centre",
	centre: "centre",
	east: "east",
	southwest: "southwest",
	south: "south",
	southeast: "southeast",
};

/**
 * 核心压缩管线（单文件）
 *
 * @param {string} input 输入文件路径
 * @param {object} opts
 * @param {string} [opts.output]        输出文件路径（不传则返回 Buffer，不写盘）
 * @param {number} [opts.quality=75]    压缩质量 1-100
 * @param {number} [opts.effort]        编码努力程度，jpeg/png 0-100（默认：jpeg 10=libvips 默认，png 7，avif 4）
 * @param {number} [opts.rotate]        附加旋转角度（0/90/180/270，叠加在 EXIF 自动矫正之上）
 * @param {object} [opts.crop]          {width, height, left, top}，left/top 为 null 时居中
 * @param {object} [opts.resize]        {width, height} 等比缩放到指定尺寸内（fit: inside）
 * @param {string} [opts.format]        强制输出格式（jpg/jpeg/png/webp/avif/tiff/gif）
 * @param {object} [opts.watermark]     水印配置 {text | path, position, opacity, fontSize, color, margin }
 * @param {boolean} [opts.lossless]     无损压缩（png 恒定，仅对 jpg/webp/avif 生效）
 * @param {boolean} [opts.progressive]  渐进式（jpeg/png）或无损模式（webp/avif），对齐旧版 compress.js 的 double-meaning
 * @param {boolean} [opts.stripMeta=true] 是否清除 EXIF/GPS 等元数据（保留版权、 orientation 前置应用）
 * @param {boolean} [opts.overwrite=false] 输出已存在时是否覆盖
 * @returns {Promise<{data: Buffer, info: import("sharp").OutputInfo, bytesSaved: number}>}
 */
export async function compressImage(input, opts = {}) {
	const {
		output,
		quality = 75,
		effort,
		rotate = 0,
		crop,
		resize,
		format,
		watermark,
		lossless = false,
		progressive = false,
		stripMeta = true,
		overwrite = false,
	} = opts;

	// 1) 元数据决定输出格式：未显式指定 format 时保持原格式
	const meta = await Sharp(input).metadata();
	const inBytes = await fs.promises.stat(input).then((s) => s.size).catch(() => 0);
	const outFormat = normalizeFormat(format || meta.format);

	// 2) 管线：读入 → EXIF 矫正 → 显式旋转 → 裁剪 → 缩放 → 编码
	let pipe = Sharp(input, { failOn: "none" }).rotate(); // rotate() 无参 = 按 EXIF 方向自动摆正
	if (rotate) pipe = pipe.rotate(rotate, { background: "#ffffff" });

	if (crop) {
		const { width, height, left, top } = crop;
		if (left == null || top == null) {
			pipe = pipe.resize(width, height, { fit: "cover", position: "centre" });
		} else {
			pipe = pipe.extract({ width, height, left, top });
		}
	}
	if (resize) pipe = pipe.resize(resize.width, resize.height, { fit: "inside", withoutEnlargement: true });

	// 3) 水印合成（在编码前完成，支持文字与图片两种）
	if (watermark) pipe = await applyWatermark(pipe, watermark, meta);

	// 4) 编码参数
	const encoderOpts = buildEncoderOpts(outFormat, {
		quality,
		effort,
		lossless,
		progressive,
		stripMeta,
	});

	let target = pipe[outFormat](encoderOpts);

	// 5) 元数据处理：withMetadata 保留 ICC/版权，其余清除
	if (!stripMeta) target = target.withMetadata();

	// 6) 输出
	if (output) {
		if (!overwrite && exists(output)) {
			throw new Error(`输出已存在（--overwrite 可覆盖）：${output}`);
		}
		const info = await target.toFile(output);
		return {
			data: null,
			info: normalizeInfo(info, outFormat),
			bytesSaved: inBytes - info.size,
			beforeBytes: inBytes,
		};
	}
	const { data, info } = await target.toBuffer({ resolveWithObject: true });
	return {
		data,
		info: normalizeInfo(info, outFormat),
		bytesSaved: inBytes - data.length,
		beforeBytes: inBytes,
	};
}

/** sharp 输出 avif 时 info.format 报告为 heif，统一归一化 */
function normalizeInfo(info, outFormat) {
	return { ...info, format: outFormat };
}

function normalizeFormat(f) {
	const s = String(f || "").toLowerCase();
	if (s === "jpg") return "jpeg";
	if (["jpeg", "png", "webp", "avif", "tiff", "gif", "heif"].includes(s)) return s;
	throw new Error(`不支持的格式：${f}`);
}

function buildEncoderOpts(format, { quality, effort, lossless, progressive, stripMeta }) {
	switch (format) {
		case "jpeg":
			return {
				quality,
				progressive,
				mozjpeg: true, // 对齐 TinyPNG 级别的 JPEG 压缩质量
				chromaSubsampling: "4:2:0",
			};
		case "png": {
			// pngquant 式调色板量化（TinyPNG 同原理）：quality<100 时启用
			const usePalette = quality < 100;
			return {
				compressionLevel: 9,
				effort: clamp(effort ?? 7, 1, 10),
				palette: usePalette,
				...(usePalette ? { quality: clamp(quality, 0, 100) } : {}),
				colours: 256,
			};
		}
		case "webp":
			return {
				quality,
				effort: clamp(effort ?? 4, 0, 6),
				lossless,
				smartSubsample: true,
			};
		case "avif":
			return {
				quality,
				effort: clamp(effort ?? 4, 1, 9),
				lossless,
			};
		case "tiff":
			return { quality, compression: "lzw" };
		case "gif":
			return { quality };
		default:
			return { quality };
	}
}

/**
 * 水印：文字水印用 SVG 合成（跟随宿主图尺寸自适应字号），图片水印用 composite
 */
async function applyWatermark(pipe, watermark, meta) {
	const { position = "southeast", opacity = 0.6, fontSize = 24, color = "rgba(255,255,255,0.9)", margin = 12, text, path } = watermark;

	if (!text && !path) throw new Error("水印需要 --wm-text 或 --wm-img");

	const gravityMap = {
		northwest: "northwest",
		north: "north",
		northeast: "northeast",
		west: "west",
		center: "centre",
		centre: "centre",
		east: "east",
		southwest: "southwest",
		south: "south",
		southeast: "southeast",
	};
	const gravity = gravityMap[String(position).toLowerCase()] || "southeast";

	let wmInput;
	if (text) {
		// 文字水印：生成透明 SVG，字号随图片宽度自适应（上限 fontSize）
		const imgW = meta.width || 1200;
		const size = Math.min(fontSize, Math.max(14, Math.round(imgW / 18)));
		const fontPx = size;
		// 估算文本宽度（中文按 1em、ASCII 按 0.55em）
		const textW = Math.ceil(
			[...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0) * fontPx
		);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${textW + 8}" height="${fontPx * 1.6}" viewBox="0 0 ${textW + 8} ${fontPx * 1.6}">
  <text x="4" y="${fontPx * 1.1}" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" font-size="${fontPx}" fill="${color}" fill-opacity="${opacity}">${escapeXml(text)}</text>
</svg>`;
		wmInput = { input: Buffer.from(svg), gravity, blend: "over" };
	} else {
		// 图片水印：读取 → 统一 RGBA → 逐字节乘透明度（仅小图适用）
		const { data, info } = await Sharp(path)
			.ensureAlpha()
			.toColourspace("srgb")
			.raw()
			.toBuffer({ resolveWithObject: true });
		for (let i = 3; i < data.length; i += 4) {
			data[i] = Math.round(data[i] * opacity);
		}
		wmInput = {
			input: data,
			raw: { width: info.width, height: info.height, channels: 4 },
			gravity,
			blend: "over",
		};
	}
	return pipe.composite([wmInput]);
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, Number(n) || 0));
}

function exists(p) {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}
