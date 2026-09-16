/* compress-img Web UI — vanilla JS，无构建、无框架
 * 两种输入模式：
 *   path  — 系统选择框（服务端弹原生对话框），压缩直读本地路径，不经浏览器
 *   upload — 拖拽（浏览器 File 对象，走上传中转，兜底方案）
 */
const $ = (id) => document.getElementById(id);

const els = {
	dropzone: $("dropzone"),
	fileInput: $("fileInput"),
	dirInput: $("dirInput"),
	pickFiles: $("pickFiles"),
	pickDir: $("pickDir"),
	pickFallback: $("pickFallback"),
	pickFilesFallback: $("pickFilesFallback"),
	pickDirFallback: $("pickDirFallback"),
	urlInput: $("urlInput"),
	addUrlBtn: $("addUrlBtn"),
	advToggle: $("advToggle"),
	advPanel: $("advPanel"),
	advReset: $("advReset"),
	resizeChips: $("resizeChips"),
	resizeCustom: $("resizeCustom"),
	cropRatioChips: $("cropRatioChips"),
	cropCustom: $("cropCustom"),
	rotateChips: $("rotateChips"),
	wmTextInput: $("wmTextInput"),
	wmImgInput: $("wmImgInput"),
	wmPickBtn: $("wmPickBtn"),
	wmClearBtn: $("wmClearBtn"),
	wmFileInput: $("wmFileInput"),
	wmPosInput: $("wmPosInput"),
	wmOpacityInput: $("wmOpacityInput"),
	wmOpacityVal: $("wmOpacityVal"),
	wmPendingList: $("wmPendingList"),
	losslessInput: $("losslessInput"),
	keepMetaInput: $("keepMetaInput"),
	startBtn: $("startBtn"),
	quality: $("quality"),
	qualityVal: $("qualityVal"),
	format: $("format"),
	resultArea: $("resultArea"),
	summaryText: $("summaryText"),
	zipBtn: $("zipBtn"),
	clearBtn: $("clearBtn"),
	list: $("list"),
};

// 高级设置状态：chips 选中值 + 自定义覆盖（优先级：自定义 > chip）
const adv = {
	resize: "", // 最长边数字字符串，"" = 不缩放
	cropRatio: "", // 比例如 "1:1"，"" = 不裁剪
	cropCustom: "",
	rotate: 0,
	wm: null, // { text | remoteImg | sessionPath }
};

const IMAGE_RE = /\.(jpe?g|png|webp|avif|tiff?|gif)$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const items = []; // { key, mode: 'path'|'upload'|'url', absPath?, file?, url?, size, relPath, status, result?, error?, params?, row?, thumbUrl? }
let keySeq = 0;
let running = 0;
const CONCURRENCY = 3;
let pickAvailable = true;

/* ---------------- 参数 ---------------- */
function snapshotParams() {
	const p = { quality: Number(els.quality.value), format: els.format.value };

	// 最长边单值 → "Nx1"（fit inside 等比，Wx1 表示最大宽 N、高度不约束）
	if (adv.resize) p.resize = `${adv.resize}x1`;

	const crop = adv.cropCustom.trim() ? adv.cropCustom.trim() : adv.cropRatio;
	if (crop) p.crop = crop;

	if (adv.rotate) p.rotate = adv.rotate;

	if (adv.wm) {
		p.watermark = {
			position: els.wmPosInput.value,
			opacity: Number(els.wmOpacityInput.value),
			text: adv.wm.text || undefined,
			img: adv.wm.remoteImg || adv.wm.sessionPath || undefined,
		};
		// 首选文字水印；只发其中一个，避免同时传
		if (adv.wm.text === undefined) delete p.watermark.text;
		if (adv.wm.remoteImg === undefined && adv.wm.sessionPath === undefined) delete p.watermark.img;
	}

	if (els.losslessInput.checked) p.lossless = true;
	if (els.keepMetaInput.checked) p.keepMeta = true;

	return p;
}

/** 校验高级参数，返回错误消息或 null */
function validateParams(p) {
	if (p.resize && !/^\d+x\d+$/.test(p.resize)) return `缩放格式应为 WxH，如 1920x1080`;
	if (p.crop && !/^(\d+:\d+|\d+x\d+(\+\d+\+\d+)?)$/.test(p.crop)) return `裁剪格式应为 W:H 或 WxH 或 WxH+X+Y`;
	if (p.watermark && !adv.wm) return `水印配置无效`;
	if (adv.wm == null && (els.wmImgInput.value.trim() || els.wmTextInput.value.trim())) return `文字/图片水印未成功选择`;
	return null;
}

/** 行内参数摘要（标注当前用了哪些高级项） */
function paramsSummary(p) {
	const parts = [`q${p.quality}`];
	if (p.format !== "auto") parts.push(p.format);
	if (p.resize) parts.push(`缩放≤${p.resize.split("x")[0]}`);
	if (p.crop) parts.push(p.crop.includes(":") ? `裁剪${p.crop}` : `裁剪${p.crop}`);
	if (p.rotate) parts.push(`旋转${p.rotate}°`);
	if (p.watermark) parts.push(p.watermark.text ? `水印"${p.watermark.text}"` : "图片水印");
	if (p.lossless) parts.push("无损");
	if (p.keepMeta) parts.push("留元数据");
	return parts.join(" · ");
}

/* ---------- 高级面板交互 ---------- */
// chips 单选组
function chipGroup(el) {
	el.addEventListener("click", (e) => {
		const btn = e.target.closest(".chip");
		if (!btn) return;
		el.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-on"));
		btn.classList.add("is-on");
		syncAdvState();
	});
}
function chipValue(group) {
	const on = els[group].querySelector(".chip.is-on");
	return on ? on.dataset.v : "";
}
function syncAdvState() {
	adv.resize = els.resizeCustom.value.trim() || chipValue("resizeChips");
	adv.cropRatio = els.cropCustom.value.trim() ? "" : chipValue("cropRatioChips");
	adv.cropCustom = els.cropCustom.value.trim();
	adv.rotate = Number(chipValue("rotateChips")) || 0;
	renderWmUi();
}
els.resizeCustom.addEventListener("input", syncAdvState);
els.cropCustom.addEventListener("input", syncAdvState);
chipGroup(els.resizeChips);
chipGroup(els.cropRatioChips);
chipGroup(els.rotateChips);

els.quality.addEventListener("input", () => (els.qualityVal.textContent = els.quality.value));
els.wmOpacityInput.addEventListener("input", () => (els.wmOpacityVal.textContent = els.wmOpacityInput.value));

/* 高级面板开关 */
els.advToggle.addEventListener("click", () => {
	const open = els.advPanel.hidden;
	els.advPanel.hidden = !open;
	els.advToggle.setAttribute("aria-expanded", String(open));
	els.advToggle.textContent = open ? "高级设置 ▴" : "高级设置 ▾";
});

/* 恢复默认：重置 chips/输入/水印 */
els.advReset.addEventListener("click", () => {
	els.resizeCustom.value = "";
	els.cropCustom.value = "";
	els.wmTextInput.value = "";
	els.wmImgInput.value = "";
	adv.resize = "";
	adv.cropRatio = "";
	adv.cropCustom = "";
	adv.rotate = 0;
	adv.wm = null;
	document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c.dataset.v === ""));
	els.wmPosInput.value = "southeast";
	els.wmOpacityInput.value = "0.6";
	els.wmOpacityVal.textContent = "0.6";
	els.losslessInput.checked = false;
	els.keepMetaInput.checked = false;
	renderWmUi();
});

/* ---------- 水印输入 ---------- */
function renderWmUi() {
	// 已填写的会话水印图（来自 wm-upload）放入待办列表
	const stashed = advWmSessionPaths();
	els.wmPendingList.replaceChildren(...stashed.map((p) => {
		const li = document.createElement("li");
		li.textContent = selectedWmLabel(p);
		li.dataset.tmp = "1";
		return li;
	}));
	if (adv.wm) {
		if (adv.wm.text) els.wmTextInput.value = adv.wm.text;
		else if (adv.wm.remoteImg) els.wmImgInput.value = adv.wm.remoteImg;
	}
}
function advWmSessionPaths() {
	// 维护一个会话内已上传水印图的模块级数组
	return advSessionWm;
}
const advSessionWm = [];
function selectedWmLabel(p) {
	return `已上传水印图：${p.split(/[\\/]/).pop()}（将作用于所有图）`;
}
els.wmPickBtn.addEventListener("click", () => els.wmFileInput.click());
els.wmFileInput.addEventListener("change", async () => {
	const f = els.wmFileInput.files && els.wmFileInput.files[0];
	if (f) await uploadWmFile(f);
	els.wmFileInput.value = "";
});
async function uploadWmFile(file) {
	const q = new URLSearchParams({ name: file.name });
	const res = await fetch(`/api/wm-upload?${q}`, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!res.ok) {
		alert((await res.json().catch(() => ({ error: "上传失败" }))).error);
		return;
	}
	const d = await res.json();
	adv.wm = { sessionPath: d.path };
	els.wmTextInput.value = "";
	els.wmImgInput.value = d.path;
	advSessionWm.push(d.path);
	renderWmUi();
}
els.wmClearBtn.addEventListener("click", () => {
	adv.wm = null;
	els.wmTextInput.value = "";
	els.wmImgInput.value = "";
	renderWmUi();
});

// 手动输入文字/远程图片水印：实时追踪
els.wmTextInput.addEventListener("input", () => {
	const t = els.wmTextInput.value.trim();
	if (t) {
		adv.wm = { text: t };
		els.wmImgInput.value = "";
	} else if (adv.wm && !adv.wm.sessionPath && !adv.wm.remoteImg && !els.wmImgInput.value.trim()) {
		adv.wm = null;
	}
});
els.wmImgInput.addEventListener("input", () => {
	const v = els.wmImgInput.value.trim();
	if (/^https?:\/\//i.test(v)) {
		adv.wm = { remoteImg: v };
		els.wmTextInput.value = "";
	} else if (v === "" && adv.wm && !adv.wm.sessionPath) {
		adv.wm = null;
	}
});

/* ---------------- URL 添加（远程图片） ---------------- */
function addUrls() {
	const raw = els.urlInput.value.trim();
	if (!raw) return;
	const urls = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
	const bad = urls.filter((u) => !URL_RE.test(u));
	const good = urls.filter((u) => URL_RE.test(u));

	let added = 0;
	for (const url of good) {
		if (items.some((it) => it.url === url)) continue;
		const name = urlName(url);
		items.push({ key: `k${keySeq++}`, mode: "url", url, relPath: name, size: 0, status: "queued" });
		added++;
	}
	if (added) {
		renderAll();
		showResult();
	}
	if (bad.length) alert(`以下不是合法的 http(s) 链接，已跳过：\n${bad.join("\n")}`);
	els.urlInput.value = "";
}

/** 从 URL 提取显示名：去 query/hash，取路径末段；无末段时用整个 URL 短名 */
function urlName(url) {
	try {
		const u = new URL(url);
		let last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
		last = last.replace(/[\\/:*?"<>|]/g, "_");
		return last || `${u.hostname}.jpg`;
	} catch {
		return "image.jpg";
	}
}

els.addUrlBtn.addEventListener("click", addUrls);
els.urlInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		addUrls();
	}
});

/* ---------------- 系统选择框（路径直读） ---------------- */
async function systemPick(kind) {
	els.pickFiles.disabled = true;
	els.pickDir.disabled = true;
	setPickText("等待选择…");
	try {
		const res = await fetch(`/api/pick?kind=${kind}`, { method: "POST" });
		// 服务不可达（服务已退出/端口换了）— 不判死，提示重启
		if (res.status === 404) {
			alert("服务版本过旧（无选择框接口）：请重启 npm run web 后刷新页面");
			return;
		}
		const data = await res.json();
		if (!res.ok) {
			// 服务端明确拒绝（--no-pick / Linux 无 zenity）：降级并提示
			pickAvailable = false;
			els.pickFallback.hidden = false;
			alert(data.error || "选择失败");
			return;
		}
		if (data.canceled) return; // 用户取消，静默
		addPathItems(data.files || []);
	} catch (err) {
		// 网络层失败：服务可能已退出，提示重启而非只让改用拖拽
		pickAvailable = false;
		els.pickFallback.hidden = false;
		alert(`无法连接本地服务（可能已退出）：请重新运行 npm run web 并刷新页面。也可改用拖拽。`);
		void err;
	} finally {
		els.pickFiles.disabled = false;
		els.pickDir.disabled = false;
		setPickText(null);
	}
}

function setPickText(t) {
	els.pickFiles.textContent = t || "选择文件…";
	els.pickDir.textContent = t || "选择文件夹…";
}

els.pickFiles.addEventListener("click", () => systemPick("files"));
els.pickDir.addEventListener("click", () => systemPick("folder"));

/* 浏览器原生选择（系统选择框不可用时的降级） */
els.pickFilesFallback.addEventListener("click", () => els.fileInput.click());
els.pickDirFallback.addEventListener("click", () => els.dirInput.click());

els.fileInput.addEventListener("change", () => {
	addUploadItems([...els.fileInput.files].map((f) => ({ file: f, relPath: f.name })));
	els.fileInput.value = "";
});
els.dirInput.addEventListener("change", () => {
	addUploadItems(
		[...els.dirInput.files]
			.filter((f) => IMAGE_RE.test(f.name))
			.map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name }))
	);
	els.dirInput.value = "";
});

/* ---------------- 拖拽（上传兜底） ---------------- */
els.dropzone.addEventListener("dragover", (e) => {
	e.preventDefault();
	els.dropzone.classList.add("dragover");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
els.dropzone.addEventListener("drop", async (e) => {
	e.preventDefault();
	els.dropzone.classList.remove("dragover");

	const entries = [...(e.dataTransfer.items || [])]
		.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
		.filter(Boolean);

	if (entries.length === 0) {
		addUploadItems([...e.dataTransfer.files].map((f) => ({ file: f, relPath: f.name })));
		return;
	}
	const out = [];
	for (const entry of entries) await scanEntry(entry, "", out);
	addUploadItems(out);
});

async function scanEntry(entry, base, out) {
	if (entry.isFile) {
		const file = await new Promise((r) => entry.file(r));
		if (IMAGE_RE.test(file.name)) out.push({ file, relPath: base + entry.name });
	} else if (entry.isDirectory) {
		const reader = entry.createReader();
		let batch;
		do {
			batch = await new Promise((r) => reader.readEntries(r, () => (batch = [])));
			for (const e of batch) await scanEntry(e, base + entry.name + "/", out);
		} while (batch.length);
	}
}

/* ---------------- 列表管理 ---------------- */
function addPathItems(files) {
	let added = 0;
	for (const { absPath, relPath, size } of files) {
		const st = size ?? 0;
		if (items.some((it) => it.absPath === absPath)) continue;
		items.push({ key: `k${keySeq++}`, mode: "path", absPath, relPath, size: st, status: "queued" });
		added++;
	}
	if (added) {
		renderAll();
		showResult();
	}
}

function addUploadItems(entries) {
	let added = 0;
	for (const { file, relPath } of entries) {
		if (!IMAGE_RE.test(relPath)) continue;
		if (items.some((it) => it.file === file)) continue;
		items.push({ key: `k${keySeq++}`, mode: "upload", file, relPath, size: file.size, status: "queued" });
		added++;
	}
	if (added) {
		renderAll();
		showResult();
	}
}

function showResult() {
	els.resultArea.hidden = false;
	updateSummary();
}

function renderAll() {
	const frag = document.createDocumentFragment();
	for (const it of items) {
		if (!it.row) it.row = buildRow(it);
		frag.appendChild(it.row);
	}
	els.list.replaceChildren(frag);
	updateSummary();
}

function buildRow(it) {
	const li = document.createElement("li");
	li.className = "row";
	li.dataset.key = it.key;
	paintRow(li, it);
	return li;
}

function paintRow(li, it) {
	const { status, result, error } = it;
	const params = it.params || {};
	// 完成项用压缩结果图做缩略图，可点击放大预览
	let thumb = it.thumbUrl
		? `<img class="thumb" src="${it.thumbUrl}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-placeholder',textContent:'✕'}))" />`
		: `<div class="thumb-placeholder">${extOf(it.relPath) || "?"}</div>`;
	if (status === "done" && result) {
		thumb = `<button type="button" class="thumb-btn" data-act="preview" title="点击对比原图"><img class="thumb" src="${result.url}" alt="" loading="lazy" /></button>`;
	}

	let ratio = `<span class="ratio pending">—</span>`;
	let sizes = `<span class="sizes">${it.size ? fmt(it.size) : "—"}</span>`;
	let act = "";

	if (status === "queued") {
		ratio = `<span class="ratio pending">${it.mode === "url" ? "待下载" : "待处理"}</span>`;
		act = `<button data-act="remove">移除</button>`;
	} else if (status === "running") {
		ratio = `<span class="ratio pending">${it.mode === "url" ? "下载并压缩中…" : "压缩中…"}</span>`;
	} else if (status === "done" && result) {
		const pct = (1 - result.afterBytes / result.beforeBytes) * 100;
		const down = pct >= 0;
		ratio = `<span class="ratio ${down ? "" : "bad"}">${down ? "↓" : "↑"}${Math.abs(pct).toFixed(1)}%</span>`;
		sizes = `<span class="sizes">${fmt(result.beforeBytes)} → <b>${fmt(result.afterBytes)}</b></span>`;
		act = `<a href="${result.url}" download="${esc(result.outName)}">下载</a><button data-act="redo">重压</button>`;
	} else if (status === "failed") {
		ratio = `<span class="ratio bad">失败</span>`;
		act = `<button data-act="redo">重试</button><button data-act="remove">移除</button>`;
	}

	const subParts = [
		`${it.size ? fmt(it.size) : "—"} · ${extOf(it.relPath).toUpperCase() || "URL"}${modeLabel(it.mode)}`,
	];
	if (status === "running") subParts.push(paramsSummary(params));
	if (status === "done" && result) subParts.push(paramsSummary(params));
	if (status === "failed" && error) subParts.push(`<span class="err-msg">${esc(error)}</span>`);

	li.innerHTML = `
		${thumb}
		<div class="name">
			<div class="name-main" title="${esc(it.relPath)}">${esc(it.relPath)}</div>
			<div class="name-sub">${subParts.join(" · ")}</div>
		</div>
		${sizes}
		${ratio}
		<div class="act">${act}</div>`;
	li.classList.toggle("failed", status === "failed");
}

function updateSummary() {
	const total = items.length;
	const done = items.filter((i) => i.status === "done");
	const failed = items.filter((i) => i.status === "failed");
	const pending = items.filter((i) => i.status === "queued" || i.status === "running");

	if (total === 0) {
		els.summaryText.textContent = "—";
		els.zipBtn.disabled = true;
		els.startBtn.disabled = true;
		return;
	}

	let text;
	if (done.length > 0) {
		const b = done.reduce((s, i) => s + i.result.beforeBytes, 0);
		const a = done.reduce((s, i) => s + i.result.afterBytes, 0);
		const pct = ((1 - a / b) * 100).toFixed(1);
		text = `<b>${done.length}</b>/${total} 张完成 · ${fmt(b)} → <b>${fmt(a)}</b>（省 ${pct}%）`;
	} else {
		text = `共 <b>${total}</b> 张待处理`;
	}
	if (pending.length) text += ` · ${pending.length} 张进行中`;
	if (failed.length) text += ` · <span style="color:var(--red)">${failed.length} 张失败</span>`;
	els.summaryText.innerHTML = text;

	els.zipBtn.disabled = done.length === 0;
	els.startBtn.disabled = items.every((i) => i.status !== "queued");
}

/* 行内事件委托 */
els.list.addEventListener("click", (e) => {
	const btn = e.target.closest("button[data-act]");
	if (!btn) return;
	const li = btn.closest(".row");
	const it = items.find((i) => i.key === li.dataset.key);
	if (!it) return;

	if (btn.dataset.act === "remove") {
		if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
		items.splice(items.indexOf(it), 1);
		li.remove();
		updateSummary();
	} else if (btn.dataset.act === "redo") {
		it.status = "queued";
		it.error = null;
		paintRow(li, it);
		updateSummary();
		pump();
	} else if (btn.dataset.act === "preview") {
		openPreview(it);
	}
});

/* ---------------- 前后对比预览 ---------------- */
function sourcePreviewUrl(it) {
	if (it.mode === "path") return `/api/preview?path=${encodeURIComponent(it.absPath)}`;
	if (it.mode === "url") return it.url;
	return it.thumbUrl || "";
}
function openPreview(it) {
	const r = it.result;
	if (!r) return;
	els.previewLayer.hidden = false;
	document.body.style.overflow = "hidden";
	els.previewBeforeImg.src = sourcePreviewUrl(it) || "";
	els.previewAfterImg.src = r.url;
	els.previewName.textContent = it.relPath;
	els.previewBeforeMeta.textContent = fmt(r.beforeBytes);
	els.previewAfterMeta.textContent = `${fmt(r.afterBytes)} (${r.width}×${r.height})`;
	let saved = "";
	if (r.beforeBytes > 0) {
		const pct = ((1 - r.afterBytes / r.beforeBytes) * 100).toFixed(1);
		saved = pct >= 0 ? `省 ${pct}%` : `增 +${(-pct).toFixed(1)}%`;
	}
	els.previewVerdict.textContent = saved;
}
function initPreview() {
	els.previewLayer = document.getElementById("previewLayer");
	if (!els.previewLayer) return; // 元素尚未就绪（可能用旧缓存 HTML）——静默跳过，刷新后生效
	els.previewBeforeImg = document.getElementById("pBeforeImg");
	els.previewAfterImg = document.getElementById("pAfterImg");
	els.previewName = document.getElementById("pName");
	els.previewBeforeMeta = document.getElementById("pBeforeMeta");
	els.previewAfterMeta = document.getElementById("pAfterMeta");
	els.previewVerdict = document.getElementById("pVerdict");
	document.getElementById("pClose").addEventListener("click", closePreview);
	els.previewLayer.addEventListener("click", (e) => {
		if (e.target === els.previewLayer) closePreview();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !els.previewLayer.hidden) closePreview();
	});
}
function closePreview() {
	els.previewLayer.hidden = true;
	document.body.style.overflow = "";
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPreview);
else initPreview();

/* ---------------- 压缩队列 ---------------- */
els.startBtn.addEventListener("click", () => {
	const probe = snapshotParams();
	const err = validateParams(probe);
	if (err) {
		alert(`参数有误：${err}`);
		els.advPanel.hidden = false; // 自动展开方便修改
		return;
	}
	pump();
});

function pump() {
	const queue = items.filter((i) => i.status === "queued");
	for (const it of queue) {
		if (running >= CONCURRENCY) break;
		startItem(it);
	}
}

async function startItem(it) {
	running++;
	it.status = "running";
	it.params = snapshotParams();
	// 缩略图：upload 用本地 File；path 走服务端小图；url 直接用远程地址（浏览器原生加载，可能因防盗链失败，失败显示占位）
	if (!it.thumbUrl && it.mode === "upload") it.thumbUrl = URL.createObjectURL(it.file);
	if (!it.thumbUrl && it.mode === "path") it.thumbUrl = `/api/thumb?path=${encodeURIComponent(it.absPath)}`;
	if (!it.thumbUrl && it.mode === "url") it.thumbUrl = it.url;
	if (it.row) paintRow(it.row, it);
	updateSummary();

	try {
		let res;
		if (it.mode === "path" || it.mode === "url") {
			const endpoint = it.mode === "path" ? "/api/compress-path" : "/api/compress-url";
			const body = it.mode === "path" ? { path: it.absPath, relPath: it.relPath } : { url: it.url };
			res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...body, ...it.params }),
			});
		} else {
			// 拖拽模式：水印/元数据等对象参数放 query 的 watermark JSON；文本参数逐个传
			const q = new URLSearchParams({
				name: it.file.name,
				relPath: it.relPath,
				quality: it.params.quality,
				format: it.params.format,
			});
			if (it.params.resize) q.set("resize", it.params.resize);
			if (it.params.crop) q.set("crop", it.params.crop);
			if (it.params.rotate) q.set("rotate", it.params.rotate);
			if (it.params.lossless) q.set("lossless", "1");
			if (it.params.keepMeta) q.set("keepMeta", "1");
			if (it.params.watermark) q.set("watermark", JSON.stringify(it.params.watermark));
			res = await fetch(`/api/compress?${q}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: it.file,
			});
		}
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
		it.result = data;
		it.size = data.beforeBytes; // 以服务端实测为准（URL 模式为下载后体积）
		it.status = "done";
	} catch (err) {
		it.error = err.message;
		it.status = "failed";
	} finally {
		running--;
		if (it.row) paintRow(it.row, it);
		updateSummary();
		pump();
	}
}

/* ---------------- ZIP / 清空 ---------------- */
els.zipBtn.addEventListener("click", async () => {
	const ids = items.filter((i) => i.status === "done").map((i) => i.result.id);
	if (ids.length === 0) return;
	els.zipBtn.disabled = true;
	els.zipBtn.textContent = "打包中…";
	try {
		const res = await fetch("/api/zip", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
		const blob = await res.blob();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `compressed-${stamp()}.zip`;
		a.click();
		URL.revokeObjectURL(a.href);
	} catch (err) {
		alert(`打包失败：${err.message}`);
	} finally {
		els.zipBtn.disabled = false;
		els.zipBtn.textContent = "打包下载 ZIP";
	}
});

els.clearBtn.addEventListener("click", async () => {
	for (const it of items) if (it.thumbUrl && it.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(it.thumbUrl);
	items.length = 0;
	els.list.replaceChildren();
	els.resultArea.hidden = true;
	await fetch("/api/clear", { method: "POST" }).catch(() => {});
});

/* ---------------- 小工具 ---------------- */
function modeLabel(mode) {
	if (mode === "path") return " · 本地直读";
	if (mode === "url") return " · 远程下载";
	return " · 拖拽上传";
}
function fmt(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}
function extOf(p) {
	const m = /\.([a-z0-9]+)$/i.exec(p);
	return m ? m[1] : "";
}
function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
