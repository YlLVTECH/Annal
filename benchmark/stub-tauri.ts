// 基准页专用的 Tauri 内部对象桩：必须在任何 src 模块之前导入。
// 基准运行在纯浏览器（无 Tauri WebView）环境，convertFileSrc 在渲染本地图片时被调用。
const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (filePath: string) => `asset://localhost/${filePath}`,
  invoke: () => Promise.reject(new Error("bench: invoke 不可用")),
  transformCallback: () => 0,
  unregisterCallback: () => {},
};
export {};
