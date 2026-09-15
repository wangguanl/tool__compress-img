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

const IMAGE_RE = /\.(jpe?g|png|webp|avif|tiff?|gif)$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const items = []; // { key, mode: 'path'|'upload'|'url', absPath?, file?, url?, size, relPath, status, result?, error?, params?, row?, thumbUrl? }
let keySeq = 0;
let running = 0;
const CONCURRENCY = 3;
let pickAvailable = true;

/* ---------------- 参数 ---------------- */
function snapshotParams() {
	return { quality: Number(els.quality.value), format: els.format.value };
}

els.quality.addEventListener("input", () => (els.qualityVal.textContent = els.quality.value));

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
	const thumb = it.thumbUrl
		? `<img class="thumb" src="${it.thumbUrl}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-placeholder',textContent:'✕'}))" />`
		: `<div class="thumb-placeholder">${extOf(it.relPath) || "?"}</div>`;

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
	if (status === "done" && result) subParts.push(`q${params.quality} · ${result.format}`);
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
	}
});

/* ---------------- 压缩队列 ---------------- */
els.startBtn.addEventListener("click", pump);

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
		if (it.mode === "path") {
			res = await fetch("/api/compress-path", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: it.absPath, relPath: it.relPath, ...it.params }),
			});
		} else if (it.mode === "url") {
			res = await fetch("/api/compress-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: it.url, ...it.params }),
			});
		} else {
			const q = new URLSearchParams({
				name: it.file.name,
				relPath: it.relPath,
				quality: it.params.quality,
				format: it.params.format,
			});
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
