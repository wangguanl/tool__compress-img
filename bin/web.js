#!/usr/bin/env node
import { exec } from "node:child_process";
import { startServer } from "../lib/server.js";

/* 参数解析：--port <n> --host <ip> --max-mb <n> --no-open --no-pick */
const opts = { port: 7788, host: "127.0.0.1", maxMB: 100, open: true, allowPick: true };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--port") opts.port = Number(process.argv[++i]);
	else if (a === "--host") opts.host = process.argv[++i];
	else if (a === "--max-mb") opts.maxMB = Number(process.argv[++i]);
	else if (a === "--no-open") opts.open = false;
	else if (a === "--no-pick") opts.allowPick = false;
	else if (a === "--help" || a === "-h") {
		console.log(`compress-img web — 本地图片压缩界面

用法
  node bin/web.js [选项]

选项
  --port <端口>      起始端口（占用时自动 +1 顺延），默认 7788
  --host <地址>      监听地址，默认 127.0.0.1（仅本机）
  --max-mb <数字>    单文件上限 MB，默认 100（拖拽上传模式）
  --no-open          不自动打开浏览器
  --no-pick          禁用系统选择框（只允许拖拽上传）
  -h, --help         显示帮助`);
		process.exit(0);
	}
}

const { port } = await startServer(opts);
const url = `http://${opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host}:${port}`;

console.log(`
  ┌─────────────────────────────────────────┐
  │   图片压缩 · 本地 Web 界面已启动          │
  │                                         │
  │   地址  ${url.padEnd(30)}│
  │   提示  图片仅在本机处理，不上传云端      │
  │   退出  Ctrl + C                        │
  └─────────────────────────────────────────┘
`);

if (opts.open) {
	const cmd =
		process.platform === "darwin" ? `open ${url}` : process.platform === "win32" ? `start "" ${url}` : `xdg-open ${url}`;
	exec(cmd, () => {}); // 失败静默，地址已在横幅打印
}
