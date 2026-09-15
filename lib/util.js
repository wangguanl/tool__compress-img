export const IMAGE_EXTS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".avif",
	".tif",
	".tiff",
	".gif",
]);

export function fmtKB(bytes) {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

export function savedPct(before, after) {
	const p = (1 - after / before) * 100;
	return `${p >= 0 ? "-" : "+"}${Math.abs(p).toFixed(1)}%`;
}

/** 解析 "WxH" */
export function parseSize(s) {
	const m = /^(\d+)x(\d+)$/.exec(String(s).trim());
	if (!m) throw new Error(`尺寸格式错误："${s}"，应为 800x600 形式`);
	return { width: Number(m[1]), height: Number(m[2]) };
}

/** 解析 "WxH+X+Y"（缺省偏移时居中裁剪） */
export function parseCrop(s) {
	const m = /^(\d+)x(\d+)(?:\+(\d+)\+(\d+))?$/.exec(String(s).trim());
	if (!m) throw new Error(`裁剪格式错误："${s}"，应为 300x200 或 300x200+10+20 形式`);
	return {
		width: Number(m[1]),
		height: Number(m[2]),
		left: m[3] != null ? Number(m[3]) : null,
		top: m[4] != null ? Number(m[4]) : null,
	};
}

/** 简单并发池：顺序领取任务，最多 limit 个同时执行 */
export async function pool(items, limit, fn) {
	let i = 0;
	const n = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: n }, async () => {
		while (i < items.length) {
			const item = items[i++];
			await fn(item);
		}
	});
	await Promise.all(workers);
}
