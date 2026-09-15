import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 系统原生选择对话框（零依赖）
 *
 * macOS：osascript（AppleScript choose file / choose folder）
 * Windows：PowerShell System.Windows.Forms.OpenFileDialog / FolderBrowserDialog
 * Linux：zenity（无 zenity 时抛错，前端降级提示用拖拽）
 *
 * 返回 string[] 绝对路径；用户取消返回 []
 */

function run(cmd, args) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
			if (err) {
				// 用户取消时 osascript 退出码 1 且 stderr 含 "User canceled"
				if (/User canceled|canceled/i.test(stderr || "")) return resolve([]);
				reject(new Error(stderr || err.message));
				return;
			}
			resolve(stdout);
		});
	});
}

/** @returns {Promise<string[]>} 选中的文件绝对路径 */
export async function pickFiles({ multiple = true } = {}) {
	if (process.platform === "darwin") {
		const script = `
tell application "System Events"
	activate
end tell
set theFiles to choose file of type {"public.jpeg", "public.png", "public.webp", "public.avif", "public.tiff", "public.image"} with prompt "选择要压缩的图片"${multiple ? " with multiple selections allowed" : ""}
set output to ""
repeat with f in theFiles
	set output to output & POSIX path of f & linefeed
end repeat
return output`;
		const out = await run("osascript", ["-e", script]);
		return out.split("\n").filter(Boolean);
	}

	if (process.platform === "win32") {
		const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Filter = '图片|*.jpg;*.jpeg;*.png;*.webp;*.avif;*.tif;*.tiff;*.gif|所有文件|*.*'
$dlg.Multiselect = ${multiple ? "$true" : "$false"}
if ($dlg.ShowDialog() -eq 'OK') { $dlg.FileNames -join [char]10 } else { '' }`;
		const out = await run("powershell", ["-NoProfile", "-STA", "-Command", ps]);
		return out.split("\n").filter(Boolean).map((p) => p.trim()).filter(Boolean);
	}

	// Linux：zenity
	const args = ["--file-selection", "--file-filter=图片 | *.jpg *.jpeg *.png *.webp *.avif *.tif *.tiff *.gif"];
	if (multiple) args.push("--multiple", "--separator", "\n");
	const out = await run("zenity", args);
	return out.split("\n").filter(Boolean);
}

/** @returns {Promise<string[]>} 选中的目录绝对路径 */
export async function pickFolder() {
	if (process.platform === "darwin") {
		const script = `
tell application "System Events"
	activate
end tell
set theFolder to choose folder with prompt "选择要压缩的图片文件夹"
return POSIX path of theFolder`;
		const out = await run("osascript", ["-e", script]);
		return out.split("\n").filter(Boolean);
	}

	if (process.platform === "win32") {
		const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
if ($dlg.ShowDialog() -eq 'OK') { $dlg.SelectedPath } else { '' }`;
		const out = await run("powershell", ["-NoProfile", "-STA", "-Command", ps]);
		return out.trim() ? [out.trim()] : [];
	}

	const out = await run("zenity", ["--file-selection", "--directory"]);
	return out.split("\n").filter(Boolean);
}

/** 递归扫描目录下的图片，返回 [{absPath, relPath}] */
export function scanDirImages(dir) {
	const out = [];
	const walk = (d, rel) => {
		let names;
		try {
			names = fs.readdirSync(d);
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue; // 跳过 .DS_Store / .git 等
			const full = path.join(d, name);
			const relPath = rel ? `${rel}/${name}` : name;
			let st;
			try {
				st = fs.statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full, relPath);
			else if (/\.(jpe?g|png|webp|avif|tiff?|gif)$/i.test(name)) out.push({ absPath: full, relPath, size: st.size });
		}
	};
	walk(dir, "");
	return out;
}
